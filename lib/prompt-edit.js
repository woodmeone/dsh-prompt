/**
 * dsh-prompt · 块的写入侧（增 / 删 / 改 / 排序 / 开关 / 还原）
 *
 * 与 lib/prompt-blocks.js 的分工：
 *   prompt-blocks.js 只读（装配用，必须无副作用）
 *   本文件负责写：改内容、开关、排序、位置、增删、撤销、恢复出厂
 *
 * 写入规则：
 *   · 改一个块正文 → 写 overrides/<id>.md，blocks/<id>.md 原样不动
 *   · 恢复出厂     → 删 overrides/<id>.md，被删内容进 _trash/<时间戳>/
 *   · 撤销本次改动 → 同上（只对有 override 的块有效）
 *   · 改开关/顺序/位置/角色 → 只动 config.json，不碰正文
 *
 * 所有写入走 tmp + rename，避免半写坏的文件被装配读到残片。
 */

import fs from "node:fs";
import path from "node:path";
import {
  BUILTIN_BLOCKS,
  SLOTS,
  blockRoot,
  configPath,
  blocksDir,
  overridesDir,
  trashDir,
  safeId,
  maxBlockBytes,
  describe,
  readBlockContent,
  assembleTop,
  assembleTail,
  seedBlocks,
} from "./prompt-blocks.js";

/** 原子写：写 tmp 再 rename。同目录保证 rename 是原子的。 */
function atomicWrite(fp, text) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.renameSync(tmp, fp);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉就算了 */ }
    throw error;
  }
  return fp;
}

