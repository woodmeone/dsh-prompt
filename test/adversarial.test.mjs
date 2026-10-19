/**
 * dsh-prompt · 对抗式审查（逆向思维）
 *
 * 不测「功能对不对」，测「怎么把它弄坏」。每项都是一个具体的攻击面：
 *   1. 路径穿越 / 注入
 *   2. 巨型输入 / DoS
 *   3. 竞态（边写边读）
 *   4. 幂等性（重复 Apply）
 *   5. 宿主被别的插件改过时的行为
 *   6. 孤立态（数据目录被清 / 权限只读）
 *
 * node test/adversarial.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const LIB = path.join(HERE, "..", "lib");
const PLUGIN_DIR = path.join(HERE, "..");

const locate = await import(pathToFileURL(path.join(HERE, "host-locate.mjs")).href);
// 宿主按机器定位（env → core.findAiBase → npx 缓存），不再写死 npx 指纹。
const AI_BASE = await locate.reportAndLocate("宿主");
const HOST_FILE = locate.hostFile(AI_BASE, "dsh-agent-loop/lib/index.js");

const blocks = await import(pathToFileURL(path.join(LIB, "prompt-blocks.js")).href);
const edit = await import(pathToFileURL(path.join(LIB, "prompt-edit.js")).href);
const inject = await import(pathToFileURL(path.join(LIB, "prompt-inject.js")).href);
const patches = await import(pathToFileURL(path.join(LIB, "prompt-patches.js")).href);

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); return; }
  fail += 1; fails.push(`${name}${detail ? " — " + detail : ""}`);
  console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-adv-"));
blocks.seedBlocks(HOME, PLUGIN_DIR);

// ── 攻击面 1：路径穿越 ─────────────────────────────────────────
console.log("\n[1] 路径穿越 / 注入");
{
  const escapes = [
    "../../etc/passwd",
    "..\\..\\windows\\system32",
    "a/../../b",
    "/absolute/path",
    "CON",           // Windows 保留名
    "con",           // 大小写不敏感
    "COM1",
    "LPT9",
    "core-persona\0x",  // NUL
    ".",
    "..",
    "  ",
    "",
    "trailing.",     // 尾随点（Windows 会吃掉）
    "has:colon",     // 冒号在 Windows 文件名里非法
    "has<angle>",
    "has|pipe",
    "has?question",
    "has*star",
    "x".repeat(200),  // 超长
  ];
  for (const id of escapes) {
    const r = edit.addBlock(HOME, { id, content: "x" });
    check(`拒绝非法 id: ${JSON.stringify(id).slice(0, 40)}`, r.ok === false, `got=${JSON.stringify(r)}`);
  }
  // 合法 id 应通过
  const ok = edit.addBlock(HOME, { id: "valid_1.a-b", content: "x" });
  check("接受合法 id", ok.ok === true, JSON.stringify(ok));
  edit.removeBlock(HOME, "valid_1.a-b");

  // 确认没有任何文件被写到 dsh-prompt 目录之外
  const stray = [];
  (function walk(d, depth) {
    if (depth > 3) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
      else stray.push(path.join(d, e.name));
    }
  })(HOME, 0);
  const outside = stray.filter((f) => !f.startsWith(path.join(HOME, "dsh-prompt")));
  check("没有文件写到 dsh-prompt 目录之外", outside.length === 0, outside.join(", "));
}

// ── 攻击面 2：巨型输入 ─────────────────────────────────────────
console.log("\n[2] 巨型输入");
{
  const huge = "A".repeat(600 * 1024);
  const r = edit.setBlockContent(HOME, "core-style", huge);
  check("超过 512KB 被拒", r.ok === false, JSON.stringify(r).slice(0, 80));

  const ok = edit.setBlockContent(HOME, "core-style", "A".repeat(400 * 1024));
  check("400KB 接受", ok.ok === true);
  const t0 = Date.now();
  blocks.assembleTop(HOME);
  const dt = Date.now() - t0;
  check(`装配 400KB 块 < 500ms（实测 ${dt}ms）`, dt < 500);
  edit.revertBlock(HOME, "core-style");

  // 巨量块数
  for (let i = 0; i < 300; i += 1) {
    edit.addBlock(HOME, { id: `bulk-${i}`, content: `块 ${i}`, slots: ["top"] });
  }
  const t1 = Date.now();
  const d = blocks.describe(HOME);
  const dt2 = Date.now() - t1;
  check(`300 块 describe < 3s（实测 ${dt2}ms）`, dt2 < 3000);
  check("块数正确", d.total === 7 + 300, `got=${d.total}`);
  for (let i = 0; i < 300; i += 1) edit.removeBlock(HOME, `bulk-${i}`);
  check("清理后回到 7", blocks.describe(HOME).total === 7);
}

// ── 攻击面 3：竞态（边写边读）──────────────────────────────────
console.log("\n[3] 竞态：边写边读");
{
  // 写 200 次，同时读 200 次，装配结果不许出现残片
  let badReads = 0;
  const marker = "完整性标记-END";
  edit.setBlockContent(HOME, "core-style", "开始" + marker);
  for (let i = 0; i < 200; i += 1) {
    const body = `轮次${i}` + marker;
    edit.setBlockContent(HOME, "core-style", body);
    const got = blocks.readBlockContent(HOME, "core-style").text;
    // 要么是空的（读到了 rename 前的瞬时态——不可能，因为 rename 是原子的），
    // 要么以 marker 结尾
    if (got && !got.endsWith(marker)) badReads += 1;
  }
  check("200 次边写边读无残片", badReads === 0, `残片次数=${badReads}`);
  edit.revertBlock(HOME, "core-style");
}

// ── 攻击面 4：幂等性 ───────────────────────────────────────────
console.log("\n[4] 幂等性（重复 Apply）");
{
  const HOST = HOST_FILE;
  if (fs.existsSync(HOST)) {
    let orig = fs.readFileSync(HOST, "utf8");
    const r1 = patches.tailPatch().replacements[0];
    // 宿主已打补丁时先反解回原始形态 —— 下面整套断言都以「干净宿主」为前提。
    // 不这么做的话，给真实机器跑必挂；那是前提写错，不是回归。
    if (orig.includes("[dsh-prompt] append tail blocks")) {
      orig = orig.replace(r1.replace, r1.pattern);
    }
    let t1 = orig.replace(r1.pattern, r1.replace);
    // 第二次：pattern 已不存在
    const t2 = t1.replace(r1.pattern, r1.replace);
    check("主补丁第二次施加无变化", t1 === t2);

    // needle 补丁：主补丁已自带 needle → pattern 不匹配 → no-op
    const nr = patches.tailPatchNeedle().replacements[0];
    const t3 = t1.replace(nr.pattern, nr.replace);
    check("needle 补丁在主补丁之后是 no-op", t3 === t1, `len ${t1.length} → ${t3.length}`);

    // 模拟 v1 主补丁（只有 marker，无 needle）：needle 补丁应能补一次，且只补一次
    const v1 = orig.replace(r1.pattern, r1.replace.replace(`\t\t// ${patches.NEEDLE_TAIL_TEXT}\n`, ""));
    check("v1 形态不含 needle", !v1.includes(patches.NEEDLE_TAIL_TEXT));
    const up1 = v1.replace(nr.pattern, nr.replace);
    check("v1 → 补齐 needle", up1.includes(patches.NEEDLE_TAIL_TEXT));
    const up2 = up1.replace(nr.pattern, nr.replace);
    check("needle 补丁幂等（再施加无变化）", up1 === up2, `len ${up1.length} → ${up2.length}`);

    check("只含一份组装逻辑", (t1.split("const __dshPromptTailFn").length - 1) === 1);
    check("只含一份标记", (t1.split("[dsh-prompt] append tail blocks").length - 1) === 1);
    check("只含一份 needle", (t1.split(patches.NEEDLE_TAIL_TEXT).length - 1) === 1);
  } else {
    check("宿主编译产物在（跳过幂等测试）", false, "宿主不在");
  }
}

// ── 攻击面 5：宿主被别的插件改过 ───────────────────────────────
console.log("\n[5] 宿主残留外来补丁时的行为");
{
  const HOST = HOST_FILE;
  if (fs.existsSync(HOST)) {
    const t = fs.readFileSync(HOST, "utf8");
    const foreign = patches.detectForeignTailPatches(t);
    check("能报出外来补丁", Array.isArray(foreign));
    console.log("  当前宿主外来补丁:", foreign.length ? foreign.join(", ") : "（无）");
    // 不管宿主被谁改过，我们的锚点都必须唯一 —— 这是补丁能安全施加的前提。
    // （loom 残留清掉后这条曾会因 if 条件不满足而静默少一项，所以改成无条件检查。）
    const n = t.split(patches.tailPatch().replacements[0].pattern).length - 1;
    check("宿主当前形态下锚点仍唯一", n <= 1, `命中=${n}`);
    // 已装过我们的补丁时，pattern 不再出现（幂等），那是正常态
    if (t.includes("[dsh-prompt]")) {
      check("已装我们补丁时锚点 pattern 已自消耗", n === 0, `命中=${n}`);
    }
  }
}

// ── 攻击面 6：孤立态 ───────────────────────────────────────────
console.log("\n[6] 孤立态");
{
  // 数据目录被整体删除
  const H = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-orphan-"));
  blocks.seedBlocks(H, PLUGIN_DIR);
  fs.rmSync(path.join(H, "dsh-prompt"), { recursive: true, force: true });
  let threw = false;
  try {
    blocks.describe(H);
    blocks.assembleTop(H);
    blocks.assembleTail(H);
  } catch (e) { threw = true; }
  check("数据目录被删后不抛", !threw);
  check("describe 回落 builtin", blocks.describe(H).configSource === "builtin");

  // config.json 是目录（不是文件）
  fs.mkdirSync(path.join(H, "dsh-prompt", "config.json"), { recursive: true });
  threw = false;
  try { blocks.loadConfig(H); } catch { threw = true; }
  check("config 是目录时不抛", !threw);
  fs.rmSync(H, { recursive: true, force: true });

  // blocks/<id>.md 是目录
  const H2 = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-dirblk-"));
  fs.mkdirSync(path.join(H2, "dsh-prompt", "blocks", "core-style.md"), { recursive: true });
  threw = false;
  try { blocks.readBlockContent(H2, "core-style"); } catch { threw = true; }
  check("块文件是目录时不抛", !threw);
  fs.rmSync(H2, { recursive: true, force: true });
}

// ── 攻击面 7：尾部消息的形状与上限 ────────────────────────────
console.log("\n[7] 尾部消息形状");
{
  const a = blocks.assembleTail(HOME, { withText: true });
  const msgs = inject.buildTailMessages(a);
  for (const m of msgs) {
    check("无 id（不与持久 Message 混）", m.id === undefined);
    check("无 source", m.source === undefined);
    check("role 合法", ["system", "user", "assistant"].includes(m.role));
    check("content 非空", Array.isArray(m.content) && m.content.length === 1);
  }
  // 空块 → 无消息
  const emptyAssembled = { text: "  ", parts: [] };
  check("空装配 → 空数组", inject.buildTailMessages(emptyAssembled).length === 0);
  // part 无 text → 跳过
  const noText = { text: "x", parts: [{ id: "p", role: "user" }] };
  check("part 缺 text → 跳过", inject.buildTailMessages(noText).length === 0);
  // 非法 role 归一
  const badRole = { text: "x", parts: [{ id: "p", role: "root", text: "内容" }] };
  const m2 = inject.buildTailMessages(badRole);
  check("非法 role 归一为 system", m2.length === 1 && m2[0].role === "system", JSON.stringify(m2));
}

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fails.length) { console.log("\n失败项："); for (const f of fails) console.log("  - " + f); }
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
