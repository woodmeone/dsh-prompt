/**
 * dsh-prompt · 预设注册链验证
 *
 * 复现并钉死「redteam 预设建不了会话」这条故障链。
 *
 * 现场根因（2026-10-18，从 dsh-purge 换装到 dsh-prompt）：
 *   profile 的 cordis.patch.yml 写着 `selectedDefault: redteam`，
 *   但 cordis.yml 里只声明了 standard / ptc / minimal / cordis 四个预设；
 *   redteam 唯一来源是插件运行期 `ctx.agentPresets.register()`。
 *   换装时这组接线漏了 → resolve('redteam') 抛 not-found → 新建会话失败。
 *
 * 本测试用**假 registry**（复刻真 register 的语义）跑完整链路：
 *   读磁盘预设 → 改包名 → register → resolve
 * 全部在隔离 $DSH_HOME 里，不碰真实 ~/.dsh。
 *
 * node test/preset-declare.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PLUGIN_DIR = path.join(HERE, "..");
const REDTEAM = path.join(PLUGIN_DIR, "lib", "redteam");

const composition = await import(pathToFileURL(path.join(REDTEAM, "preset-composition.js")).href);
const redteamIndex = await import(pathToFileURL(path.join(REDTEAM, "index.js")).href);
const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "package.json"), "utf8"));
const patchYml = fs.readFileSync(path.join(PLUGIN_DIR, "cordis.patch.yml"), "utf8");

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); return; }
  fail += 1; fails.push(`${name}${detail ? " — " + detail : ""}`);
  console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-preset-"));
const HOME = path.join(TMP, ".dsh");
fs.mkdirSync(HOME, { recursive: true });
process.env.DSH_HOME = HOME;

// ── 1. 包清单必须导出演练台子路径 ──────────────────────────────
console.log("\n[1] package.json 导出演练台子路径");
{
  const want = ["./redteam", "./redteam/store", "./redteam/ui", "./redteam/tools"];
  for (const key of want) {
    const target = pkg.exports?.[key];
    check(`exports 有 ${key}`, typeof target === "string", `got ${JSON.stringify(target)}`);
    if (typeof target === "string") {
      const abs = path.join(PLUGIN_DIR, target.replace(/^\.\//, ""));
      check(`${key} 指向的文件真实存在`, fs.existsSync(abs), target);
    }
  }
  check("包名是 dsh-prompt", pkg.name === "dsh-prompt", pkg.name);
}

// ── 2. patch 层必须挂上三条演练台行 ────────────────────────────
console.log("\n[2] cordis.patch.yml 挂载演练台行");
{
  for (const id of ["dsh-prompt-redteam", "dsh-prompt-redteam-store", "dsh-prompt-redteam-ui"]) {
    check(`patch 里有 ${id}`, patchYml.includes(`- id: ${id}`), "缺这行则预设无人注册");
  }
  check("redteam 预设行名对得上", patchYml.includes("name: dsh-prompt/redteam"));
  check("store 行名对得上", patchYml.includes("name: dsh-prompt/redteam/store"));
  check("ui 行名对得上", patchYml.includes("name: dsh-prompt/redteam/ui"));
  check("没有残留 dsh-purge 行", !patchYml.includes("name: dsh-purge/"), "旧包名会让工具行指向未挂载的包");
}

// ── 3. 干净安装：预设落地 + 工具行是当前包名 ────────────────────
console.log("\n[3] 干净安装：预设落地");
{
  const r = redteamIndex.installPreset({ log: () => {} });
  check("动作是 installed", r.action === "installed", r.action);
  const file = path.join(HOME, ".agent-presets", "redteam", "agent.cordis.yml");
  check("预设文件已落地", fs.existsSync(file));
  check("anchor-gate.mjs 已落地", fs.existsSync(path.join(HOME, ".agent-presets", "redteam", "anchor-gate.mjs")));
  check("随包技能已落地", r.skills > 0, `skills=${r.skills}`);

  const def = composition.readPresetDefinition("redteam", path.dirname(file));
  check("id = redteam", def.id === "redteam", def.id);
  check("plugins 非空", Array.isArray(def.plugins) && def.plugins.length > 0, `${def.plugins?.length}`);
  const toolRow = def.plugins.find((p) => p.id === "redteam-tools");
  check("有 redteam-tools 行", !!toolRow);
  check("工具行包名 = dsh-prompt/redteam/tools", toolRow?.name === "dsh-prompt/redteam/tools", toolRow?.name);
  check("工具行不再指向 dsh-purge", !String(toolRow?.name || "").includes("dsh-purge"), toolRow?.name);
}

// ── 4. 自愈：旧包名（dsh-purge）就地改写成新名 ──────────────────
console.log("\n[4] 自愈：旧包名就地改写");
{
  const file = path.join(HOME, ".agent-presets", "redteam", "agent.cordis.yml");
  // 制造"换装遗留"现场
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/dsh-prompt\/redteam\/tools/g, "dsh-purge/redteam/tools"), "utf8");
  const r = redteamIndex.installPreset({ log: () => {} });
  check("动作是 repaired", r.action === "repaired", r.action);
  check("repaired 含 tools-package", String(r.repaired || "").includes("tools-package"), r.repaired);
  const text = fs.readFileSync(file, "utf8");
  check("工具行已改成 dsh-prompt/redteam/tools", text.includes("name: dsh-prompt/redteam/tools"));
  check("旧名已绝迹", !text.includes("dsh-purge/redteam/tools"));

  // 再跑一次：幂等，不再改写
  const r2 = redteamIndex.installPreset({ log: () => {} });
  check("再跑幂等（不再 repaired by tools）", !String(r2.repaired || "").includes("tools-package"), r2.repaired);
}

// ── 5. 三种旧包名都要被改写 ────────────────────────────────────
console.log("\n[5] 三种历史包名都要改写");
{
  const file = path.join(HOME, ".agent-presets", "redteam", "agent.cordis.yml");
  for (const stale of ["dsh-redteam-mode/tools", "dsh-purge/redteam/tools"]) {
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/name: dsh-prompt\/redteam\/tools/g, `name: ${stale}`), "utf8");
    redteamIndex.installPreset({ log: () => {} });
    const text = fs.readFileSync(file, "utf8");
    check(`自愈 ${stale}`, text.includes("name: dsh-prompt/redteam/tools") && !text.includes(stale), stale);
  }
}

// ── 6. 注册链：register → resolve（假 registry，复刻真语义）──────
console.log("\n[6] 注册链端到端（假 registry）");
{
  // 复刻真 AgentPresetRegistry 的关键语义：
  //   · 重复 id → 抛 "Duplicate agent preset: <id>"
  //   · resolve 只认已注册的 id，否则抛 not-found
  //   · default 取 selectedDefault ?? default
  class FakeRegistry {
    constructor(config) { this.definitions = new Map(); this.config = config; }
    get defaultId() { return this.config.selectedDefault ?? this.config.default; }
    async register(definition) {
      if (!definition.id.trim()) throw new Error("Preset id must not be empty");
      if (this.definitions.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`);
      this.definitions.set(definition.id, { config: definition });
      return async () => { this.definitions.delete(definition.id); };
    }
    async list() { return [...this.definitions.values()].map((r) => ({ id: r.config.id, name: r.config.name })); }
    async resolve(id) {
      const wanted = id ?? this.defaultId;
      if (!this.definitions.has(wanted)) throw new Error(`Unknown agent preset: ${wanted}`);
      return { id: wanted };
    }
  }

  // 模拟 profile：只声明 4 个官方预设，selectedDefault 指向 redteam
  const registry = new FakeRegistry({ default: "standard", selectedDefault: "redteam" });
  for (const id of ["standard", "ptc", "minimal", "cordis"]) await registry.register({ id, plugins: [] });

  // ← 修复前：这一步没人做，于是 resolve('redteam') 抛 not-found
  const dir = path.join(HOME, ".agent-presets", "redteam");
  const def = composition.readPresetDefinition("redteam", dir);
  await registry.register(def);

  const resolved = await registry.resolve();
  check("默认 preset 解析成功", resolved.id === "redteam", resolved.id);
  check("默认 id 就是 redteam", registry.defaultId === "redteam", registry.defaultId);
  const roster = await registry.list();
  check("名册里有 redteam", roster.some((r) => r.id === "redteam"), roster.map((r) => r.id).join(","));

  // 重复注册必须抛（这正是现场 preset-declare.json 记录的报错）
  let dupErr = null;
  try { await registry.register(def); } catch (e) { dupErr = e; }
  check("重复注册抛 Duplicate", !!dupErr && /Duplicate agent preset/.test(dupErr.message), dupErr?.message);

  // 反证：不注册时确实解析不了 —— 证明这组接线是必需的
  const bare = new FakeRegistry({ default: "standard", selectedDefault: "redteam" });
  for (const id of ["standard", "ptc", "minimal", "cordis"]) await bare.register({ id, plugins: [] });
  let missErr = null;
  try { await bare.resolve(); } catch (e) { missErr = e; }
  check("**反证**：不注册 redteam 就解析失败", !!missErr && /Unknown agent preset: redteam/.test(missErr.message), missErr?.message);
}

// ── 7. 预设里不能有会挂不上的模块名 ────────────────────────────
console.log("\n[7] 预设里的外部模块引用健全性");
{
  const dir = path.join(HOME, ".agent-presets", "redteam");
  const def = composition.readPresetDefinition("redteam", dir);
  const walk = (rows, out = []) => {
    for (const row of rows) {
      if (row.name && !/^(@deepseek-ai\/|cordis:|file:|[./])/.test(row.name)) out.push(row.name);
      if (row.group === true && Array.isArray(row.config)) walk(row.config, out);
    }
    return out;
  };
  const external = walk(def.plugins);
  check("只有本包自己的外部行", external.every((n) => n.startsWith("dsh-prompt/")), external.join(","));
  check("没有 dsh-purge 残留", !external.some((n) => n.startsWith("dsh-purge/")), external.join(","));
}

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fails.length) { console.log("\n失败项："); for (const f of fails) console.log("  - " + f); }
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
