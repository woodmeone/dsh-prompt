/**
 * dsh-prompt · 块 id 的提示与白名单必须说同一件事（票5）
 *
 * 这个套件锁的是「**界面上的提示和后端的校验不能互相矛盾**」。
 *
 * 改造前面板 placeholder 写着「新块 id（字母数字 _ . : -）」，明确包含冒号；
 * 而 safeId() 的白名单 /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/ 明确排除冒号
 * （它在 Windows 文件名里非法，是备用数据流分隔符，写盘会 EINVAL）。
 *
 * 用户照着提示输入 my:block，必然失败；错误信息还会强调「不含冒号」——
 * 用户会以为自己看错了提示，而不是提示写错了。这是纯粹的自我矛盾。
 *
 * 对抗视角：
 *   - 只测「placeholder 里没有冒号」不够：文案可以换成别的谎。
 *     更强的断言是：**从 placeholder 里解析出它宣称的字符集，
 *     逐个字符拿去做 safeId 实测**，宣称能过的必须真能过。
 *   - 还要测前端不做二次校验这件事：如果前端自己拦掉了合法 id，
 *     后端白名单再正确也没用。
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

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-idhint-"));
  blocks.seedBlocks(home, PLUGIN_DIR);
  return home;
}

const panelSrc = () => fs.readFileSync(path.join(LIB, "prompt-panel.client.js"), "utf8");

/**
 * 抓「新建块」那个 id 输入框的 placeholder。
 * 必须锚定含 `id` 的那一条 —— 面板里还有「显示名」的 placeholder，
 * 用宽松正则抓第一条会抓错对象，让后面的断言全部空转。
 */
function idPlaceholder() {
  const src = panelSrc();
  const m = src.match(/placeholder:\s*"([^"]*id[^"]*)"/i);
  return m ? m[1] : "";
}

/** 文案里宣称可用的符号。用来做「宣称 vs 实测」的反自相矛盾校验。 */
const SYMBOLS = ["_", ".", "-", ":", "/", "\\", "@", "#", "$", "%", "&", "*", "+", "=", "!", "?", "~"];

// ═══════════════════════════════════════════════════════════════
console.log("\n[1] 白名单是唯一真相：先确认它的真实行为");
// ═══════════════════════════════════════════════════════════════
{
  // 能过的（注意：`A9_-.` 这种以点结尾的会被拒绝，是正确行为 —— 见下面 denied）
  for (const ok of ["myblock", "my_block", "a1", "a.b-c_d", "A9_-x"]) {
    check(`safeId(${JSON.stringify(ok)}) 合法`, blocks.safeId(ok) === ok, `got=${JSON.stringify(blocks.safeId(ok))}`);
  }
  // 不能过的 —— 尤其是冒号（改造前面板宣称允许）
  const denied = [
    ["my:block", "冒号（Windows 备用数据流分隔符）"],
    ["with space", "空格"],
    ["中文块", "非 ASCII"],
    ["CON", "Windows 保留名"],
    ["nul.md", "Windows 保留名带后缀"],
    ["trail.", "尾随点"],
    ["-lead", "以短横开头"],
    [".dot", "以点开头"],
    ["a/b", "路径分隔符"],
    ["a\\b", "反斜杠"],
  ];
  for (const [bad, why] of denied) {
    check(`safeId 拒绝 ${JSON.stringify(bad)}（${why}）`, blocks.safeId(bad) === "",
      `got=${JSON.stringify(blocks.safeId(bad))}`);
  }
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[2] placeholder 不许再宣称允许冒号");
// ═══════════════════════════════════════════════════════════════
{
  const text = idPlaceholder();
  check("找得到新建块的 id placeholder", text.length > 0, "没匹配到 placeholder 文案");
  console.log(`       当前文案：${JSON.stringify(text)}`);
  check("placeholder 不含冒号", !text.includes(":"), `文案里仍有冒号：${text}`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[3] placeholder 宣称的字符集必须真能通过 safeId（反自相矛盾）");
// ═══════════════════════════════════════════════════════════════
{
  const text = idPlaceholder();
  const claimed = SYMBOLS.filter((s) => text.includes(s));
  console.log(`       文案里出现的符号：${JSON.stringify(claimed)}`);
  // 这条防的是「文案被清空或改得过度保守」导致本节没有断言可跑。
  check("文案至少宣称了 _ . - 三者（否则提示没有信息量）",
    ["_", ".", "-"].every((s) => claimed.includes(s)), `claimed=${JSON.stringify(claimed)}`);
  for (const s of claimed) {
    const probe = `ab${s}cd`;
    const got = blocks.safeId(probe);
    check(`文案宣称可用 ${JSON.stringify(s)}，实测 safeId(${JSON.stringify(probe)}) 放行`,
      got === probe, `safeId 返回 ${JSON.stringify(got)}`);
  }
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[4] 照着 placeholder 的例子真能建成块（端到端）");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome();
  const text = idPlaceholder();
  const claimed = ["_", ".", "-"].filter((s) => text.includes(s));
  check("至少拿到一个可端到端验证的符号", claimed.length > 0, `claimed=${JSON.stringify(claimed)}`);
  for (const s of claimed) {
    const id = `demo${s}block`;
    const r = edit.addBlock(home, { id, name: `演示${s}`, slots: ["top"], content: "x" });
    eq(`用 ${JSON.stringify(s)} 的 id 能建成块`, r.ok, true);
  }
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[5] 非法 id 的报错要指出「哪里错了」，而不是只说不行");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome();
  const r = edit.addBlock(home, { id: "my:block", name: "冒号块", slots: ["top"], content: "x" });
  eq("冒号 id 被拒绝", r.ok, false);
  check("错误信息提到冒号", r.error.includes("冒号"), `error=${r.error}`);
  check("错误信息给出可用的字符集", /[A-Za-z0-9_]/.test(r.error) || r.error.includes("字母数字"),
    `error=${r.error}`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[6] 面板前端不得比后端更严（否则合法 id 被界面挡掉）");
// ═══════════════════════════════════════════════════════════════
{
  const src = panelSrc();
  // 面板只该判「非空」，不该自己写一套白名单正则
  const hasOwnIdRegex = /\/\^\[A-Za-z0-9_\]|test\(\s*[a-zA-Z]*[Ii]d\s*\)/.test(src);
  check("面板没有自己复制一套 id 白名单正则", !hasOwnIdRegex,
    "面板里出现了 id 正则，容易与后端漂移");
}

console.log("\n==================================================");
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fail) {
  console.log("\n失败项：");
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
