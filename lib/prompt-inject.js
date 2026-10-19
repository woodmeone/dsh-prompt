/**
 * dsh-prompt · 注入层
 *
 * 两个位置，两条完全不同的机制：
 *
 *   top  —— systemPrompt.section({ order, text })
 *           所有 section 被 renderPrompt 拼成一条 system 消息。
 *           order 决定它在那条消息内部排第几段。
 *
 *   tail —— **不落盘的请求期追加**。
 *           在 live 宿主的 buildRequest 组装点，把块正文接到 messages 末尾。
 *
 * ── 为什么 tail 不能用 agent/pre-step ─────────────────────────
 *
 * live 宿主 `dsh-agent-loop` 会把 pre-step 返回的 messages 逐条落进持久日志：
 *
 *     // lib/index.js:1077
 *     if (firstAttempt) for (const message of decision.messages)
 *       this.session.append("user/message", message, { surfaceOp: "append" });
 *
 * 而每轮请求的边界消息来自持久日志的投影：
 *
 *     // lib/index.js:1278
 *     const boundaryMessages = session.deriveMessages();
 *
 * 于是「pre-step 注入 tail」= 每轮往历史里追加一份 → 20 轮就是 20 份同样的续压块。
 * 上下文膨胀 + 同段重复 → 指令冗余 → 注意力稀释。这是 dsh-loom 效果差的根因。
 *
 * 正确做法：在 `messages: boundaryMessages` 组装点追加。
 * 只影响这一轮的请求对象，不进 session log，因而不累积。
 *
 * 附带收益：请求期数组不落盘，就不受 session 的角色校验约束
 * （`user/message message must have role "user"` 只在落盘/加载边界检查）。
 */

import { GLOBAL_PROMPT_ORDER } from "./identity.js";

/** 顶部段在 system 内部的 order。取 -100000，与 purge 主段同位（我们只注册一个主段）。 */
export const TOP_ORDER = GLOBAL_PROMPT_ORDER;

/** 尾部块的默认角色。user = 「当指令」，遵从度高于 system。 */
export const DEFAULT_TAIL_ROLE = "user";

/**
 * 把一段文本包成请求期消息对象（RequestUserInput 形态）。
 *
 * 形状依据 `@deepseek-ai/dsh-llm` types.d.ts：
 *   RequestUserInput = { role:'user', content: UserMessage['content'], id?: never, source?: never }
 *
 * 请求期消息**不带 id / source**，因此不会与持久历史的 Message 混淆。
 */
export function makeRequestMessage(text, role = "system") {
  const body = String(text ?? "");
  if (!body.trim()) return null;
  return {
    role: role === "assistant" || role === "user" ? role : "system",
    content: [{ type: "text", text: body }],
  };
}

/**
 * 把尾部块组装成请求期消息数组。
 * @returns {Array<{role:string,content:Array}>}
 */
export function buildTailMessages(assembled) {
  const out = [];
  if (!assembled || !String(assembled.text || "").trim()) return out;
  // 每个块一条消息，保留各自声明的角色（块级 role 是一等字段）。
  for (const part of assembled.parts || []) {
    const msg = makeRequestMessage(part.text ?? "", part.role || DEFAULT_TAIL_ROLE);
    if (msg) out.push(msg);
  }
  return out;
}

/** 顶部 section 的 name；独立前缀便于卸载时精确回收。 */
export const TOP_SECTION_NAME = "dsh-prompt";

/**
 * 注册顶部 section。
 *
 * 契约要点：
 *   · text 是函数 → 每次组装重新求值，改块立即生效
 *   · 返回 "" 的 section 会被 renderPrompt 过滤掉（合法的「静默关掉」）
 *   · interpolate:false → 正文里的 {{ }} 不被 dsh 模板引擎二次解释
 *
 * @param {object} ctx 插件上下文
 * @param {() => { text: string, parts: Array }} readTop 每次求值都调，读最新块状态
 * @returns {boolean} 是否注册成功
 */
export function registerTopSection(ctx, readTop) {
  const hosts = [];
  const push = (host) => { if (host && !hosts.includes(host)) hosts.push(host); };
  try { push(ctx?.systemPrompt?.ctx); } catch { /* 代理未注入时点属性会抛 */ }
  push(ctx);

  const disposers = [];
  let registered = false;
  let lastError = null;
  for (const host of hosts) {
    try {
      const d = host.systemPrompt.section({
        name: TOP_SECTION_NAME,
        order: TOP_ORDER,
        interpolate: false,
        text: () => {
          try {
            const assembled = readTop();
            return String(assembled?.text || "");
          } catch {
            // 装配不许把注入弄塌：出错降级成空段
            return "";
          }
        },
      });
      registered = true;
      if (typeof d === "function") disposers.push(d);
    } catch (error) {
      const msg = String((error && error.message) || error);
      // 同名 section 重复注册时按已注册处理，避免热重载把 apply 炸掉
      if (msg.includes("already registered")) registered = true;
      else lastError = error;
    }
  }
  if (!registered && lastError) throw lastError;
  if (disposers.length && typeof ctx?.effect === "function") {
    try {
      ctx.effect(() => () => {
        for (const d of disposers) {
          try { d(); } catch { /* ignore */ }
        }
      });
    } catch { /* 死 ctx */ }
  }
  return registered;
}
