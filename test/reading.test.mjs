/**
 * dsh-prompt · 块表读数契约（票1）
 *
 * 这个套件的立场：**装配在每轮对话的同步路径上，读盘次数是契约不是实现细节。**
 *
 * 为什么要专门锁「读几次」：
 *   改造前 assemble() 对每个块都重新 readJson(config.json)，300 块时单次装配
 *   读 206 次盘、耗时 90ms，而它跑在宿主组装 systemPrompt 的同步调用栈里。
 *   这类退化不会抛异常、不会让测试变红，只会让用户觉得「插件变卡了」。
 *   所以必须用可断言的数字把它钉住。
 *
 * 对抗视角（写这个文件的自我审查）：
 *   - 只数 config.json 会不会漏掉正文重复读？→ 同时数 .md 读的次数。
 *   - 数调用次数会不会因为实现换写法就失效？→ 这是刻意的：读盘次数本就是契约。
 *   - 光数次数不够，还要证明结果没变 → 同套件里做改造前后等价性断言（用固定期望值，
 *     不从被测代码反推，避免同义反复）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const LIB = path.join(HERE, "..", "lib");
const PLUGIN_DIR = path.join(HERE, "..");

const blocks = await import(pathToFileURL(path.join(LIB, "prompt-blocks.js")).href);

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
 * 建一个隔离 home，块表换成指定数量的**自建块**。
 *
 * 注意：loadConfig 会把内建默认块补回来（「默认块不可删」在数据层也成立），
 * 所以装配结果 = n 个自建块 + 5 个默认开启的 top 块（core-routing 默认关）。
 * 断言时不能指望 parts === n，要按 id 前缀筛。
 */
function makeHome(nBlocks) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-reading-"));
  blocks.seedBlocks(home, PLUGIN_DIR);
  if (nBlocks === null) return home;
  const root = path.join(home, "dsh-prompt");
  const list = Array.from({ length: nBlocks }, (_, i) => ({
    id: `b${i}`, name: `块${i}`, order: i * 100, enabled: true, slots: ["top"], role: "system",
  }));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ blocks: list }, null, 2));
  for (let i = 0; i < nBlocks; i += 1) {
    fs.writeFileSync(path.join(root, "blocks", `b${i}.md`), `内容${i}\n`);
  }
  return home;
}

/** 只数自建块（b 前缀）。 */
const customCount = (parts) => parts.filter((p) => /^b\d+$/.test(p.id)).length;

