/**
 * dsh-prompt · 字节口径（票2）
 *
 * 这个套件锁的是一件很朴素的事：**叫 bytes 的字段必须真的是字节。**
 *
 * 为什么值得一个专门的测试文件：
 *   改造前 parts 里的 bytes 是 text.length，即 UTF-16 码元数。而写入侧的
 *   512KB 上限校验用的是 Buffer.byteLength(text,'utf8') —— 两个口径。
 *   中文提示词下差近 2 倍（ASCII 才 1:1），用户看到「1727 字」以为离上限
 *   很远，实际已经用掉 3319 字节。
 *
 * 对抗视角：
 *   - 只测 ASCII 会漏掉这个 bug（ASCII 下 length === byteLength）。
 *     所以每条断言都必须用中文/emoji 这类多字节字符。
 *   - 只测一个字段会漏掉其它出口（parts / blocks / top / tail / status）。
 *     所以每个对外暴露 bytes 的地方都要点到。
 *   - 期望值必须从独立来源算（Buffer.byteLength），不能从被测代码反推。
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
function eq(name, got, want) {
  check(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

/** 字节数一律从 Buffer 独立计算，不复用被测代码的算法。 */
const bytesOf = (s) => Buffer.byteLength(String(s), "utf8");

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-bytes-"));
  blocks.seedBlocks(home, PLUGIN_DIR);
  return home;
}

// 多字节样本：中文 + emoji + ASCII 混排，确保 length !== byteLength
const ZH = "中文内容测试";        // length 6, bytes 18
const MIXED = "abc中文😀";        // 确认 emoji 是 4 字节
const ASCII = "abcdef";           // length === bytes

// ═══════════════════════════════════════════════════════════════
console.log("\n[0] 样本自检：这些字符串的 length 与 byteLength 必须不同");
// ═══════════════════════════════════════════════════════════════
check(`"${ZH}" length=${ZH.length} != bytes=${bytesOf(ZH)}`, ZH.length !== bytesOf(ZH));
check(`"${MIXED}" length=${MIXED.length} != bytes=${bytesOf(MIXED)}`, MIXED.length !== bytesOf(MIXED));
eq(`"${ASCII}" length == bytes（ASCII 对照组）`, ASCII.length, bytesOf(ASCII));

