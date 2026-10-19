/**
 * 宿主定位（跨机器）
 *
 * 为什么有这个文件
 * ────────────────
 * 原先 5 个测试各自写死了一条本机路径：
 *
 *     C:/Users/WoodMe/AppData/Local/npm-cache/_npx/b86ed90107c62dab/.../@deepseek-ai
 *
 * 后果有两条，都很硬：
 *   1. 换台机器 → 路径不存在 → 测试**静默跳过**（`existsSync` 为假就 exit 0），
 *      看着「全绿」，其实一条都没验。这是最坏的一种绿。
 *   2. 即使在本机，`b86ed90107c62dab` 也是**旧的 npx 指纹**；本机现在跑的是
 *      `1e7f6d9597241db0`。测试打的是另一份宿主，不是正在跑的那份。
 *
 * 定位顺序（先准后广）
 * ───────────────────
 *   1. `DSH_PROMPT_AI_BASE` 环境变量 —— 显式指定，测试与 CI 的确定性入口
 *   2. `core.findAiBase()`        —— 插件自己的真实探测逻辑，不重复造
 *   3. npm / npx 缓存             —— `_npx/*` 按修改时间新→旧
 *
 * 每条候选都要**实证**：目录下必须真的存在 `dsh-agent-loop/lib/index.js`。
 * 找不到不是错误，是「这台机器没装 dsh」——调用方照旧跳过，但会明确打印
 * 「跳过」而不是假装通过。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const LIB = path.join(HERE, "..", "lib");

/** 判定一个 @deepseek-ai 基座是否真实可用的探针文件。 */
export const NEEDLE = path.join("dsh-agent-loop", "lib", "index.js");

/** 本插件打在宿主上的标记。 */
export const MARK = "[dsh-prompt]";

function samePath(a, b) {
  const n = (s) => path.normalize(String(s || "")).replace(/\\/g, "/").toLowerCase();
  return n(a) === n(b);
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** 一个基座是否真的是「能打的宿主」：有 dsh-agent-loop 的入口文件。 */
export function isUsableAiBase(base) {
  if (!base || !isDir(base)) return false;
  return fs.existsSync(path.join(base, NEEDLE));
}

/** npm / npx 缓存里可能藏 @deepseek-ai 的根目录。 */
function cacheRoots() {
  const roots = [];
  const push = (p) => {
    if (!p) return;
    const n = path.normalize(p);
    if (isDir(n) && !roots.some((r) => samePath(r, n))) roots.push(n);
  };
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    push(path.join(process.env.LOCALAPPDATA, "npm-cache", "_npx"));
  }
  push(path.join(os.homedir(), ".npm", "_npx"));
  return roots;
}

/** 枚举 `_npx/<hash>/node_modules/@deepseek-ai`，按 mtime 新→旧。 */
function npxAiBases() {
  const found = [];
  for (const root of cacheRoots()) {
    let hits = [];
    try { hits = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of hits) {
      if (!e.isDirectory()) continue;
      const ai = path.join(root, e.name, "node_modules", "@deepseek-ai");
      if (!isUsableAiBase(ai)) continue;
      let mtime = 0;
      try { mtime = fs.statSync(ai).mtimeMs; } catch { /* 取不到就当最旧 */ }
      found.push({ base: path.normalize(ai), mtime });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((x) => x.base);
}

/**
 * 从 `dsh` 启动器反推它真正加载的宿主角落。
 *
 * 为什么这条要排在 core.findAiBase() **前面**
 * ────────────────────────────────────────────
 * 实测：宿主进程**外**跑 core.findAiBase()，解析到
 *   D:\Project\DSH\deepseek-harness\node_modules\.pnpm\node_modules\@deepseek-ai
 * 版本 0.1.1-rc.2、**没打过补丁**；而 `dsh` 启动器（PATH 上那个）实际在
 *   _npx\1e7f6d9597241db0\...\@deepseek-ai
 * 版本 0.2.0-rc.2、**已打补丁**。两者不是一处。
 *
 * 测试要打的是「正在跑的那份」，所以启动器反推优先。
 * 启动器形如 `<root>/node_modules/.bin/dsh.ps1`（或 dsh.cmd / dsh），
 * 于是基座 = `<root>/node_modules/@deepseek-ai`。
 */
function launcherAiBases() {
  const out = [];
  const exts = process.platform === "win32" ? [".cmd", ".ps1", ".exe", ""] : ["", ".sh"];
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!/^dsh(\.cmd|\.ps1|\.exe|\.sh)?$/i.test(name)) continue;
      if (!exts.some((e) => name.endsWith(e))) continue;
      // dir 若是 .../node_modules/.bin，基座就在它上两层的 node_modules/@deepseek-ai
      const nm = path.dirname(dir);
      if (path.basename(nm) !== "node_modules") continue;
      const ai = path.join(nm, "@deepseek-ai");
      if (isUsableAiBase(ai)) out.push(path.normalize(ai));
    }
  }
  return out;
}

/** 插件自己的探测器；导入失败（依赖缺失）不致命，降级为「无此来源」。 */
async function coreAiBase() {
  try {
    const core = await import(pathToFileURL(path.join(LIB, "core.js")).href);
    const hit = typeof core.findAiBase === "function" ? core.findAiBase() : "";
    return hit ? path.normalize(hit) : "";
  } catch {
    return "";
  }
}

/**
 * 按优先级给出全部候选基座。
 * @returns {Promise<Array<{base:string, reason:string}>>}
 */
export async function aiBaseCandidates() {
  const out = [];
  const add = (base, reason) => {
    if (!base) return;
    const n = path.normalize(String(base));
    if (!isUsableAiBase(n)) return;
    if (out.some((c) => samePath(c.base, n))) return;
    out.push({ base: n, reason });
  };

  add(process.env.DSH_PROMPT_AI_BASE, "env:DSH_PROMPT_AI_BASE");
  // 运行态优先：PATH 上的 dsh 启动器反推，才是「正在跑的那份」。
  for (const b of launcherAiBases()) add(b, "dsh launcher on PATH");
  add(await coreAiBase(), "core.findAiBase()");
  for (const b of npxAiBases()) add(b, "npx cache (newest first)");

  return out;
}

/**
 * 定位唯一宿主基座。找不到返回 ""。
 * @returns {Promise<string>}
 */
export async function locateAiBase() {
  const list = await aiBaseCandidates();
  return list.length ? list[0].base : "";
}

/**
 * 定位宿主里的某个文件。
 * @param {string} base @deepseek-ai 基座
 * @param {string} rel  相对路径，如 `dsh-system-prompt/lib/index.js`
 */
export function hostFile(base, rel) {
  if (!base) return "";
  return path.join(base, ...String(rel).split("/"));
}

/**
 * 打印定位过程，并返回选定基座。
 * 调用方拿到空串时应显式「跳过」，而不是静默通过。
 */
export async function reportAndLocate(label = "宿主") {
  const list = await aiBaseCandidates();
  if (!list.length) {
    console.log(`${label}: 未找到（未设 DSH_PROMPT_AI_BASE / 无 dsh 安装）→ 跳过`);
    return "";
  }
  console.log(`${label}: ${list[0].base}`);
  console.log(`  来源: ${list[0].reason}`);
  if (list.length > 1) {
    for (const alt of list.slice(1)) console.log(`  其他候选: ${alt.base}  (${alt.reason})`);
  }
  return list[0].base;
}
