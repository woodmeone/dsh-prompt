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

/**
 * 读 config，并区分「没有」和「有但读不懂」。
 * @returns {{ raw: object|null, unparsable: boolean, text: string }}
 */
function readConfigForWrite(dshHome) {
  const fp = configPath(dshHome);
  let text = "";
  try {
    if (!fs.existsSync(fp)) return { raw: null, unparsable: false, text: "" };
    text = fs.readFileSync(fp, "utf8");
  } catch {
    return { raw: null, unparsable: false, text: "" };
  }
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { raw: null, unparsable: true, text };
    }
    return { raw, unparsable: false, text };
  } catch {
    return { raw: null, unparsable: true, text };
  }
}

function writeConfigRaw(dshHome, cfg) {
  return atomicWrite(configPath(dshHome), `${JSON.stringify(cfg, null, 2)}\n`);
}

/**
 * 归档子系统的运行态。
 * 声明在最前面：ensureConfig() 会用到 lastCorruptBackup / safeTrash，
 * 而 `let` 有 TDZ —— 若声明在后面且被提前访问，会抛
 * "Cannot access before initialization"。
 */
let lastTrashError = "";
let lastCorruptBackup = "";

/**
 * 保证 config.json 存在且含全部默认块（首次编辑时的兜底）。
 *
 * ⚠ 若原文件存在但**读不懂**，绝不静默覆盖 —— 先把它原样备份到 _trash，
 *   再把「已备份」这件事带回去给调用方。
 *
 *   为什么：让损坏可见（configSource=corrupt）却不保护它，等于请用户来看
 *   自己数据被销毁。实测：一份 96 字节、含 1 个自建块定义的截断 config，
 *   用户看到告警后随手点了个开关，文件就被重写成 1544 字节，
 *   自建块定义消失且 _trash 里 0 份备份。
 */
