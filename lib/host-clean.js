/**
 * dsh-prompt · 清洗门禁（clean gate）判定
 *
 * 只回答一个问题：**这台机器上的宿主，真的被本插件改过了吗？**
 * 它读的宿主文件是 `<host>/dsh-system-prompt/lib/index.js`，因为
 * `#25 HARNESS_IDENTITY_STRIP` 与 `#40 COMPLETE_PROMPT_KEEP_INJECT`
 * 都落在这个文件里，且这两条是「身份清洗 + 注入不被丢」的最小见证。
 *
 * ── 为什么是三种状态，不是布尔 ────────────────────────────────
 *
 * 旧版只回 true/false。但「不干净」有两种完全不同的原因，后果也不同：
 *
 *   clean       —— marker 在，或者原文里那两处旧拦截已经没了。
 *   dirty       —— 宿主上有**能命中却没打上**的补丁：写盘失败、被 npm 冲掉、
 *                  用户点了应用但中途报错。这种必须拦住重启，重跑 apply。
 *   anchor-miss —— 宿主版本换了，pattern 在新版本里**根本不存在**。
 *                  再点一百次应用也变不了，和用户的机器无关。
 *                  这种拦住重启是误伤：它会把「其实已经生效」的会话变成
 *                  「看着失败、重启被取消」——Issue #2 的现场。
 *
 * 所以判定必须带**依据**回传给面板，不能只回一个布尔再让前端猜。
 */

/** 三个状态的字符串常量。面板与测试共用，避免各处自己拼字面量。 */
export const HOST_CLEAN = "clean";
export const HOST_DIRTY = "dirty";
export const HOST_ANCHOR_MISS = "anchor-miss";

const IDENTITY_MARK = "[dsh-prompt] identity stripped";
const INJECT_MARKS = [
  "[dsh-prompt] complete prompt keeps waterfall inject",
  "[dsh-prompt] complete prompt keeps inject",
  "[dsh-prompt] complete prompt keeps inject + agent-instructions",
  "[dsh-prompt] inject last after closer",
];

/** 0.1.x / 0.2.0 的旧拦截形态（慢路判据）。 */
const IDENTITY_LEFTOVER = "You are an AI agent powered by DeepSeek Harness.";
const DROPS_INJECT_020 = "transformed.sections : [completeSection]";
/** 0.2.1 的旧拦截形态：sections 被 [completeSection] 顶掉，只是写法换了一行。 */
const DROPS_INJECT_021 = "sections: completeSection === void 0 ? transformed.sections : [completeSection],";

/**
 * 判定宿主文件是否已清洗。
 *
 * ── 一条硬规矩：clean 必须有**正面证据** ──────────────────────
 *
 * 只凭「没看到旧残留」不能判 clean。对抗输入：一份完全不认识的文件，
 * 恰好不含那两句残留句，旧逻辑会放它过 —— 假绿比假红危险得多，
 * 假红只是多拦一次重启，假绿是让未清洗的宿主带着补丁启动。
 *
 * 正面证据只有一类：文件里出现 `[dsh-prompt]` —— 那就是本插件（或
 * 同源清洗路径）改过的痕迹。没有它，无论残留是否可见，都不能算 clean。
 *
 * ── 第二条硬规矩：可修性是**按残留项**算的，不是全局 ───────────
 *
 * 一处残留该不该拦重启，取决于「重跑 apply 能不能改掉这一处」。
 * 拿「本文件上还有没有任意补丁能命中」当判据是错的：0.2.1 上 #25 能命中、
 * #40 不能，全局判据会一直报 dirty，等于没修（Issue #2 换了个马甲复现）。
 *
 * 所以：身份残留看 #25 能不能命中，丢弃注入残留看 #40 能不能命中；
 * 只要**还有一处可修**，就该拦重启去修（dirty）；全部不可修才是
 * anchor-miss（版本漂移，点了也白点）。
 *
 * @param {string} text `dsh-system-prompt/lib/index.js` 正文
 * @param {{fixable?: {identity?: boolean, inject?: boolean}}} [opts]
 *   `fixable`：每一项残留**对应的补丁**在本文件上还能不能命中。
 *   调用方（core.js）算好传进来，避免本文件反向依赖 ALL_PATCHES。
 *   缺省两项都视为 true（保守：宁可报 dirty，也不错报 anchor-miss）。
 * @returns {{state:string, reasons:string[], markers:object, fixable:object, evidenced:boolean}}
 */
export function inspectHostPrompt(text, opts = {}) {
  const body = String(text || "");
  const fixableIn = opts.fixable || {};
  const fixable = {
    identity: fixableIn.identity !== false,
    inject: fixableIn.inject !== false,
  };
  const markers = {
    identity: body.includes(IDENTITY_MARK),
    inject: INJECT_MARKS.filter((m) => body.includes(m)),
  };
  /** 正面证据：任意本插件标记。 */
  const evidenced = body.includes("[dsh-prompt]");

  // 快路：两个 marker 都在 → 一定是我们改过的产物。
  if (markers.identity && markers.inject.length > 0) {
    return { state: HOST_CLEAN, reasons: [], markers, fixable, evidenced };
  }

  // 空文件或不是这份模块，不能当成已经洗过。
  if (!body.includes("system-prompt/assemble")) {
    return { state: HOST_DIRTY, reasons: ["不是 system-prompt 模块（或缺 assemble）"], markers, fixable, evidenced };
  }

  const identityLeft = body.includes(IDENTITY_LEFTOVER);
  const dropsInject = body.includes(DROPS_INJECT_020) || body.includes(DROPS_INJECT_021);
  const reasons = [];
  if (identityLeft) reasons.push("身份句未清洗");
  if (dropsInject) reasons.push("complete 模式仍会丢弃注入");

  if (evidenced && !identityLeft && !dropsInject) {
    // 有我们的标记、且旧拦截都不在：这是合法的「部分清洗」产物。
    return { state: HOST_CLEAN, reasons: [], markers, fixable, evidenced };
  }

  // 走到这里的两种情况，都**没有**足够证据：
  //   有残留且重跑 apply 还能改掉至少一处 ⇒ dirty，必须拦重启去修。
  //   有残留但每一处都改不掉（版本漂移）⇒ anchor-miss，拦了是误伤。
  const fixableLeft = [];
  if (identityLeft && fixable.identity) fixableLeft.push("身份句可修");
  if (dropsInject && fixable.inject) fixableLeft.push("注入残留可修");

  if (fixableLeft.length > 0) {
    return { state: HOST_DIRTY, reasons, markers, fixable, evidenced, fixableLeft };
  }
  if (reasons.length > 0) {
    reasons.push("锚点不命中：宿主版本不同，补丁表里没有可用的替换点");
    return { state: HOST_ANCHOR_MISS, reasons, markers, fixable, evidenced };
  }
  // 既无残留也无标记：文件干净得可疑 —— 没打过，或被 npm 冲掉了。
  reasons.push("没有本插件标记：没打过，或被 npm 冲掉了");
  return { state: HOST_DIRTY, reasons, markers, fixable, evidenced };
}

/**
 * 旧签名兼容壳：只回布尔。
 *
 * 保留它是因为 desktop.js / core.js 里有多处既有调用；新代码请用
 * inspectHostPrompt() 拿三态与依据。语义收紧为「clean 才算 true」，
 * 因此 anchor-miss 不再冒充“洗过了”——它只在重启门禁那一处被特赦
 * （见 core.js 的 ensureHostClean）。
 */
export function hostPromptKeepsInject(text) {
  return inspectHostPrompt(text).state === HOST_CLEAN;
}
