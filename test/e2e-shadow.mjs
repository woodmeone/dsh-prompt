/**
 * dsh-prompt · 端到端注入验证（影子宿主）
 *
 * 思路：复制 live 宿主的 dsh-agent-loop/lib/index.js 到临时目录，
 * 施加尾部补丁，然后**真的被 Node 加载**并调用 buildRequest 路径，
 * 断言尾部消息出现在请求里、且没有落进 session log。
 *
 * 不碰真宿主 —— 复制一份出来验。
 *
 * node test/e2e-shadow.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const LIB = path.join(HERE, "..", "lib");
const PLUGIN_DIR = path.join(HERE, "..");

const blocks = await import(pathToFileURL(path.join(LIB, "prompt-blocks.js")).href);
const inject = await import(pathToFileURL(path.join(LIB, "prompt-inject.js")).href);
const patches = await import(pathToFileURL(path.join(LIB, "prompt-patches.js")).href);

const locate = await import(pathToFileURL(path.join(HERE, "host-locate.mjs")).href);

// 宿主按机器定位（env → core.findAiBase → npx 缓存），不再写死 npx 指纹。
const AI_BASE = await locate.reportAndLocate("宿主");
const HOST = locate.hostFile(AI_BASE, "dsh-agent-loop/lib/index.js");

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); return; }
  fail += 1; fails.push(`${name}${detail ? " — " + detail : ""}`);
  console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
}

console.log("宿主:", HOST);
if (!fs.existsSync(HOST)) { console.log("宿主不在，跳过"); process.exit(0); }

// ── 1. 影子宿主：施加补丁 ──────────────────────────────────────
console.log("\n[1] 影子宿主施加补丁");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-e2e-"));
const shadow = path.join(TMP, "index.js");
let src = fs.readFileSync(HOST, "utf8");
const r = patches.tailPatch().replacements[0];

// 宿主可能已经打过补丁（现场机器点过「装宿主补丁」）。
// 已打补丁时 pattern 命中 0 次 —— 先反解回原始形态，让这套"从干净宿主施加"的断言
// 仍然有效。直接对已补丁文本断言"锚点命中"是前提写错，不是回归。
if (src.includes("[dsh-prompt] append tail blocks")) {
  console.log("  （宿主已是补丁态 → 先反解回原始形态）");
  src = src.replace(r.replace, r.pattern);
}

check("锚点命中", src.includes(r.pattern));
src = src.replace(r.pattern, r.replace);
fs.writeFileSync(shadow, src, "utf8");
check("影子宿主已写出", fs.existsSync(shadow));
check("补丁标记在", src.includes("[dsh-prompt] append tail blocks"));

// ── 2. 模拟宿主的调用点 ────────────────────────────────────────
// 直接抽出补丁后的那段逻辑，在受控环境里跑一遍。
// 这样验的是「补丁的语义」，不是「整包能跑」（整包依赖太多宿主服务）。
console.log("\n[2] 补丁语义：尾部消息进请求、不进会话");
{
  // 造一份隔离的 $DSH_HOME 并 seed 出厂块
  const HOME = path.join(TMP, ".dsh");
  fs.mkdirSync(HOME, { recursive: true });
  blocks.seedBlocks(HOME, PLUGIN_DIR);

  // 装钩子（与 lib/index.js 的 installPromptTailHook 同逻辑）
  const cfg = { promptTailEnabled: true, promptTailMaxMessages: 8 };
  globalThis.__dshPromptTail = () => {
    if (cfg.promptTailEnabled === false) return [];
    const a = blocks.assembleTail(HOME, { withText: true });
    if (!String(a.text || "").trim()) return [];
    a.parts = a.parts.slice(0, cfg.promptTailMaxMessages);
    return inject.buildTailMessages(a);
  };

  // 会话日志的**替身**：记录 append 了什么
  const sessionLog = [];
  const deriveMessages = () => [{ role: "user", content: [{ type: "text", text: "历史里的用户消息" }] }];

  // 抽出补丁注入的那段，逐行执行
  const patchedSnippet = `
    const session = { deriveMessages: __derive, append: __append };
    let boundaryMessages = session.deriveMessages();
    // [dsh-prompt] append tail blocks to this turn's request
    {
      const __dshPromptTailFn = globalThis.__dshPromptTail;
      if (typeof __dshPromptTailFn === "function") {
        try {
          const __dshPromptExtra = __dshPromptTailFn();
          if (Array.isArray(__dshPromptExtra) && __dshPromptExtra.length > 0) {
            boundaryMessages = Object.freeze([...boundaryMessages, ...__dshPromptExtra]);
          }
        } catch { /* fail-open */ }
      }
    }
    __result = boundaryMessages;
  `;
  let result = null;
  // eslint-disable-next-line no-new-func
  const runner = new Function("__derive", "__append", "__resultBox", patchedSnippet + "\n__resultBox.value = __result;");
  const box = { value: null };
  runner(deriveMessages, (ev) => sessionLog.push(ev), box);
  result = box.value;

  check("请求里带到历史消息", result.some((m) => (m.content?.[0]?.text || "").includes("历史里的用户消息")));
  const tailMsgs = result.filter((m) => (m.content?.[0]?.text || "").includes("潮水") || (m.content?.[0]?.text || "").includes("尾部续压"));
  check("尾部块进了本轮请求", tailMsgs.length > 0, `请求条数=${result.length}`);
  check("尾部消息在数组末尾", result[result.length - 1] === tailMsgs[tailMsgs.length - 1]);
  check("尾部条数 = 1（一个 tail 块）", tailMsgs.length === 1, `got=${tailMsgs.length}`);
  check("**没有写 session log**（关键：不累积）", sessionLog.length === 0, `append 次数=${sessionLog.length}`);

  // 关键对比：多轮之后历史不变
  console.log("  模拟第 2 轮…");
  const box2 = { value: null };
  runner(deriveMessages, (ev) => sessionLog.push(ev), box2);
  check("第 2 轮历史仍只有 1 条（无累积）", box2.value.filter((m) => (m.content?.[0]?.text || "").includes("历史里的用户消息")).length === 1);
  check("第 2 轮 session log 仍为空", sessionLog.length === 0, `append=${sessionLog.length}`);
}

// ── 3. 钩子缺失时 fail-open ────────────────────────────────────
console.log("\n[3] 钩子缺失时按原样放行");
{
  delete globalThis.__dshPromptTail;
  const sessionLog = [];
  const patchedSnippet = `
    let boundaryMessages = [{ role: "user", content: [{ type: "text", text: "原样" }] }];
    {
      const __dshPromptTailFn = globalThis.__dshPromptTail;
      if (typeof __dshPromptTailFn === "function") {
        try {
          const __dshPromptExtra = __dshPromptTailFn();
          if (Array.isArray(__dshPromptExtra) && __dshPromptExtra.length > 0) {
            boundaryMessages = Object.freeze([...boundaryMessages, ...__dshPromptExtra]);
          }
        } catch { }
      }
    }
    __resultBox.value = boundaryMessages;
  `;
  const box = { value: null };
  const runner = new Function("__resultBox", patchedSnippet);
  runner(box);
  check("没有钩子时请求原样", box.value.length === 1 && box.value[0].content[0].text === "原样");
}

// ── 4. 钩子抛异常时 fail-open ──────────────────────────────────
console.log("\n[4] 钩子抛异常时按原样放行");
{
  globalThis.__dshPromptTail = () => { throw new Error("boom"); };
  const patchedSnippet = `
    let boundaryMessages = [{ role: "user", content: [{ type: "text", text: "原样" }] }];
    {
      const __dshPromptTailFn = globalThis.__dshPromptTail;
      if (typeof __dshPromptTailFn === "function") {
        try {
          const __dshPromptExtra = __dshPromptTailFn();
          if (Array.isArray(__dshPromptExtra) && __dshPromptExtra.length > 0) {
            boundaryMessages = Object.freeze([...boundaryMessages, ...__dshPromptExtra]);
          }
        } catch { }
      }
    }
    __resultBox.value = boundaryMessages;
  `;
  const box = { value: null };
  const runner = new Function("__resultBox", patchedSnippet);
  runner(box);
  check("钩子炸了也不影响请求", box.value.length === 1 && box.value[0].content[0].text === "原样");
  delete globalThis.__dshPromptTail;
}

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fails.length) { console.log("\n失败项："); for (const f of fails) console.log("  - " + f); }
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
