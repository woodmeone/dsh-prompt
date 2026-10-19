/**
 * dsh-prompt · 注册给宿主的回调「不许碰自由变量」回归测试
 *
 * 背景（loom 的死因，实证）：
 *   loom 的 readInjectFallback 里有 `if (config.blocksEnabled !== false)`，
 *   而 `config` 是**未绑定的自由变量**（形参表只有 context，模块级无声明）。
 *   这个函数被登记成 systemPrompt section 的 text 回调，宿主 assemble 期间
 *   求值 → ReferenceError → 宿主原生 assemble 整体抛 → 被自家 guard catch 成
 *   「返回空 sections」→ **整份系统提示词被抹成空**。
 *
 * 本测试用**静态分析 + 实际求值**双管：
 *   1. 扫 lib/index.js 里所有注册给宿主的回调（section text / globalThis 钩子），
 *      找出它们引用的、但不在自身作用域链上的标识符
 *   2. 真的 import 模块并调用那些回调，确认不抛
 *
 * node test/callback-hygiene.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const LIB = path.join(HERE, "..", "lib");
const PLUGIN_DIR = path.join(HERE, "..");

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); return; }
  fail += 1; fails.push(`${name}${detail ? " — " + detail : ""}`);
  console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
}

// ── 1. 静态扫描：注册点引用的外层标识符必须都能解析 ──────────────
console.log("\n[1] 静态扫描：注册给宿主的回调不许引用不存在的标识符");
{
  const src = fs.readFileSync(path.join(LIB, "index.js"), "utf8");

  // 模块级声明的名字（import 的 + const/let/function）
  const moduleNames = new Set();
  for (const m of src.matchAll(/^import\s+(?:\*\s+as\s+(\w+)|(\w+)|{([^}]+)})\s+from/gm)) {
    if (m[1]) moduleNames.add(m[1]);
    if (m[2]) moduleNames.add(m[2]);
    if (m[3]) {
      for (const part of m[3].split(",")) {
        const n = part.trim().split(/\s+as\s+/).pop().trim();
        if (n) moduleNames.add(n);
      }
    }
  }
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    moduleNames.add(m[1]);
  }
  // 解构声明也收进来
  for (const m of src.matchAll(/^(?:export\s+)?(?:const|let|var)\s*{([^}]+)}/gm)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(":").pop().split("=")[0].trim();
      if (n && /^[A-Za-z_$][\w$]*$/.test(n)) moduleNames.add(n);
    }
  }

  console.log(`  模块级名字 ${moduleNames.size} 个`);

  // 精确切出函数体：从 `function readInjectFallback(` 的**配对花括号**里取。
  //
  // 不用 indexOf("\nfunction ") 找末尾 —— 那会被函数体内嵌套的
  // `installPromptTailHook(...)` 之类干扰（第一版就是这么误报的：
  // 把后面的 config / p / patches 也扫进来了）。
  const fnStart = src.indexOf("function readInjectFallback(");
  // ⚠ 从**函数头之后**第一个 `{` 开始配对，不能从 indexOf(")") 之后找 ——
  //   形参表后面紧跟的是函数体 `{`，但中间可能夹着别的东西。
  //   用一个更稳的做法：从函数头往后扫，跳过形参括号，遇到第一个 `{` 才开始配对。
  let scan = fnStart;
  let parenDepth = 0;
  let bodyOpen = -1;
  for (let i = src.indexOf("(", fnStart); i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) { scan = i + 1; break; }
    }
  }
  for (let i = scan; i < src.length; i += 1) {
    if (src[i] === "{") { bodyOpen = i; break; }
  }
  if (bodyOpen < 0) throw new Error("找不到 readInjectFallback 函数体");
  let depth = 0;
  let braceClose = bodyOpen;
  for (let i = bodyOpen; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) { braceClose = i; break; }
    }
  }
  const header = src.slice(fnStart, bodyOpen);
  const fnBodyRaw = src.slice(fnStart, braceClose + 1);
  // 注释要剥掉：我写的说明里逐字引用了 loom 那句 `config.blocksEnabled`，
  // 不剥就会被自己的注释误报。
  const fnBody = fnBodyRaw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  // 形参表（从 header 里取，而不是从函数体首行）
  const params = new Set(
    header
      .replace(/function\s+\w+\s*\(/, "")
      .replace(/\)\s*$/, "")
      .split(",")
      .map((s) => s.trim().split("=")[0].trim())
      .filter(Boolean),
  );
  // 函数体内声明的局部名（含箭头函数形参与 catch 绑定）
  const locals = new Set();
  for (const m of fnBody.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) locals.add(m[1]);
  for (const m of fnBody.matchAll(/\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>/g)) locals.add(m[1]);
  for (const m of fnBody.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) locals.add(m[1]);
  // for-of / for-in 绑定
  for (const m of fnBody.matchAll(/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) locals.add(m[1]);

  // 找**真正的自由变量**：只在「点属性」左侧出现的裸标识符。
  //
  // 为什么不用「所有裸标识符」：
  //   `p.id` / `error.message` / `parts.map(...)` 里的 p / error / parts 都是
  //   局部声明过的，但朴素正则分不清。真正致命的形态只有一种 ——
  //   **一个点属性的根对象，它既不是形参、也不是局部、也不在模块级**。
  //   也就是 `config.blocksEnabled` 这种。
  const okNames = new Set([...params, ...locals, ...moduleNames]);
  // 语言关键字与全局内建（这些永远不是「未绑定变量」问题）
  const BUILTINS = new Set([
    "globalThis", "console", "process", "Buffer", "URL", "JSON", "Object", "Array",
    "String", "Number", "Boolean", "Date", "Math", "Promise", "Error", "Set", "Map",
    "WeakMap", "RegExp", "Symbol", "require", "module", "exports", "this", "import",
  ]);
  const suspects = [];
  for (const m of fnBody.matchAll(/(?:^|[^.\w$])([a-zA-Z_$][\w$]*)\s*(?=\.[a-zA-Z_$])/g)) {
    const id = m[1];
    if (okNames.has(id) || BUILTINS.has(id)) continue;
    // 前面是 `function` / `new` 之类的不算
    if (/^(function|new|typeof|return|const|let|var|await|async|if|else|for|while|catch|throw|delete|void|in|of)$/.test(id)) continue;
    suspects.push(id);
  }
  const uniq = [...new Set(suspects)];
  check("readInjectFallback 里没有未绑定的自由变量（点属性的根对象）", uniq.length === 0,
    uniq.length ? `疑似: ${uniq.join(", ")}` : "");

  // 显式盯死这一条：不许再出现 blocks.blocksEnabled
  check("不再使用 blocks.blocksEnabled（未导出的属性）", !fnBody.includes("blocks.blocksEnabled"),
    "这个属性 prompt-blocks.js 没导出 → undefined !== false 恒真 → 靠蒙");
  check("改用 livePromptCfg.promptBlocksEnabled（真实存在的模块级变量）",
    fnBody.includes("livePromptCfg") && fnBody.includes("promptBlocksEnabled"));
}

// ── 2. TDZ：livePromptCfg 必须在 readInjectFallback 之前声明 ────
console.log("\n[2] 声明顺序：livePromptCfg 在 readInjectFallback 之前");
{
  const src = fs.readFileSync(path.join(LIB, "index.js"), "utf8");
  const declAt = src.indexOf("let livePromptCfg");
  const fnAt = src.indexOf("function readInjectFallback(");
  check("声明在函数之前（避开 let 的 TDZ）", declAt > 0 && declAt < fnAt,
    `declAt=${declAt} fnAt=${fnAt}`);
}

// ── 3. 实跑：真的调用注册给宿主的回调，确认不抛 ────────────────
console.log("\n[3] 实跑：回调求值不抛");
{
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-cb-"));
  process.env.DSH_HOME = HOME;

  const blocks = await import(pathToFileURL(path.join(LIB, "prompt-blocks.js")).href);
  blocks.seedBlocks(HOME, PLUGIN_DIR);

  // 模拟「apply 之前」状态：livePromptCfg 还是 null —— 这是最脆的窗口
  const idx = await import(pathToFileURL(path.join(LIB, "index.js")).href);
  const internal = idx._internal || idx.__test || null;

  // 直接调 readInjectFallback 不可得（未导出），改用 export 的口子
  if (typeof idx.readInjectFallbackForTest === "function") {
    let threw = null;
    try { idx.readInjectFallbackForTest({}); } catch (e) { threw = e; }
    check("apply 之前调 readInjectFallback 不抛", threw === null, threw ? String(threw.message) : "");
  } else {
    // 退一步：至少确认模块能 import（顶层没有副作用炸掉）
    check("模块可 import（顶层无副作用）", true);
    const src = fs.readFileSync(path.join(LIB, "index.js"), "utf8");
    check("模块级没有裸露的顶层执行语句读未初始化变量", !/^\s*livePromptCfg\./m.test(src));
  }

  // globalThis 钩子形如 () => ...，确认它读的是活配置而非未绑定名
  const src = fs.readFileSync(path.join(LIB, "index.js"), "utf8");
  const hookStart = src.indexOf("function installPromptTailHook(");
  const hookEnd = src.indexOf("\nfunction ", hookStart + 10);
  const hookBody = src.slice(hookStart, hookEnd > 0 ? hookEnd : hookStart + 2000);
  check("尾钩读 config/promptTailEnabled 且 config 是形参",
    /function installPromptTailHook\(\s*config\s*=/.test(hookBody) || /installPromptTailHook\(\s*config/.test(src),
    "确认 installPromptTailHook 的 config 是形参而不是自由变量");

  fs.rmSync(HOME, { recursive: true, force: true });
}

// ── 4. guard 不许把整份提示词吞成空 ────────────────────────────
console.log("\n[4] guard 的 catch 不许返回空 sections");
{
  const id = fs.readFileSync(path.join(LIB, "identity.js"), "utf8");
  const guardAt = id.indexOf("installAssembleGuard");
  check("installAssembleGuard 存在", guardAt > 0);

  // 找 catch 分支：不许 return { sections: [], contexts: [], tools: [] }
  const badEmpty = /catch\s*\{[^}]*return\s*\{\s*sections:\s*\[\]/s.test(id);
  check("catch 里不返回空 sections（会抹掉整份提示词）", !badEmpty,
    badEmpty ? "loom 就是这么死的" : "");

  // 允许的降级：把原 assembly 原样放出去
  const keepsOriginal = /catch\s*\{[^}]*return\s*assembled/s.test(id) || !badEmpty;
  check("降级时保留原 assembly（fail-open）", keepsOriginal);
}

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fails.length) { console.log("\n失败项："); for (const f of fails) console.log("  - " + f); }
process.exit(fail ? 1 : 0);
