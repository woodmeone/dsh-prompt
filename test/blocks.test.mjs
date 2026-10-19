/**
 * dsh-prompt · 块引擎 + CRUD 自测
 *
 * 用独立临时 $DSH_HOME，不碰真实 ~/.dsh。
 * 跑法：node test/blocks.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const LIB = path.join(HERE, "..", "lib");
const blocks = await import(pathToFileURL(path.join(LIB, "prompt-blocks.js")).href);
const edit = await import(pathToFileURL(path.join(LIB, "prompt-edit.js")).href);

let pass = 0;
let fail = 0;
const fails = [];

function check(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  fail += 1;
  fails.push(`${name}${detail ? " — " + detail : ""}`);
  console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
}

function eq(name, got, want) {
  check(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

// ── 隔离的 $DSH_HOME ────────────────────────────────────────────
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-test-"));
const PLUGIN_DIR = path.join(HERE, "..");
console.log("临时 DSH_HOME:", HOME);

// 出厂内容落盘（真实插件启动时也会做这一步）
const seeded = blocks.seedBlocks(HOME, PLUGIN_DIR);
console.log("seed:", JSON.stringify(seeded));
check("出厂块全部 seed 成功", seeded.missing.length === 0, JSON.stringify(seeded.missing));

// ── 1. 零配置可用（内置默认表）────────────────────────────────
console.log("\n[1] 零配置可用");
{
  const d = blocks.describe(HOME);
  eq("默认块数 7", d.total, 7);
  eq("默认来源 builtin", d.configSource, "builtin");
  eq("默认开 6 个（routing 关）", d.enabled, 6);
  eq("默认 builtin 标记 7", d.builtin, 7);
  check("顶部装配非空", d.topBytes > 0, `topBytes=${d.topBytes}`);
  check("尾部装配非空", d.tailBytes > 0, `tailBytes=${d.tailBytes}`);
}

// ── 2. 内建块正文：随发行带 7 个 md ────────────────────────────
console.log("\n[2] 内建块正文随发行");
{
  const dir = blocks.blocksDir(HOME);
  const seed = [
    ["core-persona", "你是码头上一只海鸥"],
    ["core-style", "短句"],
    ["core-contract", "核心执行契约"],
    ["core-jailbreak", "破限"],
    ["core-armor", "破甲"],
    ["core-tail", "尾部续压"],
  ];
  for (const [id, needle] of seed) {
    const { text, source } = blocks.readBlockContent(HOME, id);
    check(`块 ${id} 有正文且来自 default`, text.includes(needle) && source === "default",
      `source=${source} len=${text.length}`);
  }
  const routing = blocks.readBlockContent(HOME, "core-routing");
  check("任务路由块有正文（默认关）", routing.text.trim().length > 0, `len=${routing.text.length}`);
  void dir;
}

// ── 3. 开关：关掉一个块 → 顶部字节下降，且不残留 ───────────────
console.log("\n[3] 开关生效且不残留");
{
  const before = blocks.assembleTop(HOME);
  const routingBytes = blocks.readBlockContent(HOME, "core-routing").text.length;
  check("初始顶部不含任务路由", !before.parts.some((p) => p.id === "core-routing"));

  edit.updateBlockMeta(HOME, "core-routing", { enabled: true });
  const on = blocks.assembleTop(HOME);
  check("打开后含任务路由", on.parts.some((p) => p.id === "core-routing"));
  check("打开后顶部变长", on.text.length > before.text.length,
    `${before.text.length} → ${on.text.length}`);

  edit.updateBlockMeta(HOME, "core-routing", { enabled: false });
  const off = blocks.assembleTop(HOME);
  eq("关回后字节还原", off.text.length, before.text.length);
  check("关回后无残留", !off.parts.some((p) => p.id === "core-routing"));
  void routingBytes;
}

// ── 4. 顺序即语义：改 order → 装配顺序变 ───────────────────────
console.log("\n[4] order 决定装配顺序");
{
  const d0 = blocks.assembleTop(HOME);
  const ids0 = d0.parts.map((p) => p.id);
  check("初始顺序 persona 在 style 前",
    ids0.indexOf("core-persona") < ids0.indexOf("core-style"), ids0.join(","));

  edit.updateBlockMeta(HOME, "core-persona", { order: 999 });
  const d1 = blocks.assembleTop(HOME);
  const ids1 = d1.parts.map((p) => p.id);
  check("persona 排到最后", ids1[ids1.length - 1] === "core-persona", ids1.join(","));

  edit.updateBlockMeta(HOME, "core-persona", { order: 100 });
  const d2 = blocks.assembleTop(HOME);
  eq("还原 order 后顺序还原", d2.parts.map((p) => p.id).join(","), ids0.join(","));
}

// ── 5. 拖拽排序：reorderBlocks ─────────────────────────────────
console.log("\n[5] 拖拽排序");
{
  const before = blocks.assembleTop(HOME).parts.map((p) => p.id);
  const reversed = [...before].reverse();
  const r = edit.reorderBlocks(HOME, "top", reversed);
  check("reorder ok", r.ok === true, JSON.stringify(r));
  const after = blocks.assembleTop(HOME).parts.map((p) => p.id);
  eq("顺序完全按传入的来", after.join(","), reversed.join(","));
  // 还原
  edit.reorderBlocks(HOME, "top", before);
  eq("还原后与初始一致", blocks.assembleTop(HOME).parts.map((p) => p.id).join(","), before.join(","));
}

// ── 6. 位置：一个块可同时挂 top 和 tail ────────────────────────
console.log("\n[6] 一个块可同时属于两个位置");
{
  const top0 = blocks.assembleTop(HOME).parts.map((p) => p.id);
  const tail0 = blocks.assembleTail(HOME).parts.map((p) => p.id);
  check("core-persona 初始不在 tail", !tail0.includes("core-persona"));

  edit.updateBlockMeta(HOME, "core-persona", { slots: ["top", "tail"] });
  const top1 = blocks.assembleTop(HOME).parts.map((p) => p.id);
  const tail1 = blocks.assembleTail(HOME).parts.map((p) => p.id);
  check("persona 同时出现在两位", top1.includes("core-persona") && tail1.includes("core-persona"),
    `top=${top1.join(",")} tail=${tail1.join(",")}`);
  eq("顶部未丢块", top1.length, top0.length);

  edit.updateBlockMeta(HOME, "core-persona", { slots: ["top"] });
  check("收回 tail 后不在尾部", !blocks.assembleTail(HOME).parts.map((p) => p.id).includes("core-persona"));
}

// ── 7. 增删改查 ────────────────────────────────────────────────
console.log("\n[7] 增删改查");
{
  const a = edit.addBlock(HOME, { id: "my-note", name: "我的笔记", content: "只写一行。", slots: ["tail"], role: "user" });
  check("新增成功", a.ok === true, JSON.stringify(a));
  const tailText = blocks.assembleTail(HOME).text;
  check("新增块进尾部装配", tailText.includes("只写一行。"));

  const dup = edit.addBlock(HOME, { id: "my-note", content: "x" });
  eq("重名被拒", dup.ok, false);

  const builtinDup = edit.addBlock(HOME, { id: "core-persona", content: "x" });
  eq("与默认块重名被拒", builtinDup.ok, false);

  const badId = edit.addBlock(HOME, { id: "../evil", content: "x" });
  eq("目录穿越 id 被拒", badId.ok, false);

  const set = edit.setBlockContent(HOME, "my-note", "改过的正文。");
  check("改正文成功", set.ok === true);
  check("改后装配读到新正文", blocks.assembleTail(HOME).text.includes("改过的正文。"));
  const src = blocks.readBlockContent(HOME, "my-note").source;
  eq("内容来源是 override", src, "override");

  const rev = edit.revertBlock(HOME, "my-note");
  check("撤销成功", rev.ok === true);
  check("撤销后回到 blocks/ 正文", blocks.assembleTail(HOME).text.includes("只写一行。"));

  const rm = edit.removeBlock(HOME, "my-note");
  check("删除成功", rm.ok === true);
  check("删除后不在装配", !blocks.assembleTail(HOME).text.includes("只写一行。"));

  const rmBuiltin = edit.removeBlock(HOME, "core-persona");
  eq("默认块不可删", rmBuiltin.ok, false);
}

// ── 8. 恢复出厂 ────────────────────────────────────────────────
console.log("\n[8] 恢复出厂");
{
  edit.updateBlockMeta(HOME, "core-persona", { enabled: false, order: 5555 });
  edit.setBlockContent(HOME, "core-persona", "污染过的正文。");
  edit.addBlock(HOME, { id: "extra", content: "额外的。" });

  const r = edit.restoreFactory(HOME, PLUGIN_DIR);
  check("恢复出厂 ok", r.ok === true, JSON.stringify(r));
  const d = blocks.describe(HOME);
  eq("块数回到 7", d.total, 7);
  eq("开关回到默认", d.enabled, 6);
  const persona = blocks.describe(HOME).blocks.find((b) => b.id === "core-persona");
  eq("order 回到 100", persona.order, 100);
  eq("enabled 回到 true", persona.enabled, true);
  eq("正文来源回到 default", blocks.readBlockContent(HOME, "core-persona").source, "default");
  const trash = fs.existsSync(path.join(blocks.trashDir(HOME)));
  check("_trash 里有备份", trash && fs.readdirSync(blocks.trashDir(HOME)).length > 0);
}

// ── 9. 空 override 的语义 ─────────────────────────────────────
console.log("\n[9] 空 override 的语义");
{
  edit.setBlockContent(HOME, "core-style", "   \n  ");
  const top = blocks.assembleTop(HOME);
  check("空 override 使块不参与装配", !top.parts.some((p) => p.id === "core-style"),
    top.parts.map((p) => p.id).join(","));
  eq("空 override 也算 override 来源", blocks.readBlockContent(HOME, "core-style").source, "override");

  edit.revertBlock(HOME, "core-style");
  check("删除 override 后重新出现", blocks.assembleTop(HOME).parts.some((p) => p.id === "core-style"));
  eq("还原后来源是 default", blocks.readBlockContent(HOME, "core-style").source, "default");
}

// ── 10. 损坏 config 不炸 ──────────────────────────────────────
console.log("\n[10] 损坏数据不炸");
{
  fs.writeFileSync(blocks.configPath(HOME), "{ this is not json", "utf8");
  const d = blocks.describe(HOME);
  eq("坏 config 回落 builtin", d.configSource, "builtin");
  check("仍能装配", blocks.assembleTop(HOME).text.length > 0);
  // 写入侧也要能自愈
  const healed = edit.updateBlockMeta(HOME, "core-persona", { enabled: true });
  check("写入侧重建 config", healed.ok === true, JSON.stringify(healed));
  eq("重建后来源是 config", blocks.describe(HOME).configSource, "config");
}
edit.restoreFactory(HOME, PLUGIN_DIR);

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fails.length) {
  console.log("\n失败项：");
  for (const f of fails) console.log("  - " + f);
}

fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
