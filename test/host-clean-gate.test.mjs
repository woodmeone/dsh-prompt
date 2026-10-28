/**
 * dsh-prompt · 清洗门禁三态 + #40 版本漂移回归（#2）
 *
 * 锁的是什么：
 *   1. `#40` 在 dsh 0.2.1-rc.2 的真实字节上能命中（老 pattern 钉死 0.2.0）；
 *   2. 打上 #40 后 `dropsInject` 消失、`contexts` 的新语义被保留；
 *   3. 门禁三态：clean / dirty / anchor-miss，且 anchor-miss 不会冒充 dirty；
 *   4. 幂等：同一文件跑两次 #40，第二次不改。
 *
 * 对抗式设计：
 *   · 造一份**与任何宿主版本都不匹配**的假 system-prompt → 必须 anchor-miss，不是 dirty；
 *   · 造一份「能命中但没打」的真版本文本 → 必须 dirty，不是 anchor-miss；
 *   · 把 marker 手写进去但把旧拦截留着 → 快路命中但慢路其实没过，必须仍判 clean
 *     （marker 是我们自己的产物，它的存在就说明改过——这条是刻意的取舍，见断言语）；
 *   · 空文件 / 非本模块文件 → dirty。
 *
 * node test/host-clean-gate.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); return; }
  fail += 1; fails.push(`${name}${detail ? " — " + detail : ""}`);
  console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
}

const core = await import(pathToFileURL(path.join(ROOT, "lib", "core.js")).href);
const hc = await import(pathToFileURL(path.join(ROOT, "lib", "host-clean.js")).href);

const P40 = core.ALL_PATCHES.find((p) => p.id === 40);
const P25 = core.ALL_PATCHES.find((p) => p.id === 25);

/**
 * dsh 0.2.1-rc.2 的真实片段（去掉无关上下文，保留判据所需的全部字节）。
 * 缩进一律 tab，与宿主实际文件一致。
 */
const HOST_021 = [
  "class SystemPrompt {",
  "\tasync assemble(scope, context) {",
  "\t\tconst completeSections = sectionDefinitions.filter((section) => section.complete === true);",
  "\t\tlet completeSection;",
  "\t\tif (section.complete === true) completeSection = { ...assembled };",
  "\t\tconst assembly = {",
  "\t\t\tsections: [],",
  "\t\t\tcontexts: [...contextByName.values()].map((entry) => resolveContext(entry, context)),",
  "\t\t\tvariables",
  "\t\t};",
  "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));",
  "\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return transformed;",
  "\t\tconst requiredContexts = new Set([...contextByName.values()].filter((entry) => entry.required === true).map((entry) => entry.name));",
  "\t\treturn {",
  "\t\t\t...transformed,",
  "\t\t\tsections: completeSection === void 0 ? transformed.sections : [completeSection],",
  "\t\t\tcontexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts",
  "\t\t};",
  "\t}",
  "};",
  "",
  "\t\ttext: \"You are an AI agent powered by DeepSeek Harness.\"",
  "",
].join("\n");

console.log("\n[1] 三态常量与导出");
{
  check("导出 inspectHostPrompt", typeof hc.inspectHostPrompt === "function");
  check("导出三个状态常量", hc.HOST_CLEAN === "clean" && hc.HOST_DIRTY === "dirty" && hc.HOST_ANCHOR_MISS === "anchor-miss");
  check("core 也转发三态常量", core.HOST_CLEAN_STATE === "clean" && core.HOST_DIRTY_STATE === "dirty" && core.HOST_ANCHOR_MISS_STATE === "anchor-miss");
  check("旧布尔壳仍在（desktop.js 还在用）", typeof hc.hostPromptKeepsInject === "function");
}

console.log("\n[2] 0.2.1 原件：门禁判 dirty（还没打）");
{
  const r = hc.inspectHostPrompt(HOST_021, { anchorHit: true });
  check("state=dirty", r.state === "dirty", r.state);
  check("原因是身份句 + dropsInject", r.reasons.length === 2, JSON.stringify(r.reasons));
  check("markers 都没命中", r.markers.identity === false && r.markers.inject.length === 0);
}

