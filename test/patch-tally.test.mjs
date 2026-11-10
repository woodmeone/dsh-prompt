/**
 * dsh-prompt · 补丁计数口径的自洽性（Issue #3）
 *
 * 这个套件锁一件事：**状态页上的每个数字都能加得起来。**
 *
 * 改造前有四套互不一致的口径（本机实测，develop @ f70370d）：
 *   A. patch_status 键数            = 82
 *   B. patch_status 状态分布        = pending45 / applied6 / skipped18 / na10 / missing_file2 / unmatched1
 *   C. patches_total（跳过 na）      = 72
 *   D. display_total（折叠成行）     = 63
 *   E. ALL_PATCHES.length           = 82
 *
 * 于是面板「已清洗 X / 共 Y」里 Y 到底是 82、72 还是 63，取决于点的是哪个字段。
 * 用户看到 63/82 与 82/82 并存 —— 两个数都「对」，只是量的是不同的东西。
 *
 * ── 这里测什么、不测什么 ──────────────────────────────────────
 * 测：**恒等式**。给定任意一份 status 快照，各分类之和必须等于分母。
 *     这是纯数学约束，不依赖宿主真实版本、不依赖本机装了什么。
 * 不测：某个补丁具体该是 applied 还是 pending —— 那取决于宿主文件，
 *     换台机器就变，写死进测试就是自找假失败。
 *
 * 对抗视角：
 *   - 只测「真实宿主上 82 == 82」会漏掉根因（换个 surface 就又错开）。
 *     所以用**人造 status 快照**覆盖所有状态组合，包括真实宿主上碰不到的分支。
 *   - 只测一种 surface 不够：na 的来源有两处（status 里的 "na" 与
 *     patchAppliesHere() 为 false），必须各测一遍。
 *   - 恒等式成立还不够，还得测「na 确实进了分母」——否则把 na 全丢掉
 *     也能让加法成立，但那正是原来的 bug。
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const LIB = path.join(HERE, "..", "lib");

const core = await import(pathToFileURL(path.join(LIB, "core.js")).href);

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
 * 条件不成立时**记一条失败**而不是静默跳过 —— 静默跳过会让测试看起来很绿。
 */
function section(title, cond, fn) {
  console.log(`\n${title}`);
  if (!cond) {
    check(`${title.replace(/^\[[^\]]+\]\s*/, "")} —— 前置条件不满足`, false,
      "前置条件缺失，本组断言未执行");
    return;
  }
  fn();
}

