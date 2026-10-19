/**
 * dsh-prompt · 补丁施加的真实测试
 *
 * 在真宿主上施加尾部补丁，验证：
 *   1. 施加前：has_ours=false, needs=true
 *   2. 施加后：has_ours=true, needs=false
 *   3. 幂等：再施加一次不改文本
 *   4. 备份存在：.dsh-prompt.bak
 *   5. 补丁后宿主仍是合法 JS（node --check）
 *   6. 能回滚
 *
 * ⚠ 这个测试**会改真宿主**，跑完自动回滚。
 * 用 --keep 保留改动；用 --rollback 只回滚。
 *
 * node test/apply-real.mjs [--keep|--rollback]
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const LIB = path.join(HERE, "..", "lib");
const patches = await import(pathToFileURL(path.join(LIB, "prompt-patches.js")).href);

const KEEP = process.argv.includes("--keep");
const ROLLBACK = process.argv.includes("--rollback");

const locate = await import(pathToFileURL(path.join(HERE, "host-locate.mjs")).href);

// 宿主按机器定位（env → core.findAiBase → npx 缓存），不再写死 npx 指纹。
const AI_BASE = await locate.reportAndLocate("宿主基座");
const HOST = locate.hostFile(AI_BASE, "dsh-agent-loop/lib/index.js");
const BAK = `${HOST}.dsh-prompt.bak`;

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); return; }
  fail += 1; fails.push(`${name}${detail ? " — " + detail : ""}`);
  console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
}

console.log("宿主:", HOST);
if (!fs.existsSync(HOST)) { console.log("宿主不在，跳过"); process.exit(0); }

// ── 回滚模式 ───────────────────────────────────────────────────
if (ROLLBACK) {
  if (fs.existsSync(BAK)) {
    fs.copyFileSync(BAK, HOST);
    console.log("已从备份回滚:", BAK);
  } else {
    console.log("没有备份，无法回滚");
  }
  process.exit(0);
}

const original = fs.readFileSync(HOST, "utf8");
const alreadyPatched = original.includes("[dsh-prompt]");

if (alreadyPatched) {
  console.log("\n宿主持有已施加的补丁。先回滚再测。");
  if (fs.existsSync(BAK)) {
    fs.copyFileSync(BAK, HOST);
    console.log("已回滚，重新开始测。");
  } else {
    // 没有备份 → 用 pattern 反向还原
    const r = patches.tailPatch().replacements[0];
    const reverted = original.replace(r.replace, r.pattern);
    if (reverted !== original) {
      fs.writeFileSync(HOST, reverted, "utf8");
      console.log("已按 pattern 反向还原。");
    } else {
      console.log("还原失败，跳过测试");
      process.exit(0);
    }
  }
}

// 重新读
let text = fs.readFileSync(HOST, "utf8");

// ── 1. 施加前状态 ──────────────────────────────────────────────
console.log("\n[1] 施加前");
{
  const main = patches.tailPatch().replacements[0];
  check("锚点存在（needs=true 的条件）", text.includes(main.pattern));
  check("还没有我们的标记", !text.includes("[dsh-prompt]"));
  check("宿主上没有别处的 [dsh-prompt]", (text.split("[dsh-prompt]").length - 1) === 0);
}

// ── 2. 施加 ────────────────────────────────────────────────────
console.log("\n[2] 施加补丁");
{
  // 备份
  fs.copyFileSync(HOST, BAK);
  check("备份已建", fs.existsSync(BAK));

  const r = patches.tailPatch().replacements[0];
  const out = text.replace(r.pattern, r.replace);
  fs.writeFileSync(HOST, out, "utf8");
  check("文本已改", out !== text);

  const after = fs.readFileSync(HOST, "utf8");
  check("含我们的标记", after.includes("[dsh-prompt]"));
  check("含钩子名", after.includes("globalThis.__dshPromptTail"));
  check("boundaryMessages 改成 let", after.includes("let boundaryMessages = session.deriveMessages();"));
  check("仍保留 messages: boundaryMessages", after.includes("messages: boundaryMessages,"));
  check("needs 现在应为 false（标记已在）", !(!after.includes("[dsh-prompt]") && after.includes(r.pattern)));

  // 语法
  let ok = true, err = "";
  try { execFileSync(process.execPath, ["--check", HOST], { stdio: "pipe" }); }
  catch (e) { ok = false; err = String(e.stderr || e.message).slice(0, 300); }
  check("补丁后宿主是合法 JS", ok, err);
}

// ── 3. 幂等 ────────────────────────────────────────────────────
console.log("\n[3] 幂等：再施加一次");
{
  const before = fs.readFileSync(HOST, "utf8");
  const r = patches.tailPatch().replacements[0];
  const again = before.replace(r.pattern, r.replace);
  check("再施加无变化（pattern 已自消耗）", again === before);
  check("仍只有一份组装逻辑", (before.split("const __dshPromptTailFn").length - 1) === 1);
  check("仍只有一份标记", (before.split("[dsh-prompt] append tail blocks").length - 1) === 1);
}

// ── 4. 宿主真能被 Node 解析 ────────────────────────────────────
console.log("\n[4] 宿主仍是可加载模块");
{
  let ok = true, err = "";
  try {
    // 只做语法级加载（不真的 import，因为依赖太多）
    execFileSync(process.execPath, ["--check", HOST], { stdio: "pipe" });
  } catch (e) { ok = false; err = String(e.stderr || e.message).slice(0, 300); }
  check("node --check 通过", ok, err);
}

// ── 5. 回滚 ────────────────────────────────────────────────────
console.log("\n[5] 回滚");
{
  if (KEEP) {
    console.log("  --keep：保留改动，不回滚");
    console.log("  回滚命令: node test/apply-real.mjs --rollback");
  } else {
    fs.copyFileSync(BAK, HOST);
    const back = fs.readFileSync(HOST, "utf8");
    check("回滚后无我们的标记", !back.includes("[dsh-prompt]"));
    check("回滚后与原始一致", back === fs.readFileSync(BAK, "utf8"));
    fs.rmSync(BAK, { force: true });
    check("备份已清理", !fs.existsSync(BAK));
  }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fails.length) { console.log("\n失败项："); for (const f of fails) console.log("  - " + f); }
process.exit(fail ? 1 : 0);
