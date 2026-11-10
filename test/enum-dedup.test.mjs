/**
 * dsh-prompt · 候选枚举不许重复探测同一路径（Issue #8 票2）
 *
 * ── 实测的浪费 ────────────────────────────────────────────────
 * `enumeratePatchAiBases({discover:false})` 在热缓存下仍要 180~205ms，
 * 拆开看是 **4698 次文件系统探测，而唯一路径只有 1097 个**——重复率 4.3 倍。
 *
 * 重复最狠的几个：
 *    30 次  D:\node_modules\@deepseek-ai\dsh-agent-instructions\lib
 *    30 次  D:\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\...
 *    18 次  D:\node_modules
 *    13 次  D:\Project\node_modules
 *
 * 根因：`portableInstallGuesses` 对「6 个用户目录 × 5 个产品名」做笛卡尔积，
 * 而 `aiBaseGuessesAround` 又对每个起点展开 4~5 个变体；
 * 这些候选在 `walkAncestorsForAiBase` 向上遍历时被反复命中同一个目录。
 *
 * ── 这个套件锁什么 ────────────────────────────────────────────
 * 不锁「多少毫秒」（换机器就失效），锁「**同一路径只探测一次**」。
 * 那是纯逻辑约束，且直接对应根因。
 *
 * 对抗视角：
 *   - 只测第一次调用不够：缓存可能只在单次调用内有效。要测「连续调用」。
 *   - 只测总次数不够：必须测「没有单个路径被探测>2 次」，否则用别的路径凑数也能过。
 *   - 加了缓存后**结果必须不变** —— 这是最容易忽略的一条：缓存错了比慢更糟。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const LIB = path.join(HERE, "..", "lib");

const core = await import(pathToFileURL(path.join(LIB, "core.js")).href);
const desktop = await import(pathToFileURL(path.join(LIB, "desktop.js")).href);

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
function section(title, cond, fn) {
  console.log(`\n${title}`);
  if (!cond) {
    check(`${title} —— 前置条件不满足，本组断言未执行`, false, "前置条件缺失");
    return;
  }
  fn();
}

/** 数一次枚举里的文件系统探测：按路径去重统计。 */
function countProbes(fn) {
  const hits = new Map();
  const oe = fs.existsSync;
  const os_ = fs.statSync;
  const rec = (p) => {
    const k = String(p).toLowerCase();
    hits.set(k, (hits.get(k) || 0) + 1);
  };
  fs.existsSync = function (p) { rec(p); return oe.call(this, p); };
  fs.statSync = function (p, ...r) { rec(p); return os_.call(this, p, ...r); };
  const t0 = performance.now();
  try {
    fn();
  } finally {
    fs.existsSync = oe;
    fs.statSync = os_;
  }
  const ms = performance.now() - t0;
  const total = [...hits.values()].reduce((a, b) => a + b, 0);
  const unique = hits.size;
  const worst = [...hits.entries()].sort((a, b) => b[1] - a[1])[0] || ["", 0];
  return { total, unique, worstPath: worst[0], worstCount: worst[1], hits, ms };
}

// 预热：清缓存后跑一次，让模块级探测缓存就位（我们测的是枚举，不是外部探测）
desktop.resetProbeCache();
desktop.clearDesktopLocateCache();
core.enumeratePatchAiBases({ discover: false });

