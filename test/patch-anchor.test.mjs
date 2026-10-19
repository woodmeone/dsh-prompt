/**
 * 验证 dsh-prompt 的宿主补丁锚点是否精确命中 live 宿主。
 * node test/patch-anchor.test.mjs
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const patches = await import(pathToFileURL(path.join(HERE, "..", "lib", "prompt-patches.js")).href);
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
console.log("存在:", fs.existsSync(HOST));
if (!fs.existsSync(HOST)) { console.log("宿主不在，跳过"); process.exit(0); }

const text = fs.readFileSync(HOST, "utf8");
console.log(`宿主大小: ${text.length} 字符`);

// 宿主可能处于两种状态：
//   · 干净   —— pattern 命中 1 次，标记不存在
//   · 已补丁 —— pattern 命中 0 次，标记存在
// 本测试两种情况都要能跑：现场机器上的宿主就是已补丁态（面板点过「装宿主补丁」）。
// 原先只认干净态，于是给真实机器跑必挂 —— 那不是回归，是前提没写对。
const alreadyPatched = text.includes("[dsh-prompt]") && text.includes("globalThis.__dshPromptTail");
console.log("宿主状态:", alreadyPatched ? "已打补丁" : "干净");
// 从状态推出「未补丁文本」：已补丁时反解回原始形态，供锚点断言使用
const pristine = alreadyPatched
  ? text.replace(patches.tailPatch().replacements[0].replace, patches.tailPatch().replacements[0].pattern)
  : text;
if (alreadyPatched) {
  console.log("已反解回原始形态以供断言（字符数", pristine.length, "）");
}

console.log("\n[1] 锚点唯一性");
for (const p of patches.PROMPT_PATCHES) {
  // needle 补丁的 pattern 是「主补丁施加后才存在」的标记，不在原始宿主里 —— 跳过
  if (p.id === "TAIL_INJECT_NEEDLE") continue;
  for (const r of p.replacements) {
    const n = pristine.split(r.pattern).length - 1;
    check(`${p.id} 的 pattern 命中 ${n} 次（须为 1）`, n === 1, `pattern 首行: ${r.pattern.split("\n")[0].trim()}`);
  }
}

console.log("\n[2] needle 补丁的前置条件：主补丁已自带 needle → 本补丁应 no-op");
{
  const needle = patches.tailPatchNeedle();
  for (const r of needle.replacements) {
    const nOrig = pristine.split(r.pattern).length - 1;
    check(`needle pattern 原始宿主命中 ${nOrig} 次（须为 0）`, nOrig === 0);
    const mainApplied = pristine.replace(patches.tailPatch().replacements[0].pattern, patches.tailPatch().replacements[0].replace);
    const nAfter = mainApplied.split(r.pattern).length - 1;
    check(`主补丁施加后 needle pattern 命中 ${nAfter} 次（须为 0，因为主补丁已含 needle）`, nAfter === 0);
  }
}

console.log("\n[3] 施加补丁后：结果文本正确、幂等");
{
  let out = pristine;
  out = out.replace(patches.tailPatch().replacements[0].pattern, patches.tailPatch().replacements[0].replace);
  check("补丁施加成功（文本变了）", out !== pristine);
  check("含标记", out.includes("[dsh-prompt] append tail blocks"));
  check("含钩子名", out.includes("globalThis.__dshPromptTail"));
  check("不再是 const（改成了 let）", out.includes("let boundaryMessages = session.deriveMessages();"));
  check("仍保留 messages: boundaryMessages", out.includes("messages: boundaryMessages,"));

  // 已补丁态下，实盘文本应与此处的施加结果一致（说明落的就是这份补丁）
  if (alreadyPatched) {
    check("实盘文本 == 本测试施加结果（补丁版本一致）", text === out,
      `实盘 ${text.length} 字符 / 期望 ${out.length} 字符`);
  }

  // 再施加一次应无变化（pattern 已不存在）
  const again = out.replace(patches.tailPatch().replacements[0].pattern, patches.tailPatch().replacements[0].replace);
  check("二次施加幂等（无变化）", again === out);

  // 语法检查
  const tmp = path.join(HERE, "_patched-syntax-check.js");
  fs.writeFileSync(tmp, out, "utf8");
  const { execFileSync } = await import("node:child_process");
  let syntaxOk = true, err = "";
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  } catch (e) { syntaxOk = false; err = String(e.stderr || e.message).slice(0, 400); }
  check("补丁后仍是合法 JS（node --check）", syntaxOk, err);
  fs.rmSync(tmp, { force: true });

  // needle 补丁：主补丁已自带 needle → 应 no-op（文本不变）
  const withNeedle = out.replace(patches.tailPatchNeedle().replacements[0].pattern, patches.tailPatchNeedle().replacements[0].replace);
  check("needle 补丁在主补丁之后 no-op（文本不变）", withNeedle === out);
  check("主补丁结果已含 needle 标记", out.includes(patches.NEEDLE_TAIL_TEXT));
}

console.log("\n[4] 残留外来补丁检测");
{
  const foreign = patches.detectForeignTailPatches(text);
  console.log("  宿主上的外来补丁来源:", foreign.length ? foreign.join(", ") : "（无）");
  check("检测函数可用", Array.isArray(foreign));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fails.length) { console.log("\n失败项："); for (const f of fails) console.log("  - " + f); }
process.exit(fail ? 1 : 0);