console.log("\n[3] #40 必须能在 0.2.1 上命中（老 pattern 命中 0 处）");
{
  const oldOnly = { ...P40, replacements: P40.replacements.slice(0, -1) };
  const before = core.applyReplacementsToText(HOST_021, oldOnly, "");
  check("去掉 0.2.1 那条后，一处都不命中（证明这条是新增的必要性）", before.changed === false);

  const applied = core.applyReplacementsToText(HOST_021, P40, "");
  check("带上新锚点后能命中", applied.changed === true);
  check("产物带 inject marker", applied.text.includes("[dsh-prompt] complete prompt keeps inject + agent-instructions"));
  check("dropsInject 的 0.2.1 形态消失",
    !applied.text.includes("sections: completeSection === void 0 ? transformed.sections : [completeSection],"));
  check("requiredContexts 语义被保留",
    applied.text.includes("requiredContexts.has(entry.name)"));
  check("没把 0.2.0 的 `? []` 空数组语义带回来",
    !applied.text.includes("contexts: runtimeContextSuppressed ? [] : transformed.contexts"));
}

console.log("\n[4] #40 幂等：第二次不改");
{
  const once = core.applyReplacementsToText(HOST_021, P40, "");
  const twice = core.applyReplacementsToText(once.text, P40, "");
  check("第二次 changed=false", twice.changed === false);
  check("marker 只有一份", (twice.text.split("complete prompt keeps inject + agent-instructions").length - 1) === 1);
}

console.log("\n[5] #40 + #25 之后门禁必须 clean");
{
  const a = core.applyReplacementsToText(HOST_021, P40, "");
  const b = core.applyReplacementsToText(a.text, P25, "");
  const r = hc.inspectHostPrompt(b.text, { anchorHit: false });
  check("state=clean（快路：两个 marker 都在）", r.state === "clean", `${r.state} ${JSON.stringify(r.reasons)}`);
  check("identity marker 在", r.markers.identity === true);
  check("inject marker 在", r.markers.inject.length > 0);
}

console.log("\n[6] anchor-miss：版本完全不同的文件");
{
  // 关键：残留句要在场（否则会被当成“已经洗干净”），
  // 但**不能出现在任何补丁 pattern 的上下文里**（否则就是可修的 dirty）。
  // 所以身份句写成注释里的裸字符串，而不是 #25 认的 `text: "..."` 形态。
  const alien = [
    "class SystemPrompt {",
    "\tasync assemble(scope, context) {",
    "\t\tconst merged = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));",
    "\t\tif (completeSection === undefined) return merged;",
    "\t\treturn { ...merged, sections: [completeSection], contexts: merged.contexts };",
    "\t}",
    "};",
    "// legacy: You are an AI agent powered by DeepSeek Harness.",
    "// legacy: transformed.sections : [completeSection]",
  ].join("\n");
  const fixable = core.hostPromptFixable(alien, "");
  check("两类残留都不可修", fixable.identity === false && fixable.inject === false, JSON.stringify(fixable));
  const r = hc.inspectHostPrompt(alien, { fixable });
  check("state=anchor-miss（不是 dirty）", r.state === "anchor-miss", `${r.state} ${JSON.stringify(r.reasons)}`);
  check("理由里说明是版本问题", r.reasons.some((x) => x.includes("锚点不命中")), JSON.stringify(r.reasons));
}

console.log("\n[6b] 陌生文件不得被判 clean（对抗：假绿比假红危险）");
{
  // 既无本插件标记、也无旧残留的陌生模块 —— 不能因为“没看到坏东西”就放行。
  const stranger = [
    "class SystemPrompt {",
    "\tasync assemble(scope, context) {",
    "\t\tconst merged = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));",
    "\t\treturn merged;",
    "\t}",
    "};",
  ].join("\n");
  const r = hc.inspectHostPrompt(stranger, { fixable: { identity: true, inject: true } });
  check("无标记 + 可修 → dirty", r.state === "dirty", `${r.state} ${JSON.stringify(r.reasons)}`);
  check("理由说明没有标记", r.reasons.some((x) => x.includes("没有本插件标记")), JSON.stringify(r.reasons));
  check("evidenced=false", r.evidenced === false);
  // 无标记 + 完全不可修：仍然只能判 dirty —— 没有正面证据就不能宣称干净。
  const miss = hc.inspectHostPrompt(stranger, { fixable: { identity: false, inject: false } });
  check("无标记 + 不可修 → 仍 dirty（不冒充 anchor-miss）", miss.state === "dirty", miss.state);
}