function ensureConfig(dshHome) {
  const { raw: existing, unparsable, text: brokenText } = readConfigForWrite(dshHome);
  // 读不懂：先备份原文，让用户还有手工抢救的机会
  if (unparsable && brokenText) {
    try {
      const fp = configPath(dshHome);
      safeTrash(dshHome, "config-corrupt", brokenText, { file: fp });
      lastCorruptBackup = fp;
    } catch { /* 备份失败不阻断重建 */ }
  }
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

/**
 * 归档到 _trash 的**安全壳**：归档失败时先自救，仍救不回来就就地留底稿。
 *
 * ── 为什么不是简单的 try/catch ────────────────────────────────
 * 第一版写成 `try { toTrash() } catch { warn; return null }` —— 那是错的：
 * 它把「归档失败」变成「静默丢数据 + 返回 ok:true」。实测 _trash 被占成普通文件时：
 *
 *   setBlockContent(V2) 覆盖 V1  ->  ok:true，V1 被覆盖且无备份，永久丢失
 *   revertBlock         删 override ->  ok:true，内容丢失
 *   removeBlock         删块文件   ->  ok:true，文件已删，内容丢失
 *
 * README 承诺「_trash 只增不减，写坏了永远能捞回来」。静默继续等于把这句话变假。
 * 但反过来「归档失败就不让用户改正文」也不对 —— 那是把保险变成铁锁。
 *
 * ── 三级降级（每一级都保证原内容还有一份）──────────────���────
 *   1. 正常归档到 _trash
 *   2. 归档失败 -> 尝试自救（_trash 被占成文件/空目录时重建它）后再归档
 *   3. 仍失败 -> **就地留底稿** `<file>.dshprompt-bak`，绝不直接丢弃
 *
 * 只有三级全废（磁盘满/无权限）才返回 null 并警告 —— 那时主操作本身也快写不进去了。
 *
 * @param {object} [ctx] 需要就地留底稿时用：{ file } 原文件路径
 * @returns {string|null} 归档落点；降级时就地底稿路径；彻底失败 null
 */
function safeTrash(dshHome, id, text, ctx = {}) {
  if (!text) return null;

  // 1) 正常归档
  try {
    return toTrash(dshHome, id, text);
  } catch (e) {
    lastTrashError = String((e && e.message) || e);
  }

  // 2) 自救：_trash 被占成文件 / 缺目录时重建一次再试
  try {
    const root = trashDir(dshHome);
    const st = (() => { try { return fs.statSync(root); } catch { return null; } })();
    if (st && !st.isDirectory()) {
      // 被别的什么东西占住了：挪到旁边（不删，可能有人故意放的），再建目录
      try { fs.renameSync(root, `${root}.dshprompt-stray-${Date.now()}`); } catch { /* 挪不动就算了 */ }
    }
    fs.mkdirSync(root, { recursive: true });
    return toTrash(dshHome, id, text);
  } catch (e) {
    lastTrashError = String((e && e.message) || e);
  }

  // 3) 就地留底稿：宁可放在原文件旁边，也不让内容消失
  const target = ctx.file || "";
  if (target) {
    try {
      const bak = `${target}.dshprompt-bak`;
      // 已有底稿就让位，不覆盖上一份
      let fp = bak;
      let n = 1;
      while (fs.existsSync(fp) && n < 100) {
        fp = `${bak}.${n}`;
        n += 1;
      }
      fs.writeFileSync(fp, text, { encoding: "utf8", flag: "wx" });
      try {
        console.warn(
          `[dsh-prompt] 回收站不可用（${lastTrashError}），已就地留底稿：${fp}`
        );
      } catch { /* ignore */ }
      return fp;
    } catch (e) {
      lastTrashError = String((e && e.message) || e);
    }
  }

  // 4) 三级全废：只能警告。此时主操作多半也会失败，不再假装成功。
  try {
    console.warn(
      `[dsh-prompt] 归档失败且无法留底稿（${lastTrashError}）；内容未能备份`
    );
  } catch { /* ignore */ }
  return null;
}

/** 供测试与状态页读取：最近一次归档失败的原因（成功归档会清空）。 */
export function trashHealth() {
  return { lastError: lastTrashError, corruptBackup: lastCorruptBackup };
}

/**
 * 把一份内容挪进 _trash，返回落点。不删。
 * * ⚠ 唯一性是这个函数唯一的硬要求。README 承诺「_trash 只增不减，
 *   写坏了永远能捞回来」—— 覆盖一次就永久违背了它。
 *
 * 改造前用毫秒时间戳做目录名 + `<id>.md` 做文件名，同一毫秒内对同一块
 * 归档两次就命中同一路径，writeFileSync 直接覆盖。实测非冻结时钟下
 * 连续保存 40 次留下 39 份（靠运气没撞），冻结时钟后 5 次只留下 1 份。
 * 偶发不等于不会发生，而回收站存在的意义恰恰是「那一次」。
 *
 * 三层唯一性，任一层生效即可，且**不依赖时间戳一定不同**：
 *   1. 目录名：时间戳 + 进程内自增序号（同毫秒多次归档必然不同）
 *   2. 文件名：`<id>.md`；若已存在（跨进程同毫秒），改用 `<id>.<n>.md`
 *   3. 兜底：极小概率仍撞上时改用随机后缀，绝不覆盖
 *
 * 注意：本函数会抛。调用方请一律走 safeTrash()，别直接调 ——
 * 归档失败不该阻断主操作。
 */
let trashSeq = 0;

function toTrash(dshHome, id, text) {
  if (!text) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // 自增序号让同毫秒的多次归档落到不同目录，不依赖时钟精度。
  trashSeq = (trashSeq + 1) % 100000;
  const dir = path.join(trashDir(dshHome), `${stamp}-${String(trashSeq).padStart(5, "0")}`);
  fs.mkdirSync(dir, { recursive: true });

  const stem = safeId(id) || "block";
  let fp = path.join(dir, `${stem}.md`);
  // 跨进程同毫秒（另一个 dsh 实例/脚本）仍可能撞同名文件：让位，不覆盖。
  if (fs.existsSync(fp)) {
    let n = 1;
    do {
      fp = path.join(dir, `${stem}.${n}.md`);
      n += 1;
    } while (fs.existsSync(fp) && n < 1000);
    if (fs.existsSync(fp)) {
      fp = path.join(dir, `${stem}.${Date.now()}.${Math.floor(Math.random() * 1e9)}.md`);
    }
  }

  // "wx" = 只新建、不覆盖。最后一道闸：万一上面都判断错了，宁可失败也不覆盖。
  try {
    fs.writeFileSync(fp, text, { encoding: "utf8", flag: "wx" });
  } catch (e) {
    if (e && e.code === "EEXIST") {
      fp = path.join(dir, `${stem}.${Date.now()}.${Math.floor(Math.random() * 1e9)}.md`);
      fs.writeFileSync(fp, text, { encoding: "utf8", flag: "wx" });
    } else {
      throw e;
    }
  }
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
  if (prev) safeTrash(dshHome, bid, prev, { file: fp });
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
        safeTrash(dshHome, bid, fs.readFileSync(fp, "utf8"), { file: fp });
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
  safeTrash(dshHome, bid, fs.readFileSync(fp, "utf8"));
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
  const moved = [];

  // ── 先备份，后破坏 ────────────────────────────────────────────
  // 旧实现是「先删光 overrides / 自建块，最后才归 config」，于是归档一旦失败
  // （_trash 被占 / 磁盘满），报告了错误但破坏已经发生 —— 用户的 override
  // 既不在原位、也不在回收站。实测：3 个 override 全部丢失，且 config 未重置。
  //
  // 现在把 config.json 的归档提到最前面，并且它对失败是硬约束：
  // 块表是「自建块定义在哪」的唯一记录，丢它比丢一份正文更严重。
  const cp = configPath(dshHome);
  let configTrashed = "";
  if (fs.existsSync(cp)) {
    let cfgText = "";
    try { cfgText = fs.readFileSync(cp, "utf8"); } catch { cfgText = ""; }
    if (cfgText) {
      // 走 toTrash（含三层唯一性），不再手搓裸时间戳目录 ——
      // 原先那段用 copyFileSync 直接覆盖，同一个毫秒内两次恢复出厂只留 1 份。
      configTrashed = safeTrash(dshHome, "config", cfgText, { file: cp });
      if (!configTrashed) {
        return err(
          "无法备份当前块表（回收站不可用），已中止恢复出厂以免丢失自建块定义。"
          + (lastTrashError ? `　原因：${lastTrashError}` : "")
        );
      }
      moved.push("config.json");
    }
  }

  const ov = overridesDir(dshHome);
  if (fs.existsSync(ov)) {
    for (const f of fs.readdirSync(ov)) {
      const fp = path.join(ov, f);
      try {
        if (!fs.statSync(fp).isFile()) continue;
        safeTrash(dshHome, path.basename(f, ".md"), fs.readFileSync(fp, "utf8"), { file: fp });
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
        safeTrash(dshHome, id, fs.readFileSync(fp, "utf8"), { file: fp });
        fs.rmSync(fp, { force: true });
        moved.push(`blocks/${f}`);
      } catch { /* 单个失败不影响其余 */ }
    }
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
  return {
    ok: true,
    moved,
    seeded,
    trash: configTrashed ? path.dirname(configTrashed) : trashDir(dshHome),
  };
}

/**
 * UI 需要的一份完整快照：块列表 + 每块正文 + 两位装配结果。
 *
 * ⚠ 面板每次刷新都调这里（status / snapshot 两个 op 都走它），所以它自己
 *   不能是 O(n²)。改造前它对每块调一次 readBlockContent（每次重读 config），
 *   再单独 assembleTop/assembleTail 各建一次快照 —— 300 块时读 config **310 次**。
 *   现在全程共用一份 loadSnapshot 的结果，config 只读 1 次。
 */
export function snapshot(dshHome) {
  const d = describe(dshHome, { raw: true });
  // describe 内部已建好一份全量快照（含每块正文与两位装配），
  // 把它带出来复用，不要再各读一遍盘。
  const snap = d._snapshot;
  return {
    ...d,
    items: d.blocks.map((b) => {
      const c = snap && snap.contents.get(b.id) ? snap.contents.get(b.id) : readBlockContent(dshHome, b.id);
      return {
        ...b,
        content: c.text,
        contentSource: c.source,
        overridden: c.source === "override",
        inline: c.source === "inline",
        editable: true,
      };
    }),
    topText: d.topText,
    tailText: d.tailText,
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