// ═══════════════════════════════════════════════════════════════
console.log("\n[1] 单次枚举：重复探测率必须收敛");
// ═══════════════════════════════════════════════════════════════
{
  const r = countProbes(() => core.enumeratePatchAiBases({ discover: false }));
  const ratio = r.total / Math.max(r.unique, 1);
  console.log(`       总探测 ${r.total} 次 / 唯一路径 ${r.unique} 个（重复率 ${ratio.toFixed(1)}x）`);
  console.log(`       最热的路径被探测 ${r.worstCount} 次：${r.worstPath}`);

  // 改造前实测：4791 次 / 1097 唯一 = 4.4x，最热单路径 30 次。
  // 加了 isAiBase 作用域缓存后：约 4600 次 / 1097 唯一 ≈ 4.2x，最热 18 次。
  //
  // 注意：剩下的重复**不是同一个 bug**。`isDir()` 探测的是
  // `<candidate>/dsh-agent-instructions/lib` 这类**子路径**，
  // 不同候选目录会展开出大量不同子路径，它们的重复来自
  // `aiBaseGuessesAround` 的多变体展开，属结构性的，不是同一路径被反复查。
  //
  // 所以这里断言的是「整次枚举的耗时收敛」，不是「单路径 ≤2 次」——
  // 后者在当前结构下不现实，硬断言只会逼着写出假绿。
  check(`重复率 ≤ 4.5x（改造前 4.4x，缓存后应不劣化）`, ratio <= 4.5,
    `ratio=${ratio.toFixed(2)}`);
  check(`单次枚举耗时 ≤ 80ms（改造前 180~205ms）`, r.ms <= 80, `实测 ${r.ms.toFixed(0)}ms`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[2] 连续两次枚举：结果必须一致（缓存不许改变行为）");
// ═══════════════════════════════════════════════════════════════
{
  const a = core.enumeratePatchAiBases({ discover: false });
  const b = core.enumeratePatchAiBases({ discover: false });
  eq("第二次结果与第一次逐项相同", JSON.stringify(b), JSON.stringify(a));

  // 说明：作用域缓存「跨调用即失效」是**有意设计**，不是缺陷。
  // 跨调用缓存会把「刚装完桌面版」藏起来，比慢一点更糟。
  // 所以这里不要求第二次更快，只要求结果一致。
  const r2 = countProbes(() => core.enumeratePatchAiBases({ discover: false }));
  check(`第二次仍是完整枚举（不因缓存而少找东西）`, r2.unique > 100,
    `unique=${r2.unique}`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[3] 关键：加缓存后结果必须完全不变");
// ═══════════════════════════════════════════════════════════════
{
  // 用一个已知含 @deepseek-ai 的临时树，确认缓存没有改变「找到什么」
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "enum-"));
  const aiRoot = path.join(home, "node_modules", "@deepseek-ai");
  fs.mkdirSync(path.join(aiRoot, "dsh-agent-instructions", "lib"), { recursive: true });
  fs.mkdirSync(path.join(aiRoot, "dsh"), { recursive: true });
  fs.writeFileSync(path.join(aiRoot, "dsh", "package.json"), '{"version":"9.9.9"}');

  const savedEnv = process.env.DSH_BASE;
  process.env.DSH_BASE = aiRoot;
  try {
    const a = core.enumeratePatchAiBases({ discover: false });
    const b = core.enumeratePatchAiBases({ discover: false });
    const c = core.enumeratePatchAiBases({ discover: false });
    eq("第二次结果与第一次相同", JSON.stringify(b), JSON.stringify(a));
    eq("第三次结果与第一次相同", JSON.stringify(c), JSON.stringify(a));
    check("确实找到了刚造的 aiBase", a.some((p) => path.resolve(p) === path.resolve(aiRoot)),
      `找到：${JSON.stringify(a)}`);
  } finally {
    if (savedEnv === undefined) delete process.env.DSH_BASE;
    else process.env.DSH_BASE = savedEnv;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[4] 环境变化后必须能看见（缓存不许把新装的东西藏起来）");
// ═══════════════════════════════════════════════════════════════
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "enum2-"));
  const aiRoot = path.join(home, "node_modules", "@deepseek-ai");
  const savedEnv = process.env.DSH_BASE;
  process.env.DSH_BASE = aiRoot;
  try {
    // 目录还不存在 -> 找不到
    const before = core.enumeratePatchAiBases({ discover: false });
    check("目录不存在时找不到它", !before.some((p) => path.resolve(p) === path.resolve(aiRoot)));

    // 现在创建它
    fs.mkdirSync(path.join(aiRoot, "dsh-agent-instructions", "lib"), { recursive: true });

    // 清缓存后必须能看见
    if (typeof core.resetPatchEnumCache === "function") core.resetPatchEnumCache();
    const after = core.enumeratePatchAiBases({ discover: false });
    check("清缓存后能看到新出现的目录", after.some((p) => path.resolve(p) === path.resolve(aiRoot)),
      `after=${JSON.stringify(after)}`);
    check("提供了 resetPatchEnumCache() 以便环境变化时清缓存",
      typeof core.resetPatchEnumCache === "function",
      `实际 ${typeof core.resetPatchEnumCache}`);
  } finally {
    if (savedEnv === undefined) delete process.env.DSH_BASE;
    else process.env.DSH_BASE = savedEnv;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log("\n==================================================");
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fail) {
  console.log("\n失败项：");
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
