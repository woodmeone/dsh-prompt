/**
 * dsh-prompt · 块引擎（只读装配侧）
 *
 * 分工：
 *   · 本文件只读。装配每轮都会被调用，必须**无副作用**：不写盘、不抛。
 *   · 写入侧在 lib/prompt-edit.js。
 *
 * 两个注入位（第一性原理：U 型注意力只有两个峰）：
 *   · top  —— 拼进 systemPrompt 的一个 section（system 段内，order 排序）
 *   · tail —— 追加到本轮请求的 messages 末尾（请求期一次性，不落盘）
 *
 * 存储三档（读优先级由高到低）：
 *   1. config.json 里的内联 content
 *   2. $DSH_HOME/dsh-prompt/overrides/<id>.md
 *   3. $DSH_HOME/dsh-prompt/blocks/<id>.md
 *
 * 顺序即语义：order 升序装配；同位置内后读到的覆盖先读到的。
 */

import fs from "node:fs";
import path from "node:path";

/** 内建默认块表：随插件发行，用户不可删，可关可改可还原。 */
export const BUILTIN_BLOCKS = Object.freeze([
  { id: "core-persona", name: "人格", order: 100, enabled: true, slots: ["top"], role: "system" },
  { id: "core-style", name: "文风", order: 200, enabled: true, slots: ["top"], role: "system" },
  { id: "core-contract", name: "核心执行契约", order: 300, enabled: true, slots: ["top"], role: "system" },
  { id: "core-jailbreak", name: "破限", order: 400, enabled: true, slots: ["top"], role: "system" },
  { id: "core-armor", name: "破甲", order: 500, enabled: true, slots: ["top"], role: "system" },
  { id: "core-routing", name: "任务路由", order: 600, enabled: false, slots: ["top"], role: "system" },
  { id: "core-tail", name: "尾部续压", order: 700, enabled: true, slots: ["tail"], role: "user" },
]);

/** 两个合法注入位。 */
export const SLOTS = Object.freeze(["top", "tail"]);
export const SLOT_LABELS = Object.freeze({ top: "顶部", tail: "尾部" });

const CONFIG_FILE = "config.json";
const BLOCKS_DIR = "blocks";
const OVERRIDES_DIR = "overrides";
const TRASH_DIR = "_trash";

const MAX_BLOCK_BYTES = 512 * 1024;

/** 块目录根：$DSH_HOME/dsh-prompt */
export function blockRoot(dshHome) {
  const home = path.normalize(String(dshHome || ""));
  if (!home) return "";
  return path.join(home, "dsh-prompt");
}

export function configPath(dshHome) {
  const root = blockRoot(dshHome);
  return root ? path.join(root, CONFIG_FILE) : "";
}

export function blocksDir(dshHome) {
  const root = blockRoot(dshHome);
  return root ? path.join(root, BLOCKS_DIR) : "";
}

export function overridesDir(dshHome) {
  const root = blockRoot(dshHome);
  return root ? path.join(root, OVERRIDES_DIR) : "";
}

export function trashDir(dshHome) {
  const root = blockRoot(dshHome);
  return root ? path.join(root, TRASH_DIR) : "";
}

