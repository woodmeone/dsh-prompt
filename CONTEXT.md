# dsh-prompt 术语表

> 只放术语。模块结构见 README，决策理由见 `docs/adr/`。

## 提示词装配

**块（block）**
一段提示词正文 + 一组元数据（id / name / order / enabled / role / slots）。块是唯一可操作单位。

**位置 / 槽（slot）**
块被注入的地方，只有 `top` 和 `tail` 两个。
- `top`：拼进 systemPrompt 的一个 section
- `tail`：追加到本轮请求的 messages 末尾

**块表（block table）**
`config.json` 里的 `blocks` 数组。决定有哪些块、各自顺序/开关/位置/角色。

**三档读**
取块正文的三层优先级，由高到低：`config.json` 内联 `content` ＞ `overrides/<id>.md` ＞ `blocks/<id>.md`。

**空 override**
`overrides/<id>.md` 存在但内容为空。**这是有效状态**，含义是"我明确要这一段不发"；
要回到出厂正文得删掉这个文件（面板的「还原」），而不是把正文清空。

**出厂正文（factory content / seed）**
插件包内 `blocks/*.md` 的原文。首次启动被 seed 到 `$DSH_HOME/dsh-prompt/blocks/`。

## 宿主与补丁

**宿主（host）**
正在运行的 DeepSeek Harness 那份安装。块引擎要往里注入内容，清洗层要往里打补丁。

**宿主补丁（host patch）**
改写宿主包源码的补丁，共 82 个（`core.ALL_PATCHES`）。标记前缀 `[dsh-prompt]`，
与 `[dsh-purge]` / `[dsh-loom]` 可分辨。

**补丁口径（patch tally）**
一份补丁状态快照派生出的**全部计数**。约束是它们彼此可加和：
`total ≡ applied + already + pending + unmatched + skipped + missing_file + na`。
由 `core.tallyPatchStatus()` 单点产出，其它地方一律派生，不许自己重数。

**不适用（na）**
补丁与当前 surface（web / desktop）不匹配，或 `patchStatus` 显式标 na。
**计入分母**——「82 项里有 10 项不适用」和「只有 72 项」是完全不同的两句话。

**适用分母（applicable）**
`total - na`。用于**完成度 / 进度条**。与 `total` 分工：
`total` 用来和 `patch_status` 的键数对账，`applicable` 用来表达「能打的都打完了吗」。
两者混用会导致进度条永远停在 88%（实测 72/82）。

**补丁丢失（patch loss）**
有 applied 戳但宿主回滚了（asar 又密封 / 清洗标记消失）。判定是三态：
- `lost` —— 确认丢了
- `ok` —— 有戳且宿主仍清洗过
- `unknown` —— 没有戳或定位不到宿主，**没有依据下结论**

`unknown` 不等于 `ok`。把两者折叠成一个 `false` 就是谎报。

**密封（sealed asar）**
官方桌面版把宿主封进 `app.asar`。此时 `resources/app` 不存在，补丁无处可打，
需要先解包（见 `lib/extract-asar.js`）。状态字段 `asar_still_sealed`。

## 体积与单位

**字节口径（byte semantics）**
对外报体积一律用 **UTF-8 字节**，与 512 KB 单块上限同一口径。不是字符数：
中文一个汉字 = 3 字节，emoji 通常 4 字节。