/** 数指定类型的读盘次数，跑一次 fn。 */
function countReads(fn) {
  let config = 0, md = 0;
  const orig = fs.readFileSync;
  fs.readFileSync = function (fp, ...rest) {
    const s = String(fp);
    if (s.endsWith("config.json")) config += 1;
    else if (s.endsWith(".md")) md += 1;
    return orig.call(this, fp, ...rest);
  };
  try {
    return { ...fn(), config, md };
  } finally {
    fs.readFileSync = orig;
  }
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[1] 装配：config.json 读盘次数与块数无关，恒为 1");
// ═══════════════════════════════════════════════════════════════
for (const n of [1, 7, 30, 100, 300]) {
  const home = makeHome(n);
  const r = countReads(() => {
    const a = blocks.assembleTop(home);
    return { parts: a.parts };
  });
  check(`${String(n).padStart(3)} 块：config.json 只读 1 次（实测 ${r.config}）`, r.config === 1,
    `读盘 ${r.config} 次`);
  check(`${String(n).padStart(3)} 块：自建块全部装配到`, customCount(r.parts) === n,
    `装配到 ${customCount(r.parts)} 个自建块`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[2] 装配：每个块的正文只读 1 次");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome(30);
  const r = countReads(() => blocks.assembleTop(home));
  // 快照要把块表里每块的正文读到（装配只取其中启用的子集），
  // 所以上界按「块表总数」算，不是按「装配到几个」。每块最多 2 次试探（override 未命中 + blocks/）。
  const total = blocks.loadConfig(home).blocks.length;
  const p = blocks.assembleTop(home).parts.length;
  check(`块表 ${total} 块、装配 ${p} 个 => .md 读 ${r.md} 次（≤ 2×${total}）`,
    r.md <= total * 2, `实际 ${r.md} 次`);
  console.log(`       （对照：改造前每次都要额外读 config.json，300 块时累计 306 次）`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[3] describe()：正文不重复读");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome(30);
  const r = countReads(() => blocks.describe(home));
  // describe 要列全部块（含尾部/关闭的）。每块正文只该读一次（override 未命中时多一次试探）。
  const total = blocks.loadConfig(home).blocks.length;
  check(`describe 列 ${total} 块 => .md 读 ${r.md} 次（≤ 2P，改造前 73）`, r.md <= total * 2, `实际 ${r.md} 次`);
  check(`describe 的 config.json 只读 1 次（改造前 76 次）`, r.config === 1, `实际 ${r.config} 次`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[4] 性能：装配耗时随块数线性增长，不是二次方");
// ═══════════════════════════════════════════════════════════════
{
  // 不写死毫秒阈值（换机器就失效）。改成断言语义：块数翻 N 倍，耗时不许涨 N² 倍。
  const measure = (n) => {
    const home = makeHome(n);
    for (let i = 0; i < 3; i += 1) blocks.assembleTop(home); // 预热
    const rounds = 10;
    const t0 = performance.now();
    for (let i = 0; i < rounds; i += 1) blocks.assembleTop(home);
    return (performance.now() - t0) / rounds;
  };
  const small = measure(20);
  const big = measure(200);
  const ratio = big / Math.max(small, 0.001);
  // 线性应约 10 倍（块数也约 10 倍）；二次方会是 ~100 倍。给足余量取 30。
  check(`200 块 / 20 块 耗时比 ${ratio.toFixed(1)} ≤ 30（线性而非二次）`, ratio <= 30,
    `20 块 ${small.toFixed(2)}ms, 200 块 ${big.toFixed(2)}ms`);

  // 绝对上界也留一条，但放宽到 25ms —— 只为抓住「又变成每块读一次 config」的重大退化。
  const home300 = makeHome(300);
  for (let i = 0; i < 3; i += 1) blocks.assembleTop(home300);
  const t0 = performance.now();
  for (let i = 0; i < 10; i += 1) blocks.assembleTop(home300);
  const avg300 = (performance.now() - t0) / 10;
  check(`300 块单次装配 ${avg300.toFixed(2)}ms ≤ 25ms（改造前 90ms）`, avg300 <= 25,
    `实测 ${avg300.toFixed(2)}ms`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[5] 等价性：快照路径与逐块读路径产出完全相同（防止优化改坏语义）");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome(5);
  const root = path.join(home, "dsh-prompt");
  // 造三种来源：inline > override > default，验证快照没把优先级读错
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  cfg.blocks[0].content = "内联正文-inline";           // b0 -> inline
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(cfg, null, 2));
  fs.mkdirSync(path.join(root, "overrides"), { recursive: true });
  fs.writeFileSync(path.join(root, "overrides", "b1.md"), "覆盖正文-override"); // b1 -> override
  // b2 保持 default

  const a = blocks.assembleTop(home, { withText: true });
  const byId = Object.fromEntries(a.parts.map((p) => [p.id, p.source]));
  eq("b0 来源是 inline", byId.b0, "inline");
  eq("b1 来源是 override", byId.b1, "override");
  eq("b2 来源是 default", byId.b2, "default");

  // 正文内容必须逐字对得上
  const texts = Object.fromEntries(a.parts.map((p) => [p.id, p.text]));
  eq("b0 正文是内联那份", texts.b0, "内联正文-inline");
  eq("b1 正文是 override 那份", texts.b1, "覆盖正文-override");

  // 自建块的相对顺序 = order 升序（默认块会插进来，只看自建块的子序列）
  const customOrder = a.parts.map((p) => p.id).filter((id) => /^b\d+$/.test(id));
  eq("自建块按 order 升序", customOrder.join(","), "b0,b1,b2,b3,b4");
  // 全局顺序必须严格按 order 单调不减
  const orders = a.parts.map((p) => blocks.describe(home).blocks.find((b) => b.id === p.id)?.order ?? 0);
  check("装配顺序全局按 order 单调不减", orders.every((v, i) => i === 0 || orders[i - 1] <= v),
    JSON.stringify(orders));
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[6] 空 override 仍是有效状态（快照不许把空串当没读到）");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome(3);
  const root = path.join(home, "dsh-prompt");
  fs.mkdirSync(path.join(root, "overrides"), { recursive: true });
  fs.writeFileSync(path.join(root, "overrides", "b1.md"), ""); // 空文件
  const c = blocks.readBlockContent(home, "b1");
  eq("空 override 来源仍是 override", c.source, "override");
  eq("空 override 正文是空串", c.text, "");
  const a = blocks.assembleTop(home);
  check("空 override 的块不进装配（跳过空块）", !a.parts.some((p) => p.id === "b1"));
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[7] 只读纪律：孤立态仍不抛（快照改造不许破坏这条）");
// ═══════════════════════════════════════════════════════════════
{
  // 目录根本不存在
  const ghost = path.join(os.tmpdir(), `dsh-prompt-ghost-${Date.now()}`);
  let threw = false;
  try { blocks.assembleTop(ghost); } catch { threw = true; }
  check("home 不存在时不抛", !threw);

  // config 是目录
  const h2 = makeHome(null);
  const root2 = path.join(h2, "dsh-prompt");
  fs.rmSync(path.join(root2, "config.json"), { force: true });
  fs.mkdirSync(path.join(root2, "config.json"), { recursive: true });
  threw = false;
  try { blocks.assembleTop(h2); } catch { threw = true; }
  check("config.json 是目录时不抛", !threw);

  // 块文件是目录
  const h3 = makeHome(3);
  const root3 = path.join(h3, "dsh-prompt");
  fs.rmSync(path.join(root3, "blocks", "b1.md"), { force: true });
  fs.mkdirSync(path.join(root3, "blocks", "b1.md"), { recursive: true });
  threw = false;
  try { blocks.assembleTop(h3); } catch { threw = true; }
  check("块文件是目录时不抛", !threw);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[8] 快照必须反映当次磁盘状态（不许拿陈旧缓存骗人）");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome(3);
  const root = path.join(home, "dsh-prompt");
  const before = blocks.assembleTop(home, { withText: true }).parts.find((p) => p.id === "b0").text;
  eq("改之前是旧正文", before, "内容0");
  fs.writeFileSync(path.join(root, "blocks", "b0.md"), "改过的正文");
  const after = blocks.assembleTop(home, { withText: true }).parts.find((p) => p.id === "b0").text;
  eq("改之后立刻读到新正文", after, "改过的正文");

  // 块表也必须是当次的
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  cfg.blocks[0].enabled = false;
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(cfg, null, 2));
  check("关掉 b0 后立刻不在装配", !blocks.assembleTop(home).parts.some((p) => p.id === "b0"));
}

console.log("\n==================================================");
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fail) {
  console.log("\n失败项：");
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
