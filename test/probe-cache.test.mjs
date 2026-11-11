/**
 * dsh-prompt · 宿主定位的性能契约（Issue #8）
 *
 * 锁「外部探测的次数」，不锁墙钟。
 *
 * ── 为什么不用墙钟 ────────────────────────────────────────────
 * 本机实测 `commonDesktopInstallDirs({discover:true})` 在 3962~4732ms 波动（±20%），
 * 而它内部只有 3 次 PowerShell + 1331 次文件系统探测（后者合计仅 5ms）。
 * 毫秒断言换台机器就失效；「调用几次」稳定且与根因直接对应。
 *
 * ── 怎么数调用（关键约束）──────────────────────────────────────
 * `desktop.js` 用 `import { execFileSync } from "node:child_process"` 具名导入，
 * ESM 具名绑定只读，**无法从外部替换**。所以这里要求 desktop.js 自己暴露
 * 可观测的探测计数（probeStats / probeCacheState / setProbeClock）。
 *
 * 这同时是设计收益：探测次数从「不可见的副作用」变成「可断言的状态」。
 *
 * ── 根因（实测）──────────────────────────────────────────────
 * runningOfficialExecutables / shortcutOfficialExecutables / registryInstallDirs
 * 三处都是「空结果不缓存」：
 *     catch { return [] }                      // 失败不缓存
 *     if (result.length > 0) cached = result   // 只有非空才缓存
 * 本机三个探测全空（没装桌面版），于是每点一次「装宿主补丁」都重跑 4.7 秒 PowerShell。
 * `shortcutOfficialExecutables` 的 timeout 更是 15000ms —— 最坏能卡 15 秒。
 */

import path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const LIB = path.join(HERE, "..", "lib");

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

/**
 * 受前置条件守卫的断言块。
 * 条件不成立时**记一条失败**，不静默跳过 —— 静默跳过会让测试看起来很绿。
 */
function section(title, cond, fn) {
  console.log(`\n${title}`);
  if (!cond) {
    check(`${title} —— 前置条件不满足，本组断言未执行`, false, "前置条件缺失");
    return;
  }
  fn();
}

/** 让模块重新求值，清掉模块级缓存（cachedXxx 是模块级 let）。 */
function freshDesktop() {
  const url = pathToFileURL(path.join(LIB, "desktop.js")).href;
  return import(`${url}?t=${Date.now()}_${Math.random()}`);
}

const desktop = await freshDesktop();
const hasStats = typeof desktop.probeStats === "function";
const hasCacheState = typeof desktop.probeCacheState === "function";
const hasClock = typeof desktop.setProbeClock === "function";

// ═══════════════════════════════════════════════════════════════
console.log("\n[0] desktop.js 必须暴露可观测的探测计数");
// ═══════════════════════════════════════════════════════════════
check("导出 probeStats()", hasStats, `实际 ${typeof desktop.probeStats}`);
check("导出 probeCacheState()", hasCacheState, `实际 ${typeof desktop.probeCacheState}`);
check("导出 setProbeClock()（测试 TTL 用，不必真等）", hasClock,
  `实际 ${typeof desktop.setProbeClock}`);
if (!hasStats || !hasCacheState || !hasClock) {
  fail += 1;
  fails.push("缺少探测可观测接口 —— 后续断言不可执行");
  console.log("  ✗ 缺少可观测接口 —— 后续断言不可执行，计为失败");
}

// ═══════════════════════════════════════════════════════════════
section("[1] 空结果也必须缓存：第二次调用不许再 spawn", hasStats, () => {
  desktop.probeStats().reset?.();
  desktop.commonDesktopInstallDirs(process.env, { discover: true });
  const first = desktop.probeStats().spawns;
  desktop.commonDesktopInstallDirs(process.env, { discover: true });
  const second = desktop.probeStats().spawns;
  const delta = second - first;

  console.log(`       第一次累计 spawn ${first} 次，第二次调用后累计 ${second} 次（增量 ${delta}）`);
  check("第一次确实做过探测", first > 0, `first=${first}`);
  check(`第二次调用的 spawn 增量为 0（实测 +${delta}）`, delta === 0,
    `空结果没被缓存，第二次仍 spawn 了 ${delta} 次`);
});

// ═══════════════════════════════════════════════════════════════
section("[2] 缓存不得永久：必须带 TTL，且可观测", hasCacheState, () => {
  desktop.commonDesktopInstallDirs(process.env, { discover: true });
  const st = desktop.probeCacheState();
  const text = JSON.stringify(st);
  check("缓存状态里能看出 TTL / 过期信息", /ttl|expire|age|remaining/i.test(text),
    `state=${text.slice(0, 240)}`);
  check("区分「空结果」与「有结果」两类缓存",
    /empty|hit|miss|have|count/i.test(text), `state=${text.slice(0, 240)}`);
});

// ═══════════════════════════════════════════════════════════════
section("[3] TTL 到期后必须重新探测（客户端稍后启动仍能被发现）", hasStats && hasClock, () => {
  const stats = desktop.probeStats();
  stats.reset?.();
  let fake = 1_000_000;
  desktop.setProbeClock(() => fake);
  try {
    desktop.commonDesktopInstallDirs(process.env, { discover: true });
    const afterFirst = desktop.probeStats().spawns;
    // 把时钟推过 TTL
    fake += 10 * 60 * 1000;
    desktop.commonDesktopInstallDirs(process.env, { discover: true });
    const afterTtl = desktop.probeStats().spawns;
    check("TTL 到期后会重新探测", afterTtl > afterFirst,
      `afterFirst=${afterFirst} afterTtl=${afterTtl}`);
  } finally {
    desktop.setProbeClock(null);
  }
});

