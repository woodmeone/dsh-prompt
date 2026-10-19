/**
 * 出厂态 vs 现役态对照
 *
 * 回答一个问题：**新机器装上插件后，默认注入哪些块、多少字？**
 * 以及：它和当前这台机器的现役状态差在哪？
 *
 * 用法：
 *   node test/fresh-state.mjs            # 出厂态 vs 本机现役
 *   node test/fresh-state.mjs --fresh    # 只看出厂态
 *
 * 只读。出厂态在临时目录里 seed，不碰真实 $DSH_HOME。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PLUGIN = path.join(HERE, "..");
const LIB = path.join(PLUGIN, "lib");
const FRESH_ONLY = process.argv.includes("--fresh");

const blocks = await import(pathToFileURL(path.join(LIB, "prompt-blocks.js")).href);

function dump(label, home) {
  const d = blocks.describe(home);
  const top = blocks.assembleTop(home);
  const tail = blocks.assembleTail(home);
  console.log(`\n== ${label} ==`);
  console.log(`configSource: ${d.configSource}`);
  console.log("块表（order / enabled / slot / 字节 / 来源）:");
  for (const b of d.blocks) {
    console.log(
      `  ${b.id.padEnd(16)} order=${String(b.order).padEnd(5)} ` +
      `enabled=${String(b.enabled).padEnd(6)} ${b.slots.join(",").padEnd(5)} ` +
      `${String(b.bytes).padStart(6)}B  src=${b.source}`,
    );
  }
  console.log(`顶部装配: ${top.text.length} 字 / ${top.parts.length} 块`);
  console.log(`  参与: ${top.parts.map((p) => p.id).join(" > ")}`);
  console.log(`尾部装配: ${tail.text.length} 字 / ${tail.parts.length} 块`);
  return { d, top, tail };
}

// ── 出厂态：临时 home，只有 seed 出来的 blocks/，无 config.json、无 overrides ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-fresh-"));
const seeded = blocks.seedBlocks(TMP, PLUGIN);
console.log("出厂 seed:", `seeded=${seeded.seeded.length}`, `kept=${seeded.kept.length}`, `missing=${seeded.missing.length}`);
const fresh = dump("出厂态（新机器首次安装）", TMP);

if (!FRESH_ONLY) {
  // ── 现役态：真实 $DSH_HOME ──
  let live = "";
  try {
    const core = await import(pathToFileURL(path.join(LIB, "core.js")).href);
    live = core.findDshHome();
  } catch { live = ""; }
  if (live && fs.existsSync(path.join(live, "dsh-prompt"))) {
    const cur = dump(`现役态（${live}）`, live);

    console.log("\n== 差异 ==");
    console.log(`顶部字数: ${fresh.top.text.length} -> ${cur.top.text.length}`);
    console.log(`尾部字数: ${fresh.tail.text.length} -> ${cur.tail.text.length}`);
    const fIds = fresh.d.blocks.map((b) => b.id);
    const lIds = cur.d.blocks.map((b) => b.id);
    const onlyLive = lIds.filter((i) => !fIds.includes(i));
    const onlyFresh = fIds.filter((i) => !lIds.includes(i));
    console.log(`现役多出的块: ${onlyLive.join(", ") || "（无）"}`);
    console.log(`出厂多出的块: ${onlyFresh.join(", ") || "（无）"}`);
    for (const id of fIds.filter((i) => lIds.includes(i))) {
      const fb = fresh.d.blocks.find((b) => b.id === id);
      const lb = cur.d.blocks.find((b) => b.id === id);
      const diffs = [];
      if (fb.order !== lb.order) diffs.push(`order ${fb.order}->${lb.order}`);
      if (fb.enabled !== lb.enabled) diffs.push(`enabled ${fb.enabled}->${lb.enabled}`);
      if (fb.bytes !== lb.bytes) diffs.push(`正文 ${fb.bytes}B->${lb.bytes}B`);
      if (fb.source !== lb.source) diffs.push(`来源 ${fb.source}->${lb.source}`);
      if (diffs.length) console.log(`  ${id}: ${diffs.join(" | ")}`);
    }
  } else {
    console.log("\n（未找到现役 $DSH_HOME/dsh-prompt，跳过对照）");
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
