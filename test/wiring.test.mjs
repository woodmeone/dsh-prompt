/**
 * dsh-prompt · 最终接线验收
 *
 * 从「真实调用路径」验一遍所有接线，而不是只测内部函数：
 *   1. lib/index.js 导出面（name / apply / PLUGIN_DIR）
 *   2. 入口里三个新增接线点都在位
 *   3. 面板片段确实嵌进了 client.js
 *   4. client.js 是合法的 ModuleLoader 工厂
 *   5. 路由注册 / 补丁表 / 数据目录路径
 *
 * node test/wiring.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ROOT = path.join(HERE, "..");

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); return; }
  fail += 1; fails.push(`${name}${detail ? " — " + detail : ""}`);
  console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
}

// ── 1. 入口导出面 ──────────────────────────────────────────────
console.log("\n[1] 入口导出面");
{
  const idx = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
  check("导出 name", idx.name === "dsh-prompt", `got=${idx.name}`);
  check("导出 apply 是函数", typeof idx.apply === "function");
  check("导出 PLUGIN_DIR", typeof idx.PLUGIN_DIR === "string" && idx.PLUGIN_DIR.length > 0);
  check("PLUGIN_DIR 指向插件根（含 blocks/）", fs.existsSync(path.join(idx.PLUGIN_DIR, "blocks")));
  check("导出 registerPromptSections", typeof idx.registerPromptSections === "function");
}

// ── 2. 入口接线点 ──────────────────────────────────────────────
console.log("\n[2] 入口接线点");
{
  const src = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");
  check("块引擎读法在位（assembleTop）", src.includes("blocks.assembleTop(home)"));
  check("尾钩注册在位（installPromptTailHook）", src.includes("installPromptTailHook(cfg)"));
  check("全局钩子名用 TAIL_HOOK 常量", src.includes("globalThis[TAIL_HOOK] = fn"));
  check("HTTP 桥在位（promptHttpHandler）", src.includes("function promptHttpHandler"));
  check("路由挂在位（installPromptHttp）", src.includes("trackRoute(installPromptHttp(host.webServer))"));
  check("路由前缀 /dsh-prompt/prompt", src.includes('path: "/dsh-prompt/prompt"'));
  check("活配置指针在位（livePromptCfg）", src.includes("livePromptCfg = cfg"));
  check("老兜底路径保留（refreshHungOperator）", src.includes("const refreshed = refreshHungOperator(home)"));
}

// ── 3. 面板嵌入 ────────────────────────────────────────────────
console.log("\n[3] 面板嵌入 client.js");
{
  const c = fs.readFileSync(path.join(ROOT, "client.js"), "utf8");
  check("面板标记存在", c.includes("/* __DSH_PROMPT_PANEL_BEGIN__ */") && c.includes("/* __DSH_PROMPT_PANEL_END__ */"));
  check("只嵌一份", (c.split("__DSH_PROMPT_PANEL_BEGIN__").length - 1) === 1);
  check("面板组件存在", c.includes("function PromptBlocksPanel"));
  check("面板 CSS 命名空间 .dshpm-", c.includes("PROMPT_PANEL_CSS") && c.includes(".dshpm-row"));
  check("面板 API 路径正确", c.includes('const PROMPT_API = "/dsh-prompt/prompt"'));
  check("拖拽属性在位", c.includes("draggable: true") && c.includes("onDragStart"));
  check("排序提交在位", c.includes('doOp("reorder"'));
  check("dock 第三个 tab 在位", c.includes('"dock.prompt"') && c.includes('onTab("prompt")'));
  check("dock body 有 prompt 分支", c.includes('st.tab === "prompt"'));
  check("模块 id 是 dsh-prompt", c.includes('id: "dsh-prompt"'));
}

// ── 4. client.js 是合法工厂 ────────────────────────────────────
console.log("\n[4] client.js 工厂格式");
{
  const c = fs.readFileSync(path.join(ROOT, "client.js"), "utf8");
  check("是 ModuleLoader.load 包裹", c.trimStart().startsWith("window.__ModuleLoader__.load({"));
  check("有 factory", c.includes("factory: (require) => {"));
  check("导出 name/inject/apply", c.includes("exports.name = name") && c.includes("exports.apply = apply"));
  // 语法
  const { execFileSync } = await import("node:child_process");
  let ok = true, e = "";
  try { execFileSync(process.execPath, ["--check", path.join(ROOT, "client.js")], { stdio: "pipe" }); }
  catch (err) { ok = false; e = String(err.stderr || err.message).slice(0, 300); }
  check("client.js 语法合法", ok, e);
}

// ── 5. 包清单 ──────────────────────────────────────────────────
console.log("\n[5] 包清单");
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  check("name 是 dsh-prompt", pkg.name === "dsh-prompt");
  check("main 指向 lib/index.js", pkg.main === "lib/index.js", pkg.main);
  check("main 文件存在", fs.existsSync(path.join(ROOT, pkg.main)));
  check("有 dsh.bundle.patch", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");
  check("cordis.patch.yml 存在", fs.existsSync(path.join(ROOT, "cordis.patch.yml")));
  check("有 dsh.client 声明", Array.isArray(pkg.dsh?.client?.inject));
  check("exports 里没有已删文件", !JSON.stringify(pkg.exports).includes("prompt-index"));
}

// ── 6. 数据目录路径 ────────────────────────────────────────────
console.log("\n[6] 数据目录路径");
{
  const blocks = await import(pathToFileURL(path.join(ROOT, "lib", "prompt-blocks.js")).href);
  const H = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-wire-"));
  check("blockRoot 指向 dsh-prompt 目录", blocks.blockRoot(H) === path.join(H, "dsh-prompt"), blocks.blockRoot(H));
  check("configPath 正确", blocks.configPath(H) === path.join(H, "dsh-prompt", "config.json"));
  check("blocksDir 正确", blocks.blocksDir(H) === path.join(H, "dsh-prompt", "blocks"));
  check("overridesDir 正确", blocks.overridesDir(H) === path.join(H, "dsh-prompt", "overrides"));
  check("trashDir 正确", blocks.trashDir(H) === path.join(H, "dsh-prompt", "_trash"));
  check("不叫 dsh-purge", !blocks.blockRoot(H).includes("dsh-purge"));
  fs.rmSync(H, { recursive: true, force: true });
}

// ── 7. 与新插件共存的隔离性 ───────────────────────────────────
console.log("\n[7] 与 dsh-purge 的隔离");
{
  const d = ROOT;
  // 我们的补丁 marker 必须是自己的
  const pat = fs.readFileSync(path.join(d, "lib", "prompt-patches.js"), "utf8");
  check("补丁 marker 是 [dsh-prompt]", pat.includes('export const MARK = "[dsh-prompt]"'));
  // 检测函数保留别人的名字（这是识别用，不能改）
  check("能识别 dsh-loom 的补丁", pat.includes('hits.push("dsh-loom")'));
  check("能识别 dsh-purge 的补丁", pat.includes('hits.push("dsh-purge")'));

  // 确认没有写到 purge 的数据目录
  const src = fs.readFileSync(path.join(d, "lib", "prompt-blocks.js"), "utf8");
  check("数据目录不含 dsh-purge 字样", !/path\.join\([^)]*"dsh-purge"/.test(src));
}

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fails.length) { console.log("\n失败项："); for (const f of fails) console.log("  - " + f); }
process.exit(fail ? 1 : 0);
