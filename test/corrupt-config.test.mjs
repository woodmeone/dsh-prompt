/**
 * dsh-prompt · 块表读取失败的可判定信号（票3）
 *
 * 这个套件锁的是「**不许静默吞掉用户数据**」。
 *
 * 改造前 config.json 存在但读不懂时，loadConfig/readJson 是 catch { return null }，
 * null 就走内建默认表。实测：用户自建两个块，把 config 写坏，describe 从 9 块变 7 块，
 * 用户那两个块在界面上人间蒸发，而面板照常渲染、不报错、不提示。
 * 文件还在盘上，但没有任何信号告诉任何人出事了。
 *
 * 设计取舍（这是本票最需要说清的一点）：
 *   既要「不抛」（装配侧既有纪律，不能因为一个坏文件把注入弄塌），
 *   又要「能被发现」（面板得知道）。
 *   解法：**降级行为不变，但把降级这件事本身暴露出来** ——
 *   configSource 从 "builtin" 细分成 "corrupt"，并附 configError。
 *   原有的「坏 config 回落 builtin」测试断言 configSource === "builtin"，
 *   本票有意改变这个可观测值，故同步更新那条断言（见 blocks.test.mjs）。
 *
 * 对抗视角：
 *   - 只测「不抛」会漏掉整件事（旧代码也不抛）。必须测「有没有信号」。
 *   - 只测一个坏法不够：空文件、截断 JSON、根不是对象、blocks 不是数组，
 *     这四种在用户那里都真实发生（手滑删一半、磁盘满、并发写）。
 *   - 必须防止把「没有 config」误报成 corrupt —— 全新安装不该看到红字。
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-corrupt-"));
  blocks.seedBlocks(home, PLUGIN_DIR);
  return home;
}
const cfgPathOf = (home) => path.join(home, "dsh-prompt", "config.json");

// ═══════════════════════════════════════════════════════════════
console.log("\n[1] 全新安装：没有 config.json 不该报错");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome();
  fs.rmSync(cfgPathOf(home), { force: true });
  const d = blocks.describe(home);
  eq("configSource 是 builtin（不是 corrupt）", d.configSource, "builtin");
  eq("configError 是空串", d.configError, "");
  check("7 个出厂块在", d.total === 7, `total=${d.total}`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[2] config.json 读不懂：降级照旧，但必须给出信号");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome();
  // 先正常写一份带用户块的 config
  fs.writeFileSync(cfgPathOf(home), JSON.stringify({
    blocks: [{ id: "mine1", name: "我的块1", order: 50, enabled: true, slots: ["top"], role: "system" }],
  }, null, 2));
  fs.writeFileSync(path.join(home, "dsh-prompt", "blocks", "mine1.md"), "我的内容1");
  const ok = blocks.describe(home);
  check("正常情况下用户的块在", ok.blocks.some((b) => b.id === "mine1"));
  eq("正常情况下 configSource 是 config", ok.configSource, "config");

  // 现在写坏
  fs.writeFileSync(cfgPathOf(home), '{ "blocks": [ { "id": "mine1"');
  const d = blocks.describe(home);

  eq("坏 config 的 configSource 是 corrupt", d.configSource, "corrupt");
  check("configError 非空且说得出原因", typeof d.configError === "string" && d.configError.length > 0,
    `configError=${JSON.stringify(d.configError)}`);
  check("降级行为照旧：回落到 7 个出厂块", d.total === 7, `total=${d.total}`);
  check("依然不抛（装配侧纪律）", true);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[3] 四种真实的坏法都要被识别");
// ═══════════════════════════════════════════════════════════════
{
  const cases = [
    { name: "空文件", text: "" },
    { name: "截断的 JSON", text: '{ "blocks": [ {' },
    { name: "根是数组不是对象", text: "[1,2,3]" },
    { name: "blocks 是字符串不是数组", text: '{"blocks":"nope"}' },
  ];
  for (const c of cases) {
    const home = makeHome();
    fs.writeFileSync(cfgPathOf(home), c.text);
    const d = blocks.describe(home);
    const flagged = d.configSource === "corrupt" || (c.name === "blocks 是字符串不是数组" && d.configSource === "config");
    check(`${c.name}：被标记（configSource=${d.configSource}）`, flagged,
      `configSource=${d.configSource} configError=${JSON.stringify(d.configError)}`);
  }
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[4] 坏 config 下装配仍然工作（fail-open 不能退）");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome();
  fs.writeFileSync(cfgPathOf(home), "not json at all");
  let threw = false;
  let text = "";
  try {
    const a = blocks.assembleTop(home);
    text = a.text;
  } catch { threw = true; }
  check("坏 config 下 assembleTop 不抛", !threw);
  check("坏 config 下仍装配出出厂正文（注入不塌）", text.length > 0, `bytes=${text.length}`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[5] config.json 是目录（异常文件系统态）也要能判定");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome();
  const cfg = cfgPathOf(home);
  fs.rmSync(cfg, { force: true });
  fs.mkdirSync(cfg, { recursive: true });
  let threw = false;
  let d = null;
  try { d = blocks.describe(home); } catch { threw = true; }
  check("config 是目录时不抛", !threw);
  check("并且被标记为不可读", d && d.configSource === "corrupt", `configSource=${d && d.configSource}`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[6] snapshot() 也带这个信号（面板走的是它）");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome();
  fs.writeFileSync(cfgPathOf(home), "{{{");
  const snap = edit.snapshot(home);
  eq("snapshot.configSource 是 corrupt", snap.configSource, "corrupt");
  check("snapshot.configError 非空", Boolean(snap.configError && snap.configError.length));
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[7] 面板必须显式提示，而不是照常渲染");
// ═══════════════════════════════════════════════════════════════
{
  const panel = fs.readFileSync(path.join(LIB, "prompt-panel.client.js"), "utf8");
  check("面板判断了 configSource === 'corrupt'", panel.includes('"corrupt"') || panel.includes("'corrupt'"));
  check("面板有告警文案（含「读取失败」或「损坏」）", /读取失败|损坏|读不懂/.test(panel));
  check("提示里带上原因（引用 configError）", panel.includes("configError"));
}

console.log("\n==================================================");
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fail) {
  console.log("\n失败项：");
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
