/**
 * dsh-prompt · 回收站的可靠性（票4）
 *
 * 这个套件锁的是 README 里那句承诺：「_trash/ 只增不减，写坏了永远能捞回来」。
 *
 * 改造前 toTrash() 用 `new Date().toISOString().replace(/[:.]/g,"-")` 做目录名，
 * 精度只有毫秒；同一毫秒内对同一块归档两次，就命中同一目录 + 同名 <id>.md，
 * writeFileSync 直接覆盖。
 *
 * 为什么平时抓不到：靠运气。实测非冻结时钟下连续保存 40 次留下了 39 份，
 * 说明毫秒碰撞是偶发。但只要发生一次，用户的旧版本就永久没了 ——
 * 而回收站存在的唯一意义就是「那次」。
 *
 * 对抗视角（本文件的核心手法）：
 *   靠运气复现不了偶发 bug，所以这里**冻结时钟**，把偶发变成必现，
 *   再用「N 次归档必须留下 N 份」把它钉死。冻结时钟也顺带证明了一件事：
 *   修法不能依赖「时间戳一定不同」这种假设。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const LIB = path.join(HERE, "..", "lib");
const PLUGIN_DIR = path.join(HERE, "..");

const blocks = await import(pathToFileURL(path.join(LIB, "prompt-blocks.js")).href);
const edit = await import(pathToFileURL(path.join(LIB, "prompt-edit.js")).href);

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

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-trash-"));
  blocks.seedBlocks(home, PLUGIN_DIR);
  return home;
}

const trashRootOf = (home) => path.join(home, "dsh-prompt", "_trash");

/** 收集 _trash 下所有文件（递归）。 */
function allTrashFiles(home) {
  const root = trashRootOf(home);
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else out.push(fp);
    }
  };
  walk(root);
  return out;
}

/** 冻结时钟到固定毫秒，让偶发的「同毫秒碰撞」变成必现。 */
function withFrozenClock(fn) {
  const RealDate = Date;
  const FROZEN = 1700000000000; // 固定时刻，任意
  class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [FROZEN]));
    }
    static now() { return FROZEN; }
  }
  globalThis.Date = FrozenDate;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[1] 冻结时钟：同一毫秒内归档 N 次，必须留下 N 份");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome();
  const versions = [];
  withFrozenClock(() => {
    for (let i = 0; i < 5; i += 1) {
      const text = `版本${i}-` + "x".repeat(30);
      versions.push(text);
      // 第一次写 override 时没有旧版本可归档，所以先写一次打底
      edit.setBlockContent(home, "core-persona", text);
    }
  });

  const files = allTrashFiles(home);
  const contents = files.map((f) => fs.readFileSync(f, "utf8"));
  const kept = versions.filter((v) => contents.includes(v));

  // 5 次保存产生 4 份旧版本（最后一次是当前版本，不入回收站）
  check(`5 次保存留下 4 份旧版本（实际 ${kept.length} 份）`, kept.length === 4,
    `留下的版本：${kept.map((v) => v.slice(0, 3)).join(",")}`);

  // 关键：中间版本不许被覆盖
  const lost = versions.slice(0, 4).filter((v) => !contents.includes(v));
  check("没有任何中间版本被覆盖", lost.length === 0,
    `丢失：${lost.map((v) => v.slice(0, 3)).join(",")}`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[2] 冻结时钟：不同块同毫秒互不干扰");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome();
  withFrozenClock(() => {
    // 两个不同的块各保存两次，全部落在同一毫秒
    edit.setBlockContent(home, "core-persona", "P1");
    edit.setBlockContent(home, "core-style", "S1");
    edit.setBlockContent(home, "core-persona", "P2");
    edit.setBlockContent(home, "core-style", "S2");
  });
  const files = allTrashFiles(home);
  const contents = files.map((f) => fs.readFileSync(f, "utf8"));
  check("persona 的旧版本在", contents.includes("P1"), JSON.stringify(contents));
  check("style 的旧版本在", contents.includes("S1"), JSON.stringify(contents));
  check("两份旧版本都在（共 2 份）", files.filter((f) => /core-(persona|style)/.test(f)).length === 2,
    files.map((f) => path.basename(f)).join(","));
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[3] 不冻结时钟时也正常（不能为了修碰撞而破坏常规路径）");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome();
  const versions = [];
  for (let i = 0; i < 6; i += 1) {
    const text = `实时${i}-` + "y".repeat(20);
    versions.push(text);
    edit.setBlockContent(home, "core-persona", text);
  }
  const contents = allTrashFiles(home).map((f) => fs.readFileSync(f, "utf8"));
  const kept = versions.slice(0, 5).filter((v) => contents.includes(v));
  eq("6 次保存留下 5 份旧版本", kept.length, 5);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[4] 归档文件名仍能看出是哪个块（可读性不许丢）");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome();
  withFrozenClock(() => {
    edit.setBlockContent(home, "core-persona", "a");
    edit.setBlockContent(home, "core-persona", "b");
  });
  const names = allTrashFiles(home).map((f) => path.basename(f));
  check("归档文件名含块 id", names.every((n) => n.startsWith("core-persona")),
    JSON.stringify(names));
  check("归档文件仍是 .md（可直接改回去使用）", names.every((n) => n.endsWith(".md")),
    JSON.stringify(names));
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[5] 其它写回收站的路径也要稳（还原 / 删除 / 恢复出厂）");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome();
  edit.addBlock(home, { id: "tmp-block", name: "临时块", slots: ["top"], content: "初版" });
  withFrozenClock(() => {
    // 同毫秒内：改一次（归档初版）、再删（归档改后版）
    edit.setBlockContent(home, "tmp-block", "改后");
    edit.removeBlock(home, "tmp-block");
  });
  const contents = allTrashFiles(home).map((f) => fs.readFileSync(f, "utf8"));
  check("改前的正文被归档", contents.includes("初版"), JSON.stringify(contents));
  check("改后的正文也被归档（同一毫秒，不许互相覆盖）", contents.includes("改后"), JSON.stringify(contents));
}

// ═══════════════════════════════════════════════════════════════
console.log("\n[6] 空正文不归档（原本就不归档，别改坏）");
// ═══════════════════════════════════════════════════════════════
{
  const home = makeHome();
  const before = allTrashFiles(home).length;
  edit.setBlockContent(home, "core-persona", "第一版");
  const mid = allTrashFiles(home).length;
  edit.setBlockContent(home, "core-persona", ""); // 空 override 是有效状态
  const after = allTrashFiles(home).length;
  check("首次保存无旧版本可归档", mid === before, `before=${before} mid=${mid}`);
  check("写空正文时会归档上一版非空正文", after === mid + 1, `mid=${mid} after=${after}`);
}

console.log("\n==================================================");
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fail) {
  console.log("\n失败项：");
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