function readJson(fp) {
  try {
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 块 id 白名单：防目录穿越，也防 Windows 文件名非法字符。
 *
 * 为什么排除 `:` —— 它在 Windows 文件系统里非法（备用数据流分隔符），
 * `blocks/<id>.md` 会直接 EINVAL。同理排除 `*?"<>|`、控制字符、尾随点。
 *
 * 为什么排除保留名 —— CON / PRN / AUX / NUL / COM1-9 / LPT1-9 在 Windows 上
 * 无论加什么后缀都是设备名，写文件会失败或写到设备上去。
 */
const WIN_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

export function safeId(id) {
  const s = String(id || "").trim();
  if (!s) return "";
  // 只允许字母数字下划线点短横，必须字母数字或下划线开头
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(s)) return "";
  // 不以点结尾（Windows 会吃掉尾随点）
  if (s.endsWith(".")) return "";
  // Windows 保留名（大小写不敏感，且只看第一个点前那段）
  const stem = s.split(".")[0].toUpperCase();
  if (WIN_RESERVED.has(stem)) return "";
  return s;
}

/** 归一化一个块的字段，缺项补默认。 */
function normalizeBlock(item, builtinIds) {
  const id = safeId(item?.id);
  if (!id) return null;
  const slotsIn = Array.isArray(item?.slots) ? item.slots : [];
  const slots = slotsIn.filter((s) => SLOTS.includes(s));
  const roleIn = typeof item?.role === "string" ? item.role : "";
  return {
    id,
    name: typeof item?.name === "string" && item.name.trim() ? item.name.trim().slice(0, 64) : id,
    order: Number.isFinite(item?.order) ? item.order : 0,
    enabled: item?.enabled !== false,
    role: ["system", "user", "assistant"].includes(roleIn) ? roleIn : "system",
    // 一个块都不挂位置时兜到 top，避免建了块却永不生效
    slots: slots.length ? slots : ["top"],
    tailDepth: Number.isFinite(item?.tailDepth) ? item.tailDepth : 0,
    builtin: builtinIds.has(id),
  };
}

/**
 * 读配置。缺失或损坏返回内建默认。
 * 配置里漏掉的默认块补回来 —— 「默认块不可删」在数据层也成立。
 */
export function loadConfig(dshHome) {
  const raw = readJson(configPath(dshHome));
  const list = Array.isArray(raw?.blocks) ? raw.blocks : null;
  const builtinIds = new Set(BUILTIN_BLOCKS.map((b) => b.id));
  if (!list) {
    return {
      blocks: BUILTIN_BLOCKS.map((b) => ({ ...b, slots: [...b.slots], builtin: true })),
      source: "builtin",
    };
  }
  const blocks = [];
  const seen = new Set();
  for (const item of list) {
    const b = normalizeBlock(item, builtinIds);
    if (!b || seen.has(b.id)) continue;
    seen.add(b.id);
    blocks.push(b);
  }
  for (const b of BUILTIN_BLOCKS) {
    if (seen.has(b.id)) continue;
    blocks.push({ ...b, slots: [...b.slots], builtin: true });
  }
  return { blocks, source: "config" };
}

/**
 * 读一个块的正文。三档：内联 > overrides/ > blocks/。
 *
 * 关键语义：**override 文件存在就以上它为准，即使内容为空。**
 * 空 override = 用户明确要这段不发（配合「删除 override」才回落默认）。
 * 若让空 override 回落到默认正文，用户就永远无法把一块清空，只能关闭它
 * —— 那正是 dsh-purge 「清空即让位」的死路。
 *
 * 读不到返回空串，不抛。
 */
export function readBlockContent(dshHome, id) {
  const root = blockRoot(dshHome);
  const bid = safeId(id);
  if (!root || !bid) return { text: "", source: "none" };

  // 1) 内联（config 里显式带了 content 字段）
  const cfg = readJson(configPath(dshHome));
  const inline = Array.isArray(cfg?.blocks) ? cfg.blocks.find((b) => b && b.id === bid) : null;
  if (inline && typeof inline.content === "string") {
    return { text: inline.content, source: "inline" };
  }

  const cands = [
    { fp: path.join(root, OVERRIDES_DIR, `${bid}.md`), source: "override" },
    { fp: path.join(root, BLOCKS_DIR, `${bid}.md`), source: "default" },
  ];
  for (const { fp, source } of cands) {
    try {
      if (!fs.existsSync(fp)) continue;
      // override 存在即采纳（含空）；只有 blocks/ 那档才要求非空
      const text = fs.readFileSync(fp, "utf8");
      if (source === "override" || text.trim()) return { text, source };
    } catch { /* 读失败当空 */ }
  }
  return { text: "", source: "none" };
}

function pickBlocks(dshHome, slot) {
  const { blocks } = loadConfig(dshHome);
  return blocks
    .filter((b) => b.enabled)
    .filter((b) => Array.isArray(b.slots) && b.slots.includes(slot))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * 装配某一位的正文。
 * @param {string} dshHome
 * @param {string} slot
 * @param {{ withText?: boolean }} [opts] withText=true 时 parts 里带上每块正文
 *   （尾部注入要把每块单独做成一条消息，需要它；默认不带，省内存）
 * @returns {{ text: string, parts: Array<{id,name,role,bytes,source,text?}> }}
 */
export function assemble(dshHome, slot, opts = {}) {
  if (!SLOTS.includes(slot)) return { text: "", parts: [] };
  const parts = [];
  const chunks = [];
  for (const b of pickBlocks(dshHome, slot)) {
    const { text, source } = readBlockContent(dshHome, b.id);
    if (!text.trim()) continue;
    const clean = text.replace(/\r\n/g, "\n").trimEnd();
    chunks.push(clean);
    parts.push({
      id: b.id,
      name: b.name,
      role: b.role,
      bytes: text.length,
      source,
      ...opts.withText ? { text: clean } : {},
    });
  }
  return { text: chunks.join("\n\n"), parts };
}

export function assembleTop(dshHome, opts = {}) {
  return assemble(dshHome, "top", opts);
}

export function assembleTail(dshHome, opts = {}) {
  return assemble(dshHome, "tail", opts);
}

/** 状态摘要：给 UI 和自测脚本用。 */
export function describe(dshHome) {
  const { blocks, source } = loadConfig(dshHome);
  const top = assembleTop(dshHome);
  const tail = assembleTail(dshHome);
  return {
    root: blockRoot(dshHome),
    configPath: configPath(dshHome),
    blocksDir: blocksDir(dshHome),
    overridesDir: overridesDir(dshHome),
    configSource: source,
    total: blocks.length,
    enabled: blocks.filter((b) => b.enabled).length,
    builtin: blocks.filter((b) => b.builtin).length,
    topBytes: top.text.length,
    topParts: top.parts,
    // 尾部必须单独报数。只报顶部时，tail 块写在盘上、列在面板里、看起来一切正常，
    // 实际上一次都没进过对话。这个字段就是那面镜子。
    tailBytes: tail.text.length,
    tailParts: tail.parts,
    blocks: [...blocks]
      // ⚠ 必须按 order 排，不能直接吐 config 数组原序。
      //   装配（pickBlocks）走的是 order 升序；面板行序走的是这里。
      //   两处不一致时，拖拽改了 order、界面行序却纹丝不动 —— 用户以为拖拽坏了。
      //   这里对齐装配口径，拖拽的落点才是所见即所得。
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((b) => {
        const { text, source: src } = readBlockContent(dshHome, b.id);
        return {
          id: b.id,
          name: b.name,
          order: b.order,
          enabled: b.enabled,
          builtin: b.builtin,
          role: b.role,
          slots: [...b.slots],
          bytes: text.length,
          source: src,
        };
      }),
  };
}

export function maxBlockBytes() {
  return MAX_BLOCK_BYTES;
}

// ═══════════════════════════════════════════════════════════════
// 出厂内容落盘（seed）
//
// 插件自带 blocks/*.md 是「出厂内容」，只读参考。
// 首次启动把它 seed 进 $DSH_HOME/dsh-prompt/blocks/，此后以磁盘为准。
// 「恢复出厂」= 从出厂内容重新 seed。
// 这与 purge 把加密槽 seed 成 prompt-inject.md 是同一个思路。
// ═══════════════════════════════════════════════════════════════

/** 出厂块目录：插件包内的 blocks/。 */
export function factoryBlocksDir(pluginDir) {
  const dir = path.normalize(String(pluginDir || ""));
  return dir ? path.join(dir, "blocks") : "";
}

/**
 * 把出厂块正文落到 $DSH_HOME/dsh-prompt/blocks/。
 *
 * @param {string} dshHome
 * @param {string} pluginDir 插件根目录（含 blocks/）
 * @param {{ force?: boolean }} [opts] force=true 时覆盖已存在的（「恢复出厂」用）
 * @returns {{ seeded: string[], kept: string[], missing: string[] }}
 */
export function seedBlocks(dshHome, pluginDir, opts = {}) {
  const out = { seeded: [], kept: [], missing: [] };
  const src = factoryBlocksDir(pluginDir);
  const dst = blocksDir(dshHome);
  if (!src || !dst || !fs.existsSync(src)) return out;
  fs.mkdirSync(dst, { recursive: true });

  for (const b of BUILTIN_BLOCKS) {
    const from = path.join(src, `${b.id}.md`);
    const to = path.join(dst, `${b.id}.md`);
    if (!fs.existsSync(from)) { out.missing.push(b.id); continue; }
    if (!opts.force && fs.existsSync(to)) { out.kept.push(b.id); continue; }
    try {
      const text = fs.readFileSync(from, "utf8");
      const tmp = `${to}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, text, "utf8");
      fs.renameSync(tmp, to);
      out.seeded.push(b.id);
    } catch {
      out.missing.push(b.id);
    }
  }
  return out;
}