// ═══════════════════════════════════════════════════════════════
section("[4] 失败与空结果要分开记（失败可重试，空结果走 TTL）", hasCacheState, () => {
  desktop.commonDesktopInstallDirs(process.env, { discover: true });
  const st = desktop.probeCacheState();
  const entries = Array.isArray(st.entries) ? st.entries : [];
  const text = JSON.stringify(st);

  check("缓存条目带 kind 字段（区分 empty / failed）",
    entries.length === 0 || entries.every((e) => typeof e.kind === "string"),
    `entries=${text.slice(0, 200)}`);
  const src = readFileSync(path.join(LIB, "desktop.js"), "utf8");
  check("实现里定义了 failed 这一种类",
    /probeCacheSetFailed/.test(src) && /kind:\s*"failed"/.test(src),
    "desktop.js 里找不到 failed 分支");
  const failedEntries = entries.filter((e) => e.kind === "failed");
  check("本机探测成功时不该出现 failed 条目",
    failedEntries.length === 0, `failed=${JSON.stringify(failedEntries)}`);
});

// ═══════════════════════════════════════════════════════════════
section("[5] probeStats 必须可 JSON 序列化（状态页/HTTP 要发它）", hasStats, () => {
  const st = desktop.probeStats();
  let json = "";
  let threw = false;
  try { json = JSON.stringify(st); } catch { threw = true; }
  check("probeStats() 能被 JSON.stringify", !threw && json.length > 0,
    threw ? "序列化抛异常" : "空结果");

  // probeStats 里塞了 reset 方法。JSON 会静默丢掉函数属性 —— 这没问题，
  // 但必须确保**丢掉之后剩下的字段仍然完整**，别让状态页拿到半个对象。
  const round = JSON.parse(json);
  for (const k of ["spawns", "hits", "misses", "ttlMs"]) {
    check(`序列化后仍保留 ${k}`, k in round, `round=${json.slice(0, 160)}`);
  }
  check("entries 是数组（序列化后）", Array.isArray(round.entries),
    `entries=${JSON.stringify(round.entries).slice(0, 80)}`);
});

// ═══════════════════════════════════════════════════════════════
section("[6] spawns 的语义只统计「定位探测」，不含写文件探针", hasStats, () => {
  // desktop.js 里还有一个 execFileSync("cscript.exe", ...)，那是「写文件探针」
  // （验证目录可写），语义上不属于「定位探测」。它不进 spawns 是**有意的**，
  // 但要写进测试锁住，免得后来者以为是漏计数又给加回去。
  const src = readFileSync(path.join(LIB, "desktop.js"), "utf8");
  check("cscript 调用没有走 probeExec（有意为之）",
    /execFileSync\("cscript\.exe"/.test(src),
    "cscript 被包进了 probeExec，会把写文件探针算进定位统计");
  check("probeExec 只包装了三个 powershell 定位探测",
    (src.match(/probeExec\("powershell\.exe"/g) || []).length === 3,
    `实际 ${(src.match(/probeExec\("powershell\.exe"/g) || []).length} 处`);
});

// ═══════════════════════════════════════════════════════════════
section("[7] 时钟异常不许让缓存永不过期", hasStats && hasClock, () => {
  // 真实场景：NTP 校时 / 用户改系统时间 / 笔记本休眠唤醒都会让 Date.now 回拨。
  // 若不处理，缓存的 age 会是负数，永远小于 TTL —— 于是永不过期，
  // 正好犯下 we 要避免的那个错（客户端后启动却一直找不到）。
  desktop.resetProbeCache();
  desktop.clearDesktopLocateCache();
  let fake = Date.now() + 100000;
  desktop.setProbeClock(() => fake);
  try {
    desktop.commonDesktopInstallDirs(process.env, { discover: true });
    const afterFirst = desktop.probeStats().spawns;
    // 时钟回拨 5 分钟
    fake -= 300000;
    desktop.commonDesktopInstallDirs(process.env, { discover: true });
    const afterRewind = desktop.probeStats().spawns;
    check("时钟回拨后缓存按过期处理（会重新探测）", afterRewind > afterFirst,
      `afterFirst=${afterFirst} afterRewind=${afterRewind}`);

    // clock 返回 NaN 时同样按过期处理
    desktop.resetProbeCache();
    desktop.clearDesktopLocateCache();
    desktop.setProbeClock(() => NaN);
    desktop.commonDesktopInstallDirs(process.env, { discover: true });
    const a = desktop.probeStats().spawns;
    desktop.commonDesktopInstallDirs(process.env, { discover: true });
    const b = desktop.probeStats().spawns;
    check("clock 返回 NaN 时按过期处理（不会崩，也不永久缓存）", b >= a,
      `a=${a} b=${b}`);
  } finally {
    desktop.setProbeClock(null);
  }
});

console.log("\n==================================================");
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fail) {
  console.log("\n失败项：");
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
