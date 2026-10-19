/**
 * dsh-prompt · 宿主补丁表
 *
 * 只在 live 宿主 `@deepseek-ai/dsh-agent-loop/lib/index.js` 的**唯一组装点**上追加。
 *
 * ── 为什么是这一处 ────────────────────────────────────────────
 *
 * live 宿主（@deepseek-ai/dsh@0.2.0-rc.2）的 buildRequest：
 *
 *     const boundaryMessages = session.deriveMessages();          // ← 锚点 A（唯一）
 *     for (const message of boundaryMessages) { ... deepFreeze(message); }
 *     Object.freeze(boundaryMessages);
 *     return markAgentLoopRequest(Object.freeze({
 *       ...header.config,
 *       messages: boundaryMessages,                                // ← 锚点 B（唯一）
 *       toolHistory: session.toolHistory(),
 *       ...
 *     }));
 *
 * 在锚点 B 处把尾部块拼进 messages：**只进这一轮请求，不进 session log**。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────
 *
 * 1. **不写 session。** 一旦落到 session log，就会在下一轮被 deriveMessages 投影回
 *    请求里，逐轮累积。这是 dsh-loom 的失败点。
 * 2. **标记独立。** 用 `[dsh-prompt]` 前缀，与 `[dsh-purge]` / `[dsh-loom]` 可分辨。
 * 3. **失败降级成空。** 任何异常都让请求按原样发出，不许把主流程炸掉。
 *
 * 补丁通过 `globalThis.__dshPromptTail` 读内容 ——
 * 宿主读的是**回调**，不是快照，所以改块立即生效，不用重启。
 */

/** 宿主读尾部块的回调名。 */
export const TAIL_HOOK = "__dshPromptTail";

/** 宿主读顶部兜底全文的回调名（可选，用于覆盖 system 置顶）。 */
export const TOP_HOOK = "__dshPromptTop";

/** 补丁标记前缀。 */
export const MARK = "[dsh-prompt]";

const PATCH_MARK_TAIL = `${MARK} append tail blocks to this turn's request`;
const NEEDLE_TAIL = `${MARK} strict needle`;

/** needle 标记文本（测试与状态页引用）。 */
export const NEEDLE_TAIL_TEXT = NEEDLE_TAIL;

/**
 * 定位 buildRequest 组装点。
 * 返回旧的 pattern 文本与新的 replace 文本。
 *
 * 锚点取自 live 宿主真实字节（含 tab 缩进，已核对）：
 *   line 1278: \t\tconst boundaryMessages = session.deriveMessages();
 *   line 1287: \t\t\tmessages: boundaryMessages,
 */
export function tailPatch() {
  return {
    id: "TAIL_INJECT_AT_BUILD_REQUEST",
    name: "TAIL_INJECT_AT_BUILD_REQUEST",
    layer: "代码",
    layer_en: "Code",
    desc: "把尾部块拼进本轮请求的 messages（不落盘，不累积）/ append tail blocks to this turn's request",
    file: ["agent-loop"],
    markers: [PATCH_MARK_TAIL],
    // 升级链：旧版把 tail 拼在别处时，这里改回
    //
    // 幂等性关键：pattern 以 `const boundaryMessages` 开头，replace 以 `let` 开头 —
    // pattern 不再出现在结果里，所以重复施加是 no-op。
    // needle 标记也一并写进 replace，让「一次施加即完整」。
    replacements: [
      {
        pattern:
          "\t\tconst boundaryMessages = session.deriveMessages();\n" +
          "\t\tfor (const message of boundaryMessages) {",
        replace:
          `\t\tlet boundaryMessages = session.deriveMessages();\n` +
          `\t\t// ${PATCH_MARK_TAIL}\n` +
          `\t\t// ${NEEDLE_TAIL}\n` +
          `\t\t{\n` +
          `\t\t\tconst __dshPromptTailFn = globalThis.${TAIL_HOOK};\n` +
          `\t\t\tif (typeof __dshPromptTailFn === "function") {\n` +
          `\t\t\t\ttry {\n` +
          `\t\t\t\t\tconst __dshPromptExtra = __dshPromptTailFn();\n` +
          `\t\t\t\t\tif (Array.isArray(__dshPromptExtra) && __dshPromptExtra.length > 0) {\n` +
          `\t\t\t\t\t\tboundaryMessages = Object.freeze([...boundaryMessages, ...__dshPromptExtra]);\n` +
          `\t\t\t\t\t}\n` +
          `\t\t\t\t} catch { /* ${MARK} tail hook failed: this turn goes out unchanged */ }\n` +
          `\t\t\t}\n` +
          `\t\t}\n` +
          `\t\tfor (const message of boundaryMessages) {`,
      },
    ],
  };
}

/**
 * 旧版升级：v1 的主补丁只写了 marker，没有 needle。
 *
 * 幂等性关键：pattern 把 marker 后面的 `{\n` 一起吃进来，
 * replace 在中间插入 needle 行 —— 施加后 pattern 不再出现，重复施加是 no-op。
 *
 * 主补丁已自带 needle 时，本补丁的 pattern 根本不匹配（中间隔着 needle 行）→ no-op。
 */
export function tailPatchNeedle() {
  return {
    id: "TAIL_INJECT_NEEDLE",
    name: "TAIL_INJECT_NEEDLE",
    layer: "代码",
    layer_en: "Code",
    desc: "旧版主补丁补齐 needle 标记（幂等：pattern 自消耗）/ upgrade an older main patch in place",
    file: ["agent-loop"],
    markers: [NEEDLE_TAIL],
    replacements: [
      {
        pattern:
          `\t\t// ${PATCH_MARK_TAIL}\n` +
          `\t\t{\n`,
        replace:
          `\t\t// ${PATCH_MARK_TAIL}\n` +
          `\t\t// ${NEEDLE_TAIL}\n` +
          `\t\t{\n`,
      },
    ],
  };
}

/** 本插件对宿主打的补丁全集。 */
export const PROMPT_PATCHES = [tailPatch(), tailPatchNeedle()];

/**
 * 旧标记清理：宿主上可能残留别的插件的尾部注入补丁（dsh-loom 的 pre-step 追加）。
 * 这里只做**检测与上报**，不擅自删除别人的补丁 —— 删了可能让用户另一个插件失效。
 * 状态页会把这行显示出来，让用户知道宿主被谁改过。
 */
export function detectForeignTailPatches(text) {
  const hits = [];
  if (/\[dsh-loom/.test(text)) hits.push("dsh-loom");
  if (/\[dsh-purge/.test(text)) hits.push("dsh-purge");
  return hits;
}