// ═══════════════════════════════════════════════════════════════
console.log("\n[1] parts[].bytes 是 UTF-8 字节数");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome();
  edit.addBlock(home, { id: "zh-only", name: "中文块", slots: ["top"], content: ZH });
  const a = blocks.assembleTop(home, { withText: true });
  const part = a.parts.find((p) => p.id === "zh-only");
  check("中文块进了装配", Boolean(part));
  eq(`bytes 是 ${bytesOf(ZH)}（改造前会报 ${ZH.length}）`, part.bytes, bytesOf(ZH));
  check(`bytes ≠ text.length，证明不是码元数`, part.bytes !== ZH.length,
    `bytes=${part.bytes} length=${ZH.length}`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[2] describe().blocks[].bytes 是 UTF-8 字节数");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome();
  edit.addBlock(home, { id: "zh-b", name: "中文块B", slots: ["top"], content: MIXED });
  const d = blocks.describe(home);
  const b = d.blocks.find((x) => x.id === "zh-b");
  eq(`混排块的 bytes 是 ${bytesOf(MIXED)}`, b.bytes, bytesOf(MIXED));

  // 出厂块也要对得上（直接读盘算独立期望值）
  const persona = d.blocks.find((x) => x.id === "core-persona");
  const raw = fs.readFileSync(path.join(home, "dsh-prompt", "blocks", "core-persona.md"), "utf8");
  eq(`core-persona bytes = 文件真实字节数`, persona.bytes, bytesOf(raw));
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[3] topBytes / tailBytes 是 UTF-8 字节数");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome();
  // 关掉所有出厂块，只留一个可控的中文块，避免其它内容干扰
  for (const b of blocks.BUILTIN_BLOCKS) {
    edit.updateBlockMeta(home, b.id, { enabled: false });
  }
  edit.addBlock(home, { id: "only-top", name: "仅顶部", slots: ["top"], content: ZH });
  edit.addBlock(home, { id: "only-tail", name: "仅尾部", slots: ["tail"], content: ZH });

  const d = blocks.describe(home);
  eq(`topBytes = ${bytesOf(ZH)}`, d.topBytes, bytesOf(ZH));
  eq(`tailBytes = ${bytesOf(ZH)}`, d.tailBytes, bytesOf(ZH));
  check("topBytes ≠ 码元数", d.topBytes !== ZH.length);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[4] snapshot() 也走同一口径（面板读的是它）");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome();
  for (const b of blocks.BUILTIN_BLOCKS) {
    edit.updateBlockMeta(home, b.id, { enabled: false });
  }
  edit.addBlock(home, { id: "snap-zh", name: "快照块", slots: ["top"], content: ZH });
  const snap = edit.snapshot(home);
  const item = snap.items.find((x) => x.id === "snap-zh");
  eq(`snapshot.items[].bytes = ${bytesOf(ZH)}`, item.bytes, bytesOf(ZH));
  eq(`snapshot.topBytes = ${bytesOf(ZH)}`, snap.topBytes, bytesOf(ZH));
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[5] 与 512KB 上限同一口径：bytes 可以直接和上限比");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome();
  // 造一个接近但不超过上限的中文块：250000 个汉字 = 750000 字节 > 512KB(524288)
  // 所以取 170000 汉字 = 510000 字节，卡在上限之内
  const n = 170000;
  const content = "汉".repeat(n);
  const want = bytesOf(content);
  check(`样本字节数 ${want} < 上限 ${blocks.maxBlockBytes()}`, want < blocks.maxBlockBytes());
  const r = edit.addBlock(home, { id: "big-zh", name: "大中文块", slots: ["top"], content });
  eq("510KB 的中文块可以保存（未超 512KB 上限）", r.ok, true);
  const d = blocks.describe(home);
  eq(`describe 报的 bytes 与真实字节一致`, d.blocks.find((x) => x.id === "big-zh").bytes, want);
  check("此时 bytes 已接近上限，码元数却只有 1/3 —— 正是这个口径差骗人",
    d.blocks.find((x) => x.id === "big-zh").bytes > content.length * 2);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[6] 面板文案不许再把字节说成「字」");
// ═══════════════════════════════════════════════════════════════
{
  const panel = fs.readFileSync(path.join(LIB, "prompt-panel.client.js"), "utf8");
  // 找形如 `... + " 字"` 的文案，确认已改成字节语义
  const saysZi = /\+\s*"\s*字\s*"/.test(panel);
  check('面板不再用 `" 字"` 描述 bytes 字段', !saysZi,
    "仍存在把 bytes 显示成「字」的文案");
  check("面板文案含「字节」或「B」", /字节|\bB\b/.test(panel));
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[7] status op 的 payload 也必须是字节（面板顶部显示的是它）");
// ═══════════════════════════════════════════════════════════════
{
  // 曾经这里是个漏洞：面板顶部读的是 status 返回的 snap.top.bytes，
  // 而 index.js 里那两处用的是 text.length（码元）。于是面板显示 300 B
  // 而真实是 900 B —— PR 的核心主张「叫 bytes 的必须真是字节」在最显眼处失守。
  // 这组断言直接扫 index.js 的源码，确保没有裸 .length 混进 bytes 字段。
  const idx = fs.readFileSync(path.join(LIB, "index.js"), "utf8");

  const topLine = idx.match(/top:\s*\{[^}]*bytes:[^,}]*/);
  check("找得到 status payload 的 top.bytes 赋值", Boolean(topLine),
    "index.js 里没匹配到 top.bytes");
  if (topLine) {
    check("top.bytes 用 byteSize，不是 text.length",
      /byteSize\(/.test(topLine[0]) && !/\.length/.test(topLine[0]),
      `实际写法：${topLine[0].trim()}`);
  }

  // 只取 bytes: 之后的表达式，别把 `messages: tailMsgs.length` 这类
  // 「条数」也当成违规 —— 条数本来就该是 .length。
  const tailBytesExpr = idx.match(/bytes:\s*tailMsgs\.reduce\([\s\S]{0,300}?\n\s*\},?/);
  check("找得到 status payload 的 tail.bytes 表达式", Boolean(tailBytesExpr));
  if (tailBytesExpr) {
    const expr = tailBytesExpr[0];
    check("tail.bytes 用 byteSize 累加文本体积",
      /byteSize\(/.test(expr), `实际写法：${expr.replace(/\s+/g, " ").slice(0, 110)}`);
    check("tail.bytes 不再直接累加码元 text.length",
      !/\)\s*\.length/.test(expr), `实际写法：${expr.replace(/\s+/g, " ").slice(0, 110)}`);
  }
}

console.log("\n==================================================");
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fail) {
  console.log("\n失败项：");
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
