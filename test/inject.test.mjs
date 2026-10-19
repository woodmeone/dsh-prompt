/**
 * dsh-prompt · 注入链路集成自测
 *
 * 用隔离的 $DSH_HOME，验证「块 → 装配 → 回调 → 宿主补丁读到的消息」整条链。
 * node test/inject.test.mjs
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
const inject = await import(pathToFileURL(path.join(LIB, "prompt-inject.js")).href);

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); return; }
  fail += 1; fails.push(`${name}${detail ? " — " + detail : ""}`);
  console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
}
function eq(name, got, want) {
  check(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-inject-"));
console.log("临时 DSH_HOME:", HOME);
blocks.seedBlocks(HOME, PLUGIN_DIR);

// 模拟 prompt-index 里的 readTop / readTail（同一逻辑，不依赖 webServer）
const CONFIG = { enabled: true, topEnabled: true, tailEnabled: true, tailMaxMessages: 8 };

function readTop() {
  if (CONFIG.enabled === false || CONFIG.topEnabled === false) return { text: "", parts: [] };
  blocks.seedBlocks(HOME, PLUGIN_DIR);
  const a = blocks.assembleTop(HOME);
  return { text: a.text, parts: a.parts };
}
function readTail() {
  if (CONFIG.enabled === false || CONFIG.tailEnabled === false) return [];
  const a = blocks.assembleTail(HOME, { withText: true });
  if (!String(a.text || "").trim()) return [];
  a.parts = a.parts.slice(0, CONFIG.tailMaxMessages);
  return inject.buildTailMessages(a);
}

// ── 1. 顶部通路 ────────────────────────────────────────────────
console.log("\n[1] 顶部通路");
{
  const t = readTop();
  check("顶部有内容", t.text.length > 0, `bytes=${t.text.length}`);
  check("含人格块标记", t.text.includes("码头上一只海鸥"));
  check("默认关闭的任务路由不在顶部", !t.parts.some((p) => p.id === "core-routing"));

  edit.updateBlockMeta(HOME, "core-routing", { enabled: true });
  const t2 = readTop();
  check("打开任务路由后进顶部", t2.parts.some((p) => p.id === "core-routing"));
  check("顶部变长", t2.text.length > t.text.length, `${t.text.length} → ${t2.text.length}`);
  edit.updateBlockMeta(HOME, "core-routing", { enabled: false });
  eq("关回后字节还原", readTop().text.length, t.text.length);
}

// ── 2. 尾部通路：消息形状正确 ─────────────────────────────────
console.log("\n[2] 尾部通路：消息形状");
{
  const msgs = readTail();
  check("尾部产出消息数组", Array.isArray(msgs) && msgs.length > 0, `len=${msgs.length}`);
  for (const m of msgs) {
    check(`消息 role 合法（${m.role}）`, ["system", "user", "assistant"].includes(m.role));
    check("content 是文本块数组", Array.isArray(m.content) && m.content[0]?.type === "text");
    check("请求期消息不带 id", m.id === undefined);
    check("请求期消息不带 source（避免与持久 Message 混淆）", m.source === undefined);
  }
  const joined = msgs.map((m) => m.content[0].text).join("\n");
  check("尾部含续压内容", joined.includes("尾部续压") || joined.includes("潮水"), joined.slice(0, 80));
}

// ── 3. 块级 role 决定消息 role ────────────────────────────────
console.log("\n[3] 块级 role 决定消息 role");
{
  edit.updateBlockMeta(HOME, "core-tail", { role: "assistant" });
  const msgs = readTail();
  check("改成 assistant 后消息 role 是 assistant", msgs.some((m) => m.role === "assistant"),
    msgs.map((m) => m.role).join(","));
  edit.updateBlockMeta(HOME, "core-tail", { role: "user" });
  const msgs2 = readTail();
  check("改回 user", msgs2.every((m) => m.role === "user"), msgs2.map((m) => m.role).join(","));
}

// ── 4. tailMaxMessages 上限 ───────────────────────────────────
console.log("\n[4] 尾部条数上限");
{
  for (let i = 0; i < 12; i += 1) {
    edit.addBlock(HOME, { id: `extra-${i}`, name: `e${i}`, content: `额外块 ${i}。`, slots: ["tail"], role: "user" });
  }
  CONFIG.tailMaxMessages = 3;
  const msgs = readTail();
  eq("上限 3 生效", msgs.length, 3);
  CONFIG.tailMaxMessages = 8;
  eq("上限 8 生效", readTail().length, 8);
  CONFIG.tailMaxMessages = 100;
  check("放宽后拿到全部", readTail().length >= 13, `len=${readTail().length}`);
  for (let i = 0; i < 12; i += 1) edit.removeBlock(HOME, `extra-${i}`);
  CONFIG.tailMaxMessages = 8;
}

// ── 5. 总开关 / 分位开关 ──────────────────────────────────────
console.log("\n[5] 开关矩阵");
{
  CONFIG.enabled = false;
  eq("总开关关掉：顶部空", readTop().text, "");
  eq("总开关关掉：尾部空", readTail().length, 0);
  CONFIG.enabled = true;

  CONFIG.topEnabled = false;
  eq("只关顶部：顶部空", readTop().text, "");
  check("只关顶部：尾部还在", readTail().length > 0);
  CONFIG.topEnabled = true;

  CONFIG.tailEnabled = false;
  check("只关尾部：顶部还在", readTop().text.length > 0);
  eq("只关尾部：尾部空", readTail().length, 0);
  CONFIG.tailEnabled = true;
}

// ── 6. 拖拽排序影响尾部消息顺序 ───────────────────────────────
console.log("\n[6] 排序影响装配顺序");
{
  edit.updateBlockMeta(HOME, "core-tail", { slots: ["tail"] });
  edit.addBlock(HOME, { id: "tail-a", content: "A 段。", slots: ["tail"], role: "user" });
  edit.addBlock(HOME, { id: "tail-b", content: "B 段。", slots: ["tail"], role: "user" });

  const before = blocks.assembleTail(HOME).parts.map((p) => p.id);
  const target = ["tail-b", "tail-a", ...before.filter((x) => x !== "tail-a" && x !== "tail-b")];
  const r = edit.reorderBlocks(HOME, "tail", target);
  check("reorder ok", r.ok === true, JSON.stringify(r));
  const after = blocks.assembleTail(HOME, { withText: true }).parts.map((p) => p.id);
  eq("尾部顺序按传入", after.join(","), target.join(","));

  // 消息顺序要跟着变
  const msgs = readTail();
  const texts = msgs.map((m) => m.content[0].text);
  const ai = texts.findIndex((t) => t.includes("A 段"));
  const bi = texts.findIndex((t) => t.includes("B 段"));
  check("B 段消息排在 A 段之前", bi >= 0 && ai >= 0 && bi < ai, `a=${ai} b=${bi}`);

  edit.removeBlock(HOME, "tail-a");
  edit.removeBlock(HOME, "tail-b");
}

// ── 7. 实时性：改块立即反映（不重启）─────────────────────────
console.log("\n[7] 实时性");
{
  edit.setBlockContent(HOME, "core-tail", "【实时标记 XZ】");
  const joined = readTail().map((m) => m.content[0].text).join("\n");
  check("改后立即读到新内容", joined.includes("【实时标记 XZ】"), joined.slice(0, 60));
  edit.revertBlock(HOME, "core-tail");
  const joined2 = readTail().map((m) => m.content[0].text).join("\n");
  check("撤销后立即回到出厂内容", !joined2.includes("【实时标记 XZ】"));
}

// ── 8. 空块不产生消息 ─────────────────────────────────────────
console.log("\n[8] 空块不产生消息");
{
  edit.updateBlockMeta(HOME, "core-tail", { slots: ["tail"] });
  edit.setBlockContent(HOME, "core-tail", "   ");
  eq("只有空块时尾部无消息", readTail().length, 0);
  edit.revertBlock(HOME, "core-tail");
  check("还原后又有消息", readTail().length > 0);
}

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fails.length) { console.log("\n失败项："); for (const f of fails) console.log("  - " + f); }
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
