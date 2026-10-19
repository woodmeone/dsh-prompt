/**
 * dsh-prompt · 真 bug 回归测试
 *
 * 钉死本轮实测抓到的两个 P0。两条都用「反向验证」自证：
 * 把 bug 装回去必须报警，否则说明测试根本没盯着那个点。
 *
 * ── bug 1：describe() 未排序 ────────────────────────────────────
 *   现场：拖拽改了 order，装配顺序变了，**面板行序却纹丝不动**。
 *   病因：describe().blocks 直接吐 config 数组原序，而装配走 order 升序。
 *   修法：describe() 按 order 排，与装配同口径。
 *
 * ── bug 2：system-prompt 的 assemble() 被写成正则字面量 ─────────
 *   现场：发消息必炸 `Cannot read properties of undefined (reading 'contexts')`。
 *   病因：上一轮 loom 清理做 replace→pattern 反向替换时，把存成正则的
 *         pattern 原样写回源码，assemble() 的收尾代码塌成一行正则
 *         → 方法没有 return → 返回 undefined → 宿主读 .contexts 抛。
 *   修法：还原成真正的代码；并加一道守卫，让源码里再出现这种形态就报警。
 *
 * node test/regression-real.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const LIB = path.join(HERE, "..", "lib");
const PLUGIN_DIR = path.join(HERE, "..");

const blocks = await import(pathToFileURL(path.join(LIB, "prompt-blocks.js")).href);
const edit = await import(pathToFileURL(path.join(LIB, "prompt-edit.js")).href);

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); return; }
  fail += 1; fails.push(`${name}${detail ? " — " + detail : ""}`);
  console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-reg-"));
const HOME = path.join(TMP, ".dsh");
fs.mkdirSync(HOME, { recursive: true });

// ═══ bug 1：describe() 必须按 order 排 ═══════════════════════════
console.log("\n[bug 1] describe() 的 blocks 必须与装配同序");
{
  blocks.seedBlocks(HOME, PLUGIN_DIR, { force: true });

  const FACTORY = ["core-persona", "core-style", "core-contract", "core-jailbreak", "core-armor"];
  const MOVED = ["core-armor", "core-persona", "core-style", "core-contract", "core-jailbreak"];

  // reorderBlocksImpl(dshHome, slot, ids) —— 三个位置参数
  const r = edit.reorderBlocks(HOME, "top", MOVED);
  check("reorder 成功", r && r.ok !== false, JSON.stringify(r).slice(0, 120));

  const d = blocks.describe(HOME);
  // 装配只看 enabled；describe 列出全部（含关掉的 core-routing）。
  // 所以比的是「enabled 且挂 top」的子集 —— 这才是用户能在面板上看见的顺序。
  const topOrder = d.blocks.filter((b) => b.slots.includes("top") && b.enabled).map((b) => b.id);
  const asmOrder = d.topParts.map((p) => p.id);
  const listedOrder = d.blocks.filter((b) => b.slots.includes("top")).map((b) => b.id);

  console.log("    describe(全部):", JSON.stringify(listedOrder));
  console.log("    describe(启用):", JSON.stringify(topOrder));
  console.log("    装配顺序      :", JSON.stringify(asmOrder));
  check("describe 的启用 top 块顺序 == 装配顺序", JSON.stringify(topOrder) === JSON.stringify(asmOrder),
    `describe=${JSON.stringify(topOrder)}, asm=${JSON.stringify(asmOrder)}`);
  check("首位是 core-armor（拖过去的那块）", topOrder[0] === "core-armor", topOrder[0]);
  check("describe 按 order 升序", (() => {
    const seq = d.blocks.filter((b) => b.slots.includes("top")).map((b) => b.order);
    return seq.every((n, i) => i === 0 || seq[i - 1] <= n);
  })(), JSON.stringify(d.blocks.map((b) => b.order)));

  // 反向验证：config 里的数组原序应当仍是「旧的」顺序 —— 证明排序真的在起作用
  const cfgPath = blocks.configPath(HOME);
  check("config.json 落盘了", fs.existsSync(cfgPath), cfgPath);
  const rawIds = JSON.parse(fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, ""))
    .blocks.filter((b) => b.slots.includes("top") && b.enabled !== false).map((b) => b.id);
  console.log("    config 原序   :", JSON.stringify(rawIds));
  check("**反向验证**：config 原序 ≠ 装配序（否则这条测不出东西）",
    JSON.stringify(rawIds) !== JSON.stringify(asmOrder), "raw == asm，排序未生效");

  // 复位
  edit.reorderBlocks(HOME, "top", FACTORY);
  const d2 = blocks.describe(HOME);
  check("复位后首位回到 core-persona", d2.blocks.filter((b) => b.slots.includes("top"))[0].id === "core-persona");
}

// ═══ bug 2：宿主源码里不许出现「正则字面量顶替代码」 ═══════════════
console.log("\n[bug 2] 宿主源码：assemble() 不许塌成正则字面量");
{
  const n = "C:/Users/WoodMe/AppData/Local/npm-cache/_npx/b86ed90107c62dab/node_modules/@deepseek-ai";
  const sp = path.join(n.replace(/\//g, path.sep), "dsh-system-prompt", "lib", "index.js");

  if (!fs.existsSync(sp)) {
    console.log("  宿主不在，跳过");
  } else {
    const text = fs.readFileSync(sp, "utf8");

    // 找「独占一行、以 / 开头 / 结尾、含大量转义、长度 > 200」的行。
    //
    // ⚠ 排除条件必须只用「行首」形态判定：损坏行自己开头就带 `const transformed`，
    //   若拿前 40 字符去匹配 \b(const|let|var)\b，会把**损坏行本身**误排除掉
    //   —— 扫描器于是永远报 0，看着"干净"实则瞎了。这个坑本轮踩过。
    const isLegitRegexAssign = (line) => /^\s*(const|let|var)\s+\w+\s*=\s*\//.test(line);
    const findCorrupt = (textOfFile) => {
      const out = [];
      const ls = textOfFile.split("\n");
      for (let i = 0; i < ls.length; i++) {
        const t = ls[i].trim();
        if (t.length < 200) continue;
        if (!t.startsWith("/") || !t.endsWith("/")) continue;
        const escapes = (t.match(/\\[.()\[\]?{}n|+*\/]/g) || []).length;
        if (escapes < 3) continue;
        if (isLegitRegexAssign(ls[i])) continue;
        out.push({ line: i + 1, len: t.length });
      }
      return out;
    };

    const corrupt = findCorrupt(text);
    check("**源码里没有正则字面量顶替代码**", corrupt.length === 0,
      corrupt.length ? `发现 ${corrupt.length} 处：` + corrupt.map((c) => c.line).join(",") : "");

    // assemble 必须真的有 return
    const hasWaterfall = text.includes("const transformed = await this.ctx.waterfall(");
    check("assemble() 里的 waterfall 调用在", hasWaterfall);
    check("assemble() 有 return transformed", /if \(completeSection === void 0 && !runtimeContextSuppressed\) return transformed;/.test(text));
    check("assemble() 返回里有 contexts 字段", /contexts: runtimeContextSuppressed \? \[\] : transformed\.contexts/.test(text));

    // 反向验证：把损坏形态塞进一份副本，扫描器必须报警。
    // 用真实的现场样本（本轮从宿主上抓到的原始损坏行，479 字符）。
    const REAL_CORRUPT = String.raw`/[ \t]*const transformed = await this\.ctx\.waterfall\(scopeTarget\(this, scope\), "system-prompt\/assemble", assembly, context, \(\) => Promise\.resolve\(assembly\)\);\n[ \t]*if \(completeSection === void 0 && !runtimeContextSuppressed\) return transformed;\n[ \t]*return \{\n[ \t]*\.\.\.transformed,\n[ \t]*sections: completeSection === void 0 \? transformed\.sections : \[completeSection\],\n[ \t]*contexts: runtimeContextSuppressed \? \[\] : transformed\.contexts\n[ \t]*\};/`;
    const decoyText = ["const a = 1;", "function x() {", REAL_CORRUPT, "}"].join("\n");
    const decoyCorrupt = findCorrupt(decoyText);
    check("**反向验证**：扫描器能抓到损坏形态", decoyCorrupt.length === 1,
      `样本长度 ${REAL_CORRUPT.length}, got ${decoyCorrupt.length}`);

    // 再验一条：合法的正则赋值不该被误报
    const legitText = ["const RE = /\\\\s*ab+c\\\\s*/g;", "const x = s.replace(/[ \\\\t]*a/g, 'b');"].join("\n");
    check("合法的正则赋值不误报", findCorrupt(legitText).length === 0,
      JSON.stringify(findCorrupt(legitText)));
  }
}

// ═══ 附带：assemble 守卫对 undefined 输入的处理 ═════════════════
console.log("\n[附带] rewritePromptAssembly 对坏输入不产生部分对象");
{
  const identity = await import(pathToFileURL(path.join(LIB, "identity.js")).href);
  for (const [label, input] of [["undefined", undefined], ["null", null], ["非对象", 42], ["缺 sections", { contexts: [] }]]) {
    let out, threw = false;
    try { out = identity.rewritePromptAssembly(input, ""); } catch { threw = true; }
    check(`输入 ${label} 时不抛且不造半成品`, !threw && (out === input || (out && Array.isArray(out.sections) && Array.isArray(out.contexts))),
      threw ? "抛了" : JSON.stringify(out)?.slice(0, 60));
  }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fails.length) { console.log("\n失败项："); for (const f of fails) console.log("  - " + f); }
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