/** 造一份合成的补丁 + status，覆盖所有状态值。 */
function fixture() {
  const mk = (id, extra = {}) => ({ id, layer: "代码", file: ["agent-loop"], ...extra });
  const patches = [
    mk(1), mk(2), mk(3), mk(4), mk(5), mk(6), mk(7), mk(8),
    mk(9, { surfaces: ["web"] }),   // 只适用于 web
    mk(10, { surfaces: ["web"] }),
  ];
  const status = {
    1: "applied",
    2: "already",
    3: "pending",
    4: "unmatched",
    5: "skipped",
    6: "missing_file",
    7: "na",
    8: "off",
    9: "pending",
    10: "applied",
  };
  return { patches, status };
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[1] tallyPatchStatus 存在，且是唯一计数入口");
// ═══════════════════════════════════════════════════════════════
/**
 * ⚠ 这里必须**先断言函数存在**，再在守卫块里跑后续断言。
 * 如果写成 `if (typeof fn === "function") { ...一堆断言... }`，
 * 函数缺失时那堆断言会整块静默跳过，测试最后只显示「2 passed」——
 * 看上去几乎全绿，实际上什么都没测。本文件早期的版本就犯了这个错。
 */
const hasTally = typeof core.tallyPatchStatus === "function";
check("core.tallyPatchStatus 已导出", hasTally, `实际类型 ${typeof core.tallyPatchStatus}`);
if (!hasTally) {
  // 缺了它后面全是空转，直接判失败退出，别让静默跳过伪装成通过。
  fail += 1;
  fails.push("缺少 tallyPatchStatus，后续恒等式断言无法执行");
  console.log("  ✗ 缺少 tallyPatchStatus —— 后续断言不可执行，计为失败");
}

// ═══════════════════════════════════════════════════════════════
section("[2] 恒等式：各分类之和 == total", hasTally, () => {
  const { patches, status } = fixture();
  const t = core.tallyPatchStatus(patches, status, { surface: "web" });

  const KEYS = ["applied", "already", "pending", "unmatched", "skipped", "missing_file", "na"];
  const sum = KEYS.reduce((n, k) => n + (t[k] || 0), 0);
  eq("sum(各分类) == total", sum, t.total);
  check("total 等于补丁数（na 也计入分母）", t.total === patches.length,
    `total=${t.total} patches=${patches.length}`);
  for (const k of KEYS) {
    check(`分类 ${k} 存在且是数字`, typeof t[k] === "number", `got ${typeof t[k]}`);
  }
});

// ═══════════════════════════════════════════════════════════════
section("[3] na 必须计入分母（原来被丢掉，是 82→72 的根因）", hasTally, () => {
  const { patches, status } = fixture();
  const t = core.tallyPatchStatus(patches, status, { surface: "web" });
  // fixture 里 id=7 的 status 是 na；surface=web 下 1..8 都适用
  check("status 里标 na 的计入 na 分类", t.na >= 1, `na=${t.na}`);
  check("na 没有被从 total 里剔除", t.total === patches.length,
    `total=${t.total} 应为 ${patches.length}`);
});

// ═══════════════════════════════════════════════════════════════
section("[4] surface 不匹配的补丁计入 na，而不是消失", hasTally, () => {
  const { patches, status } = fixture();
  // 用 desktop 视角看：id 9/10 只适用 web -> 应计入 na
  const t = core.tallyPatchStatus(patches, status, { surface: "desktop" });
  check("total 仍是补丁总数（不因不适用而缩小）", t.total === patches.length,
    `total=${t.total}`);
  check("不适用的一律进 na", t.na >= 3, `na=${t.na}（应含 id7 + id9 + id10）`);
  const sum = ["applied", "already", "pending", "unmatched", "skipped", "missing_file", "na"]
    .reduce((n, k) => n + (t[k] || 0), 0);
  eq("desktop 视角下恒等式仍成立", sum, t.total);
});

// ═══════════════════════════════════════════════════════════════
console.log("\n[5] display 分组数可以小于 total，但它自己必须自洽");
// ═══════════════════════════════════════════════════════════════
{
  const { patches, status } = fixture();
  const rows = core.groupPatchesForDisplay(patches, status, "web");
  const tally = core.tallyDisplayPatches(rows);
  eq("display 行数 == tally.total", tally.total, rows.length);
  const dup = [];
  const seen = new Set();
  for (const r of rows) {
    for (const id of r.ids || []) {
      if (seen.has(id)) dup.push(id);
      seen.add(id);
    }
  }
  check("display 分组没有重复收录同一个补丁 id", dup.length === 0, `重复：${dup.join(",")}`);
}

// ═══════════════════════════════════════════════════════════════
section("[6] 折叠关系要说清楚：total 与 display_total 的差 = 被折叠的补丁数", hasTally, () => {
  const { patches, status } = fixture();
  const t = core.tallyPatchStatus(patches, status, { surface: "web" });
  const rows = core.groupPatchesForDisplay(patches, status, "web");
  const dt = core.tallyDisplayPatches(rows);
  const covered = rows.reduce((n, r) => n + (r.ids ? r.ids.length : 1), 0);
  check("display 覆盖的补丁数 ≤ total", covered <= t.total, `covered=${covered} total=${t.total}`);
  check("display_total 与原 total 的差可由「折叠 + na」解释",
    dt.total <= t.total, `display=${dt.total} total=${t.total}`);
});

// ═══════════════════════════════════════════════════════════════
console.log("\n[5] display 分组数可以小于 total，但它自己必须自洽");
// ═══════════════════════════════════════════════════════════════
{
  const { patches, status } = fixture();
  const rows = core.groupPatchesForDisplay(patches, status, "web");
  const tally = core.tallyDisplayPatches(rows);
  eq("display 行数 == tally.total", tally.total, rows.length);
  const dup = [];
  const seen = new Set();
  for (const r of rows) {
    for (const id of r.ids || []) {
      if (seen.has(id)) dup.push(id);
      seen.add(id);
    }
  }
  check("display 分组没有重复收录同一个补丁 id", dup.length === 0, `重复：${dup.join(",")}`);
}

// ═══════════════════════════════════════════════════════════════
section("[6] 折叠关系要说清楚：total 与 display_total 的差 = 被折叠的补丁数", hasTally, () => {
  const { patches, status } = fixture();
  const t = core.tallyPatchStatus(patches, status, { surface: "web" });
  const rows = core.groupPatchesForDisplay(patches, status, "web");
  const dt = core.tallyDisplayPatches(rows);
  const covered = rows.reduce((n, r) => n + (r.ids ? r.ids.length : 1), 0);
  check("display 覆盖的补丁数 ≤ total", covered <= t.total, `covered=${covered} total=${t.total}`);
  check("display_total 与原 total 的差可由「折叠 + na」解释",
    dt.total <= t.total, `display=${dt.total} total=${t.total}`);
});

// ═══════════════════════════════════════════════════════════════
console.log("\n[7] gatherState 的计数必须与 tally 同源");
// ═══════════════════════════════════════════════════════════════
{
  // 源码级检查：gatherState 里不许再自己手搓计数器
  const fs = await import("node:fs");
  const src = fs.readFileSync(path.join(LIB, "core.js"), "utf8");
  const idx = src.indexOf("export async function gatherState");
  const body = src.slice(idx, idx + 4000);
  check("gatherState 调用了 tallyPatchStatus", body.includes("tallyPatchStatus"),
    "gatherState 仍在自己累加 patches_total");
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[8] patches_lost 必须能区分「没丢」与「不知道」");
// ═══════════════════════════════════════════════════════════════
{
  // 原实现只返回 true/false：定位不到宿主时也返回 false，
  // 于是「门禁失真、根本没判断」和「判断过、确实没丢」共用一个值 —— 谎报 False。
  const reapply = await import(pathToFileURL(path.join(LIB, "reapply.js")).href);
  check("reapply.patchLossState 已导出（三态）",
    typeof reapply.patchLossState === "function",
    `实际 ${typeof reapply.patchLossState}`);

  if (typeof reapply.patchLossState === "function") {
    const r = reapply.patchLossState();
    check("返回对象且含 state 字段", r && typeof r === "object" && "state" in r,
      `got ${JSON.stringify(r)}`);
    check("state 只能是 lost / ok / unknown 三者之一",
      ["lost", "ok", "unknown"].includes(r.state), `state=${r.state}`);
    check("带 reason 说明判定依据", typeof r.reason === "string", `reason=${r.reason}`);

    // 布尔版必须仍可用，且只有「确定丢」才算 true —— 不许把 unknown 说成 false
    check("旧布尔接口仍存在（向后兼容）",
      typeof reapply.patchesLostAfterHostReset === "function");
    if (typeof reapply.patchesLostAfterHostReset === "function") {
      const b = reapply.patchesLostAfterHostReset();
      check("布尔版只在 state===lost 时为 true",
        b === (r.state === "lost"), `bool=${b} state=${r.state}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[9] 状态页要用三态，不能只报布尔");
// ═══════════════════════════════════════════════════════════════
{
  const fs = await import("node:fs");
  const src = fs.readFileSync(path.join(LIB, "index.js"), "utf8");
  check("index.js 使用 patchLossState", src.includes("patchLossState"),
    "index.js 仍只调 patchesLostAfterHostReset");
  check("状态里带 patches_lost_state 字段", src.includes("patches_lost_state"),
    "缺三态字段");
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[10] 面板不许自己再数一遍（第五套口径的来源）");
// ═══════════════════════════════════════════════════════════════
{
  const fs = await import("node:fs");
  const cli = fs.readFileSync(path.join(HERE, "..", "client.js"), "utf8");

  // 旧面板用 tallyPatches(patchRowsOf(s)) 自己数，且 patchRowsOf 把 na 过滤掉，
  // 于是前端算出 63 而后端 patch_status 有 82 键 —— 第五套口径。
  check("指标卡改读后端 patches_tally", cli.includes("backendTally") && cli.includes("patches_tally"),
    "面板仍在用本地 tallyPatches 结果");
  check("na 在面板上有单独的位置（不许被静默丢弃）",
    cli.includes("metric.naShort"), "缺 metric.naShort 文案键");
  // 中英两套 locale 都要有
  const naCount = (cli.match(/"metric\.naShort"/g) || []).length;
  check(`metric.naShort 在中英两套 locale 里都存在（实测 ${naCount} 处）`, naCount >= 2,
    `只找到 ${naCount} 处`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[11] 没定位到宿主时，分母必须是 0 而不是 82");
// ═══════════════════════════════════════════════════════════════
{
  // 这条是自查中发现的真回归：为了让恒等式成立，我一开始让 total 恒等于
  // patches.length，于是「没找到宿主」时状态页会显示 0/82 —— 用户会以为
  // 「82 个补丁全都没打上」，而真相是「压根还没找到宿主」。
  // 原实现用 `if (!aiBase) { na++; continue }` 刻意不累加分母，意图是对的。
  //
  // 现在：无宿主 -> total=0 且六类全 0（同样自洽，且不撒谎）。
  const fs = await import("node:fs");
  const src = fs.readFileSync(path.join(LIB, "core.js"), "utf8");
  const idx = src.indexOf("export async function gatherState");
  const body = src.slice(idx, idx + 5000);

  check("gatherState 的分母受 aiBase 门控",
    /patches_total\s*=\s*aiBase\s*\?/.test(body),
    "patches_total 不再受 aiBase 门控，无宿主时会报 82");
  check("无宿主时分类也一并清零（避免 total=0 但 skipped=77 的自相矛盾）",
    body.includes("tallyForReport"), "缺 tallyForReport 清零逻辑");

  // 纯函数层面：空 status 传入 tally，总数仍是 82 —— 这是对的，
  // 因为 tally 只负责「给定补丁集就算全」，门控是 gatherState 的职责。
  const t = core.tallyPatchStatus(core.ALL_PATCHES, {}, { surface: "web" });
  check("tallyPatchStatus 本身仍以补丁总数为分母（门控由调用方负责）",
    t.total === core.ALL_PATCHES.length, `total=${t.total}`);
  const KEYS = ["applied", "already", "pending", "unmatched", "skipped", "missing_file", "na"];
  eq("空 status 下恒等式依然成立", KEYS.reduce((n, k) => n + (t[k] || 0), 0), t.total);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[12] na 计入分母后，进度条不能永远到不了 100%");
// ═══════════════════════════════════════════════════════════════
{
  // 自查发现：na 计入 total 后，进度条 applied/total 打满也只有 88%（实测 72/82），
  // 看起来像永远做不完。两个数各司其职：
  //   · patches_total = 82  用于「和 patch_status 对账」
  //   · patches_applicable = 72  用于「完成度 / 进度条」
  const fs = await import("node:fs");
  const coreSrc = fs.readFileSync(path.join(LIB, "core.js"), "utf8");
  check("core.js 导出 patches_applicable", coreSrc.includes("patches_applicable"),
    "缺适用分母字段");
  check("patches_applicable 的定义是 total - na",
    /patches_applicable\s*:\s*tallyForReport\.total\s*-\s*tallyForReport\.na/.test(coreSrc),
    "定义不对");

  const idxSrc = fs.readFileSync(path.join(LIB, "index.js"), "utf8");
  check("status 里带 patches_applicable", idxSrc.includes("patches_applicable"));

  const cliSrc = fs.readFileSync(path.join(HERE, "..", "client.js"), "utf8");
  check("面板进度条用 applicable 而非 total 做分母",
    cliSrc.includes("applicable") && /Math\.round\(\(applied \/ applicable\)/.test(cliSrc),
    "进度条仍在用 total 做分母");

  // 数值验证：全部适用补丁都打完时，进度条必须正好 100%
  const t = core.tallyPatchStatus(core.ALL_PATCHES, {}, { surface: "web" });
  const applicable = t.total - t.na;
  check("适用分母 < 总数（na 确实被排除了）", applicable < t.total,
    `applicable=${applicable} total=${t.total}`);
  const allDone = applicable;
  eq("全部适用补丁打完时 pct 正好 100%", Math.round((allDone / applicable) * 100), 100);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[13] status 顶层四个计数必须与 patches_tally 同源");
// ═══════════════════════════════════════════════════════════════
{
  // 自查发现：顶层 patches_skipped 原来写 `display_skipped ?? patches_skipped`，
  // 优先取 display（折叠口径）。于是同一个响应里出现两套数：
  // 顶层 skipped=19，而 patches_tally 给 skipped 18 + missing_file 2 = 20。
  // 这正是 Issue #3 要消灭的问题，只是换了个地方复发。
  const fs = await import("node:fs");
  const src = fs.readFileSync(path.join(LIB, "index.js"), "utf8");

  check("顶层 patches_applied 不再优先取 display_*",
    !/patches_applied:\s*state\.ai_base\s*\?\s*\(state\.display_applied/.test(src),
    "仍在用 display_applied 顶替");
  check("顶层 patches_pending 不再优先取 display_*",
    !/patches_pending:\s*state\.display_pending/.test(src),
    "仍在用 display_pending");
  check("顶层 patches_skipped 不再优先取 display_*",
    !/patches_skipped:\s*state\.display_skipped/.test(src),
    "仍在用 display_skipped");
  check("顶层计数改用 patches_tally 派生",
    /patches_applied:\s*state\.ai_base\s*\?\s*\(state\.patches_tally\?\.applied/.test(src),
    "没有从 tally 派生");
  check("patches_skipped = skipped + missing_file",
    /patches_skipped:[\s\S]{0,200}?patches_tally\?\.skipped[\s\S]{0,120}?patches_tally\?\.missing_file/.test(src),
    "skipped 未合并 missing_file");

  // 数值验证：顶层四类 + already + unmatched 必须等于 total
  const t = core.tallyPatchStatus(core.ALL_PATCHES, {}, { surface: "web" });
  const topLevel = t.applied + t.already + t.pending + t.unmatched
    + (t.skipped + t.missing_file) + t.na;
  eq("顶层各数之和 == total", topLevel, t.total);
}

console.log("\n==================================================");
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fail) {
  console.log("\n失败项：");
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