console.log("\n[6c] 按残留项分别判可修（0.2.1 现场：#25 可修、#40 不可修）");
{
  // 0.2.1 原件 + 把 #40 的那条替换去掉 → 只有身份可修。
  const r = core.hostPromptFixable(HOST_021, "");
  check("0.2.1 原件上身份可修", r.identity === true, JSON.stringify(r));
  check("0.2.1 原件上注入残留也可修（新锚点已补）", r.inject === true, JSON.stringify(r));

  // 对抗：整个补丁表都不认这份文件时，两项都必须为 false。
  const dead = core.hostPromptFixable("system-prompt/assemble\nnothing else\n", "");
  check("无关文件两项都不可修", dead.identity === false && dead.inject === false, JSON.stringify(dead));

  // 只留身份残留可修、注入残留不可修 → 仍应 dirty（还有能救的）
  const mixed = hc.inspectHostPrompt(HOST_021, { fixable: { identity: true, inject: false } });
  check("一处可修即 dirty（不提前放行）", mixed.state === "dirty", `${mixed.state} ${JSON.stringify(mixed.fixableLeft)}`);
  check("fixableLeft 说明哪项可修", Array.isArray(mixed.fixableLeft) && mixed.fixableLeft.length === 1, JSON.stringify(mixed.fixableLeft));
  const noneLeft = hc.inspectHostPrompt(HOST_021, { fixable: { identity: false, inject: false } });
  check("两处都不可修才 anchor-miss", noneLeft.state === "anchor-miss", noneLeft.state);
}

console.log("\n[7] dirty 与 anchor-miss 必须能分开（对抗：别互相冒充）");
{
  // 同样的残留，只改可修性 → 状态必须跟着变
  const r1 = hc.inspectHostPrompt(HOST_021, { fixable: { identity: true, inject: true } });
  check("两处可修时是 dirty", r1.state === "dirty", r1.state);
  const r2 = hc.inspectHostPrompt(HOST_021, { fixable: { identity: false, inject: false } });
  check("两处不可修时是 anchor-miss", r2.state === "anchor-miss", r2.state);
  check("缺省视为可修（保守：宁报 dirty）",
    hc.inspectHostPrompt(HOST_021).state === "dirty");
}

console.log("\n[8] 边界：空文件 / 非本模块 / 已 clean 的旧版");
{
  check("空文件 → dirty", hc.inspectHostPrompt("").state === "dirty");
  check("非本模块（无 assemble）→ dirty", hc.inspectHostPrompt("console.log(1)").state === "dirty");
  const clean = "[dsh-prompt] identity stripped\n[dsh-prompt] complete prompt keeps inject\nsystem-prompt/assemble\n";
  check("两个 marker 都在 → clean", hc.inspectHostPrompt(clean, { anchorHit: false }).state === "clean");
  // 只有 marker 没有旧拦截，也应当 clean（别的清洗路径改过也算改过）
  const onlyMark = "system-prompt/assemble\n[dsh-prompt] identity stripped\n[dsh-prompt] complete prompt keeps waterfall inject\n";
  check("marker 齐但无旧残留 → clean", hc.inspectHostPrompt(onlyMark, { anchorHit: false }).state === "clean");
}

console.log("\n[9] ensureHostClean 的 anchor-miss 特赦（源码级锁定）");
{
  const src = fs.readFileSync(path.join(ROOT, "lib", "core.js"), "utf8");
  const start = src.indexOf("export async function ensureHostClean()");
  check("找得到 ensureHostClean", start > 0);
  const body = src.slice(start, start + 5200);
  check("按三态分开处理", /HOST_DIRTY_STATE/.test(body) && /HOST_ANCHOR_MISS_STATE/.test(body));
  check("dirty 才取消重启", /dirty\.length > 0[\s\S]{0,200}已取消重启/.test(body));
  check("anchor-miss 放行并带 gate_warn", /gate_warn:\s*reports\.some/.test(body));
  check("放行路径仍返回 gate 报告", /ok:\s*true[\s\S]{0,200}gate:\s*reports/.test(body));
}

console.log("\n[10] 门禁报告带依据（不许只回布尔）");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-gate-"));
  try {
    const base = path.join(tmp, "node_modules", "@deepseek-ai");
    fs.mkdirSync(path.join(base, "dsh-system-prompt", "lib"), { recursive: true });
    fs.writeFileSync(path.join(base, "dsh-system-prompt", "lib", "index.js"), HOST_021, "utf8");
    const r = core.hostCleanReport(base);
    check("state=dirty", r.state === "dirty", r.state);
    check("带 reasons 数组", Array.isArray(r.reasons) && r.reasons.length > 0);
    check("带 fixable 对象", r.fixable && typeof r.fixable.identity === "boolean", JSON.stringify(r.fixable));
    check("带 file 路径", typeof r.file === "string" && r.file.endsWith("index.js"));
    check("带 aiBase", r.aiBase === base);
    // 空 base 不炸
    const empty = core.hostCleanReport("");
    check("空 base 返回 dirty 且不抛", empty.state === "dirty");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\n" + "=".repeat(50));
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fail > 0) {
  console.log("\n失败项：");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