function readConfigRaw(dshHome) {
  try {
    const fp = configPath(dshHome);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function writeConfigRaw(dshHome, cfg) {
  return atomicWrite(configPath(dshHome), `${JSON.stringify(cfg, null, 2)}\n`);
}

/** 保证 config.json 存在且含全部默认块（首次编辑时的兜底）。 */
function ensureConfig(dshHome) {
  const existing = readConfigRaw(dshHome);
  if (existing && Array.isArray(existing.blocks)) {
    const ids = new Set(existing.blocks.map((b) => b?.id));
    let dirty = false;
    for (const b of BUILTIN_BLOCKS) {
      if (ids.has(b.id)) continue;
      existing.blocks.push({
        id: b.id, name: b.name, order: b.order, enabled: b.enabled,
        role: b.role || "system", slots: [...b.slots], tailDepth: 0,
      });
      dirty = true;
    }
    // 老配置里可能先落成 tailDepth/slot 单数形态，这里统一形状
    for (const item of existing.blocks) {
      if (!Array.isArray(item.slots) || !item.slots.length) {
        const single = typeof item.slot === "string" && SLOTS.includes(item.slot) ? [item.slot] : ["top"];
        item.slots = single;
        delete item.slot;
        dirty = true;
      }
      if (!["system", "user", "assistant"].includes(item.role)) {
        item.role = "system";
        dirty = true;
      }
    }
    if (dirty) writeConfigRaw(dshHome, existing);
    return existing;
  }
  const cfg = {
    $comment: "dsh-prompt 块目录。order 决定装配次序（顺序即语义）；builtin 块不可删，可关可改可还原。",
    version: 1,
    blocks: BUILTIN_BLOCKS.map((b) => ({
      id: b.id, name: b.name, order: b.order, enabled: b.enabled,
      role: b.role || "system", slots: [...b.slots], tailDepth: 0,
    })),
  };
  writeConfigRaw(dshHome, cfg);
  return cfg;
}

/** 把一份内容挪进 _trash，返回落点。不删。 */
function toTrash(dshHome, id, text) {
  if (!text) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(trashDir(dshHome), stamp);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${safeId(id) || "block"}.md`);
  fs.writeFileSync(fp, text, "utf8");
  return fp;
}

function err(message) {
  return { ok: false, error: message };
}

/**
 * 统一错误包装：所有写操作对外只返回 {ok:false,error}，**不裸抛**。
 * HTTP 桥、面板、工具调用都不该因为一次写盘失败而炸掉整个调用栈。
 */
function guard(fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (e) {
      return err(`内部错误: ${e?.message || e}`);
    }
  };
}

/** 改块正文 → 写 override。 */
function setBlockContentImpl(dshHome, id, content) {
  const bid = safeId(id);
  if (!bid) return err("非法块 id");
  const text = String(content ?? "");
  if (Buffer.byteLength(text, "utf8") > maxBlockBytes()) return err("块正文过大（上限 512KB）");
  const cfg = ensureConfig(dshHome);
  if (!cfg.blocks.some((b) => b.id === bid)) return err(`块不存在: ${bid}`);
  const fp = path.join(overridesDir(dshHome), `${bid}.md`);
  let prev = "";
  try { prev = fs.readFileSync(fp, "utf8"); } catch { /* 无旧 override */ }
  if (prev) toTrash(dshHome, bid, prev);
  atomicWrite(fp, text);
  return { ok: true, path: fp, overridden: true };
}

/** 新建自建块。 */
function addBlockImpl(dshHome, input = {}) {
  const bid = safeId(input.id);
  if (!bid) return err("非法块 id（只允许字母数字与 _ . -，需以字母数字或 _ 开头；不含冒号与 Windows 保留名）");
  if (BUILTIN_BLOCKS.some((b) => b.id === bid)) return err(`与默认块重名: ${bid}`);
  const cfg = ensureConfig(dshHome);
  if (cfg.blocks.some((b) => b.id === bid)) return err(`块已存在: ${bid}`);

  // 先校验正文，再动 config —— 否则超限时 config 已被污染，块会以「无正文」状态留下
  const content = String(input.content ?? "");
  if (content.trim() && Buffer.byteLength(content, "utf8") > maxBlockBytes()) {
    return err("块正文过大（上限 512KB）");
  }

  const slots = Array.isArray(input.slots) ? input.slots.filter((s) => SLOTS.includes(s)) : [];
  const role = ["system", "user", "assistant"].includes(input.role) ? input.role : "system";
  const maxOrder = cfg.blocks.reduce((n, b) => Math.max(n, Number(b.order) || 0), 0);
  const entry = {
    id: bid,
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 64) : bid,
    order: Number.isFinite(input.order) ? input.order : maxOrder + 100,
    enabled: input.enabled !== false,
    role,
    slots: slots.length ? slots : ["top"],
    tailDepth: 0,
  };

  // 正文先写：写失败就不动 config，不留下「有块无正文」的半成品
  if (content.trim()) {
    try {
      atomicWrite(path.join(blocksDir(dshHome), `${bid}.md`), content);
    } catch (e) {
      return err(`写入块正文失败: ${e?.message || e}`);
    }
  }
  cfg.blocks.push(entry);
  try {
    writeConfigRaw(dshHome, cfg);
  } catch (e) {
    // config 写失败 → 把刚写的正文也撤掉，保持「要么都有，要么都没有」
    try { fs.rmSync(path.join(blocksDir(dshHome), `${bid}.md`), { force: true }); } catch { /* ignore */ }
    return err(`写入 config 失败: ${e?.message || e}`);
  }
  return { ok: true, block: entry };
}

/** 删块。默认块不可删，只能关。 */
function removeBlockImpl(dshHome, id) {
  const bid = safeId(id);
  if (!bid) return err("非法块 id");
  const cfg = ensureConfig(dshHome);
  const idx = cfg.blocks.findIndex((b) => b.id === bid);
  if (idx < 0) return err(`块不存在: ${bid}`);
  if (BUILTIN_BLOCKS.some((b) => b.id === bid)) return err(`默认块不可删除: ${bid}（可以关闭，或用「恢复出厂」重置内容）`);
  cfg.blocks.splice(idx, 1);
  writeConfigRaw(dshHome, cfg);
  for (const sub of [blocksDir(dshHome), overridesDir(dshHome)]) {
    const fp = path.join(sub, `${bid}.md`);
    try {
      if (fs.existsSync(fp)) {
        toTrash(dshHome, bid, fs.readFileSync(fp, "utf8"));
        fs.rmSync(fp, { force: true });
      }
    } catch { /* 删不掉就留着，不影响装配 */ }
  }
  return { ok: true };
}

/**
 * 改元数据：开关 / 顺序 / 位置 / 角色 / 改名。只动 config，不碰正文。
 * 不传的字段保持原值。
 */
function updateBlockMetaImpl(dshHome, id, patch = {}) {
  const bid = safeId(id);
  if (!bid) return err("非法块 id");
  const cfg = ensureConfig(dshHome);
  const b = cfg.blocks.find((x) => x.id === bid);
  if (!b) return err(`块不存在: ${bid}`);

  if (typeof patch.enabled === "boolean") b.enabled = patch.enabled;
  if (Number.isFinite(patch.order)) b.order = patch.order;
  if (typeof patch.name === "string" && patch.name.trim()) b.name = patch.name.trim().slice(0, 64);
  if (Array.isArray(patch.slots)) {
    const ok = patch.slots.filter((s) => SLOTS.includes(s));
    if (!ok.length) return err("slots 至少要保留一个位置（top / tail）");
    b.slots = ok;
  }
  if (["system", "user", "assistant"].includes(patch.role)) b.role = patch.role;
  if (Number.isFinite(patch.tailDepth)) b.tailDepth = patch.tailDepth;
  writeConfigRaw(dshHome, cfg);
  return { ok: true, block: b };
}

/**
 * 拖拽排序：一次提交某个位置下的完整顺序。
 * 传 ids 数组（该位置的块 id，按目标顺序）→ 重新分配 order 为等距整数。
 * 只重排「属于该位置」的块；跨位置的块不受影响。
 */
function reorderBlocksImpl(dshHome, slot, ids) {
  if (!SLOTS.includes(slot)) return err(`非法位置: ${slot}`);
  if (!Array.isArray(ids) || !ids.length) return err("ids 必须是非空数组");
  const cfg = ensureConfig(dshHome);
  const wanted = ids.map((x) => safeId(x)).filter(Boolean);
  if (wanted.length !== ids.length) return err("ids 里含非法块 id");

  // 所在位置的全部块（含被关掉的，顺序也要留住）
  const inSlot = cfg.blocks.filter((b) => Array.isArray(b.slots) && b.slots.includes(slot));
  const inSlotIds = new Set(inSlot.map((b) => b.id));
  for (const id of wanted) {
    if (!inSlotIds.has(id)) return err(`块 ${id} 不属于位置 ${slot}`);
  }
  // 只排 wanted 里给的这些，其余按原 order 续在后面
  const rest = inSlot.filter((b) => !wanted.includes(b.id)).sort((a, b) => a.order - b.order);
  const ordered = [...wanted, ...rest.map((b) => b.id)];

  // 等距 100，从这个位置原有最小 order 起排，保持与其他位置的相对关系不变
  const baseOrder = inSlot.length ? Math.min(...inSlot.map((b) => b.order)) : 0;
  ordered.forEach((id, i) => {
    const b = cfg.blocks.find((x) => x.id === id);
    if (b) b.order = baseOrder + i * 100;
  });
  writeConfigRaw(dshHome, cfg);
  return { ok: true, order: ordered };
}

/** 撤销本次改动：删 override，回到默认块内容。 */
function revertBlockImpl(dshHome, id) {
  const bid = safeId(id);
  if (!bid) return err("非法块 id");
  const fp = path.join(overridesDir(dshHome), `${bid}.md`);
  if (!fs.existsSync(fp)) return err(`没有可撤销的改动: ${bid}`);
  toTrash(dshHome, bid, fs.readFileSync(fp, "utf8"));
  fs.rmSync(fp, { force: true });
  return { ok: true, reverted: bid };
}

/**
 * 恢复出厂：override 进 trash，blocks/ 用出厂内容重置，config 回到内建默认表。
 * 只动 dsh-prompt 自己的数据目录，不碰任何宿主文件。
 *
 * @param {string} dshHome
 * @param {string} [pluginDir] 插件根目录；给了就重新 seed 出厂块内容
 */
function restoreFactoryImpl(dshHome, pluginDir = "") {
  const base = blockRoot(dshHome);
  if (!base) return err("拿不到 DSH_HOME");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const moved = [];

  const ov = overridesDir(dshHome);
  if (fs.existsSync(ov)) {
    for (const f of fs.readdirSync(ov)) {
      const fp = path.join(ov, f);
      try {
        if (!fs.statSync(fp).isFile()) continue;
        toTrash(dshHome, path.basename(f, ".md"), fs.readFileSync(fp, "utf8"));
        fs.rmSync(fp, { force: true });
        moved.push(`overrides/${f}`);
      } catch { /* 单个失败不影响其余 */ }
    }
  }

  // 自建块整份进 trash，只留默认块
  const builtinIds = new Set(BUILTIN_BLOCKS.map((b) => b.id));
  const bd = blocksDir(dshHome);
  if (fs.existsSync(bd)) {
    for (const f of fs.readdirSync(bd)) {
      if (!f.endsWith(".md")) continue;
      const id = f.slice(0, -3);
      if (builtinIds.has(id) && !pluginDir) continue;
      const fp = path.join(bd, f);
      try {
        if (!fs.statSync(fp).isFile()) continue;
        toTrash(dshHome, id, fs.readFileSync(fp, "utf8"));
        fs.rmSync(fp, { force: true });
        moved.push(`blocks/${f}`);
      } catch { /* 单个失败不影响其余 */ }
    }
  }

  const cp = configPath(dshHome);
  if (fs.existsSync(cp)) {
    const dir = path.join(trashDir(dshHome), stamp);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(cp, path.join(dir, "config.json"));
    moved.push("config.json");
  }
  const cfg = {
    $comment: "dsh-prompt 块目录。order 决定装配次序（顺序即语义）；builtin 块不可删，可关可改可还原。",
    version: 1,
    blocks: BUILTIN_BLOCKS.map((b) => ({
      id: b.id, name: b.name, order: b.order, enabled: b.enabled,
      role: b.role || "system", slots: [...b.slots], tailDepth: 0,
    })),
  };
  writeConfigRaw(dshHome, cfg);

  // 出厂内容落盘（覆盖式）
  let seeded = null;
  if (pluginDir) {
    seeded = seedBlocks(dshHome, pluginDir, { force: true });
  }
  return { ok: true, moved, seeded, trash: path.join(trashDir(dshHome), stamp) };
}

/** UI 需要的一份完整快照：块列表 + 每块正文 + 两位装配结果。 */
export function snapshot(dshHome) {
  const d = describe(dshHome);
  return {
    ...d,
    items: d.blocks.map((b) => {
      const c = readBlockContent(dshHome, b.id);
      return {
        ...b,
        content: c.text,
        contentSource: c.source,
        overridden: c.source === "override",
        inline: c.source === "inline",
        editable: true,
      };
    }),
    topText: assembleTop(dshHome).text,
    tailText: assembleTail(dshHome).text,
  };
}

// ═══════════════════════════════════════════════════════════════
// 对外导出：全部包 guard
//
// 写操作对外只返回 {ok:false,error}，不裸抛。调用方（HTTP 桥 / 面板 /
// 工具调用）不该因为一次写盘失败就炸掉整个调用栈。
// ═══════════════════════════════════════════════════════════════

export const setBlockContent = guard(setBlockContentImpl);
export const addBlock = guard(addBlockImpl);
export const removeBlock = guard(removeBlockImpl);
export const updateBlockMeta = guard(updateBlockMetaImpl);
export const reorderBlocks = guard(reorderBlocksImpl);
export const revertBlock = guard(revertBlockImpl);
export const restoreFactory = guard(restoreFactoryImpl);

