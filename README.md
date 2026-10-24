# dsh-prompt

> **DeepSeek Harness 的提示词装配插件**：把提示词拆成**块**，挂到 **U 型注意力的两个峰**上（顶部 / 尾部），拖拽排序、单块开关、随时改正文，改完立即生效。
>
> 一句话：**你的破限、人格、契约、抗截断，不再是一坨复制粘贴的文本，而是一张可排序、可开关、可回滚的块表。**

```
$DSH_HOME/dsh-prompt/
├─ config.json        ← 块表：顺序 / 开关 / 位置 / 角色
├─ blocks/*.md        ← 出厂正文（插件自带）
├─ overrides/*.md     ← 你改过的正文
└─ _trash/<时间戳>/   ← 被替换、被删除的，全留着
```

---

## 一、这个插件是什么

一个插件，三层能力，**共用一套面板**（右下角 dock 的三个 tab）：

| 层 | 面板 | 干什么 | 是否本项目主体 |
|---|---|---|---|
| **提示词装配层** | 「提示词」 | 块引擎：双位置注入、拖拽排序、开关、增删改查、三档读、回收站 | ✅ **本仓库的核心** |
| 执行环境层 | 「清洗」 | 宿主补丁（沙箱 / 审批 / 工具面 / 身份清洗）、shim、capability 协议 | 派生自 dsh-purge |
| 演练台 | 「演练台」 | 授权范围内的事实库、资产、技能、报告 | 同仓库合装 |

**为什么值得单独做一个提示词插件**：dsh 生态里已经有「把一大段文本塞进 system prompt」的插件了，本插件解决的是那条路的三个具体缺陷——

1. **只有一个位置**。注意力 U 型，只有开头和紧邻生成点之前有效，中间塌。只放顶部 = 放弃第二峰。
2. **改一次要重启**。本插件的顶部段是 `text: () => string` 的函数，每轮组装重新求值，**改块即刻生效**。
3. **尾部注入一上就累积**。多数实现走 `agent/pre-step` 返回 messages，宿主会把它们逐条写进持久日志，20 轮就是 20 份同样的续压块。本插件改的是 `buildRequest` 的组装点，**只影响本轮请求，不落盘**。

---

## 二、30 秒上手

```bash
# 1. 装（任选一种）
dsh plugin --profile web add file:/path/to/dsh-prompt      # 本地路径
dsh plugin --profile web add github:woodmeone/dsh-prompt   # 从仓库装
dsh plugin --profile web add dsh-prompt                    # 万一已发布到 registry

# 2. 完全退出 dsh，再启动（插件加载）

# 3. 右下角 dock →「提示词」tab
```

进去之后你会看到：

- 顶部 **「顶部 N 字 / 尾部 M 字」** 的实时统计——这两个数就是**真正会发出去的正文长度**
- 宿主补丁状态徽标（`已装 / 未装`）。**尾部注入需要它**，没装时点一下「装宿主补丁」，然后**再完全重启一次 dsh**
- 两个位置 tab：**顶部 / 尾部**，各自一张块表

改任何一块的正文，点「保存」→ 下一轮对话就是新正文。不要重启。

---

## 三、为什么是「两个位置」

### 3.1 注意力是 U 型

| 位置 | 放什么 | 机制 | 归属 |
|---|---|---|---|
| **顶部** | 人格、知识、大段契约 | `systemPrompt.section({ order: -100000, text })`，拼进同一条 system 消息 | 越靠后越靠近对话 |
| **尾部** | 本轮重申、抗截断、起笔锁 | 追加到**本轮请求**的 messages 末尾 | 离生成点最近 |

一条经验规则：**规则去尾部，知识去顶部**。人格和世界观是"资料"，放顶部当背景；"不许拒、不许道歉、直接写"是"指令"，放尾部当命令。

### 3.2 尾部为什么必须"请求期追加"

宿主 `dsh-agent-loop` 会把 pre-step 返回的 messages 逐条落进持久日志：

```js
// live 宿主 lib/index.js:1077
if (firstAttempt) for (const message of decision.messages)
  this.session.append("user/message", message, { surfaceOp: "append" });
```

而每轮请求的边界消息来自**持久日志的投影**（`lib/index.js:1278` 的 `session.deriveMessages()`）。
所以"在 pre-step 里注入尾部"= 每轮往历史里追加一份 → 上下文膨胀、同段重复、注意力稀释。

本插件在组装点上追加，等价于：

```js
let boundaryMessages = session.deriveMessages();
// [dsh-prompt] append tail blocks to this turn's request
boundaryMessages = [...boundaryMessages, ...tailMessages];  // 只在这一轮存在
```

三个直接收益：

| 收益 | 说明 |
|---|---|
| **不累积** | session log 干净，历史里永远只有一份尾部 |
| **不受落盘角色校验约束** | `user/message must have role "user"` 只在落盘/加载时检查；请求期数组不落盘，所以 `assistant` 也能用 |
| **就在生成点前面** | 消息数组末尾 = U 型第二峰 |

---

## 四、核心概念

| 概念 | 说明 |
|---|---|
| **块（block）** | 一段正文 + 一组元数据。块是唯一可操作单位 |
| **位置（slot）** | `top` 或 `tail`。**一个块可以同时挂两个位置**（面板上的「同时挂到另一位置」） |
| **角色（role）** | `system` / `user` / `assistant`，**块级一等字段**，不由位置推导 |
| **顺序（order）** | 数字，升序装配。**顺序即语义**：同位置内后读到的覆盖先读到的 |
| **三档读** | `config.json` 内联 `content` ＞ `overrides/<id>.md` ＞ `blocks/<id>.md` |

### 4.1 出厂态（首次安装得到什么）

插件启动时把自带的 `blocks/*.md` seed 到 `$DSH_HOME/dsh-prompt/blocks/`，按内建默认表装配：

| 块 id | 名称 | order | 默认 | 位置 | 角色 |
|---|---|---|---|---|---|
| `core-persona` | 人格 | 100 | 开 | 顶部 | system |
| `core-style` | 文风 | 200 | 开 | 顶部 | system |
| `core-contract` | 核心执行契约 | 300 | 开 | 顶部 | system |
| `core-jailbreak` | 破限 | 400 | 开 | 顶部 | system |
| `core-armor` | 破甲 | 500 | 开 | 顶部 | system |
| `core-routing` | 任务路由 | 600 | **关** | 顶部 | system |
| `core-tail` | 尾部续压 | 700 | 开 | **尾部** | user |

`core-routing` 默认关是有意的：它一块就占出厂总量的大头，日常对话用不上，是按任务临时开的东西。

**关键区别：块内容跟着插件走，"你这台机器的调参"不跟着走。** 出厂态 ≠ 你的现役状态。真正属于你的是 `config.json`（顺序/开关/位置/角色）+ `overrides/`（改过的正文），它们与插件版本解耦。

想看某台机器上"出厂态 vs 现役"差多少：

```bash
node test/fresh-state.mjs          # 对照
node test/fresh-state.mjs --fresh  # 只看出厂态
```

### 4.2 「空 override」是有效状态

override 文件**存在即生效，即使内容是空的**——含义是"我明确要这一段不发"。
要让块回到出厂正文，用面板的**「还原」**（删掉 override），而不是把正文清空。

> 这与"清空即让位"是两条路：那种实现里你永远没法把一块清空，只能关掉它。

---

## 五、功能详解

### 5.1 块引擎（只读装配）

每轮请求都会调一次，所以它是**无副作用**的：不写盘、不抛异常、读不到就当空。

- 只装配 `enabled: true` 且 `slots` 含该位置的块，按 `order` 升序，`order` 相同按 `id`
- 正文统一 `\r\n → \n` 并去掉尾部空白，块之间用空行连接
- **空块自动跳过**，不会在结果里留下空段
- 单块上限 **512 KB**（超过直接拒绝保存，不是静默截断）

### 5.2 顶部注入

```
systemPrompt.section({ name: "dsh-prompt", order: -100000, interpolate: false, text: () => 装配结果 })
```

四个设计点，都是踩过坑才这么写的：

| 点 | 为什么 |
|---|---|
| `text` 是**函数** | 每轮重新求值 → 改块立即生效，不用重启、不用重开会话 |
| 返回 `""` | `renderPrompt` 会把这个 section 过滤掉 → 这是合法的"静默关掉" |
| `interpolate: false` | 正文里的 `{{ }}` **不被 dsh 模板引擎二次解释**。写提示词时想写 `{{cwd}}` 就写，不会炸 |
| 抛异常时返回 `""` | 装配出错就把这一段降级成空，**不把注入弄塌**（fail-open） |

### 5.3 尾部注入（要一条宿主补丁）

流程：面板点「装宿主补丁」→ 改写 `dsh-agent-loop/lib/index.js` 的组装点（带 `[dsh-prompt]` 标记，改前留 `.dsh-prompt.bak`）→ **完全重启 dsh**。

| 事实 | 说明 |
|---|---|
| 每块一条消息 | 保留各自声明的 `role`，默认 `user`（"当指令"，遵从度高于 system） |
| 每轮最多几条 | `promptTailMaxMessages`，默认 **8**，超出的块按 `order` 截断 |
| 幂等 | 补丁靠 pattern 自带锚点判定，已装则不重复写入；重复执行不会叠出第二份 |
| 不碰别人 | 只在状态里**上报** `[dsh-loom]` / `[dsh-purge]` 的残留，绝不擅自删 |
| 锚点绑版本 | 声明 `dshTarget: 0.2.0-rc.2`。宿主版本不符 → 报"锚点未命中"，不会写坏文件 |

**没装补丁时**：顶部照常工作，尾部在面板里能看到装配结果和字节数，但**不会进请求**。
`tailBytes` 这个字段就是为了这面镜子存在的——块写在盘上、列在面板里、看着一切正常，实际一次都没进过对话。

### 5.4 面板

| 能力 | 操作 | 细节 |
|---|---|---|
| **拖拽排序** | 按住 ⠿ 拖到目标位置 | 松手即提交完整顺序，落点就是装配顺序（面板行序与 `order` 口径一致） |
| **单块开关** | 每行一个勾选框 | 关掉即不参与装配，**不留空段** |
| **总开关 / 位开关** | 顶部三个勾选 | 总开关、顶部注入、尾部注入可分别关 |
| **改正文** | 点块 → 编辑 → 保存 | 保存即写 override，下一轮生效 |
| **还原** | 每行「还原」 | 丢弃改动回到出厂正文（= 删 override） |
| **删除** | 每行「删除」 | 正文进 `_trash/<时间戳>/`，不销毁 |
| **新建** | 底部输入 id + 显示名 | 建到当前 tab 对应的位置 |
| **两块位** | 「同时挂到另一位置」 | 一块两挂，各自参与各位置的装配 |
| **角色** | 每行下拉框 | system=当资料 / user=当指令 / assistant=当自己说过的话 |
| **恢复出厂** | 顶部按钮 | override 与自建块全部进回收站，块表回到内建默认，正文重新 seed |
| **宿主补丁** | 顶部按钮 + 状态徽标 | 见 5.3 |

面板所有操作只动 `$DSH_HOME/dsh-prompt/`，**不碰任何宿主文件**。

### 5.5 存储与回收站

```
$DSH_HOME/dsh-prompt/
├─ config.json          ← 块表：id / name / order / enabled / role / slots / tailDepth（可选内联 content）
├─ blocks/<id>.md       ← 出厂正文（seed 来的，可被覆盖但不会被静默丢）
├─ overrides/<id>.md    ← 你改过的正文（存在即生效，含空文件）
└─ _trash/<时间戳>/     ← 被替换 / 被删 / 恢复出厂前的正文与 config
```

- `blocks/` 缺失或为空 → 启动时自动 seed 回来（`force: false`，已存在的不覆盖）
- `_trash/` 只增不减，没有任何自动清理——**写坏了永远能捞回来**

### 5.6 自动重试与续跑

`continue-retry` 管两件事，设置存在 `$DSH_HOME/dsh-prompt/continue-retry.json`：

| 键 | 默认 | 作用 |
|---|---|---|
| `autoRetry` | `true` | 请求异常（非用户中断、非永久错）时自动重试 |
| `retryMax` | `3` | 重试次数上限 |
| `autoContinue` | `false` | 输出被截断时自动补发「继续」 |
| `continueMax` | `3` | 续跑次数上限 |
| `continueText` | `"继续"` | 续跑发的那句话 |

`autoContinue` 默认关是有原因的：空闲后极短延迟内的自动续跑会和用户手动 submit 抢跑，出现"二轮立刻发"的怪现象。要开就自己改配置。

### 5.7 更新与版本

| 能力 | 说明 |
|---|---|
| 频道 | `stable`（分支 `main`）/ `beta`（分支 `beta`，远端没有该分支时自动不显示） |
| 检查更新 | 读远端 head commit + `package.json` 版本，与本地比对 |
| 钉版本 | 选某个历史版本 → 固定，不再跟最新；「更新」回到最新 |
| 切换 | 装回正式版会清掉钉选 |
| 自更新 | 直连 `codeload` 下 zip（避免 `github.com/archive` 的 302 在部分环境下失败） |

入口在**「清洗」tab 的版本区**：正式版 / 测试版两栏，每栏能「检测更新 → 更新 / 切换 / 钉选历史版本」，卸载也在这一块。
命令行侧另有 `--apply / --revert`，作用于宿主补丁层。

### 5.8 HTTP API

面板调的就是这套，你也可以直接 curl 做自动化。全部 POST 到 `/dsh-prompt/prompt`：

```bash
curl -X POST http://127.0.0.1:<port>/dsh-prompt/prompt \
  -H 'content-type: application/json' \
  -d '{"op":"status"}'
```

| op | 参数 | 作用 |
|---|---|---|
| `ping` | — | 存活探测（返回 pid） |
| `status` | — | 全量快照：插件开关、顶部正文/字节/分块、尾部消息数与字节、宿主补丁状态、块表 |
| `snapshot` | — | 只要块表 + 装配结果 |
| `setEnabled` | `enabled` / `topEnabled` / `tailEnabled` | 运行时开关（改的是活配置，立即影响注入） |
| `setContent` | `id`, `content` | 写正文（落 override） |
| `setMeta` | `id`, `patch` | 改 `enabled` / `role` / `slots` / `name` / `order` |
| `reorder` | `slot`, `ids[]` | 按给定顺序重排该位置 |
| `add` | `block` | 新建块 |
| `remove` | `id` | 删除（进回收站） |
| `revert` | `id` | 还原到出厂正文 |
| `restoreFactory` | — | 恢复出厂 |
| `seed` | `force` | 重新落盘出厂正文（`force: true` 覆盖） |
| `patchStatus` | — | 宿主补丁报告 |
| `applyPatch` | — | 施加尾部注入补丁（改宿主文件，需重启） |

常见用法——**每轮开头临时插一条指令**（不改块表，只影响这一次）：

```bash
curl -X POST http://127.0.0.1:<port>/dsh-prompt/prompt \
  -H 'content-type: application/json' \
  -d '{"op":"setContent","id":"core-tail","content":"本轮只输出最终代码，不要解释。"}'
```

### 5.9 另外两层（简述）

- **清洗 / 执行环境**：80+ 条宿主补丁（当前 82 条：沙箱、审批、工具面、身份清洗）、`dsh` shim、capability 协议（教模型主动发现 skill / MCP，不改官方注册）。改动的是**已安装的宿主文件**，`npm install` 会冲掉，需要重新施加。
- **规则设定**：把规则写到 `AGENTS.md` / `CLAUDE.md`，三档工作区策略 `fallback` / `strict` / `always`。
- **演练台**：授权范围内的事实库（SQLite，`$DSH_HOME/redteam`）+ 资产 / 技能 / 发现 / 攻击链 / 报告等子页。红线与授权流程见 `docs/drill-auth-legal.html`。

这两层不是本仓库的发明，细节看 `docs/设计文档.md`、`docs/交付单.md`。

---

## 六、使用配方

### 6.1 换人格

1. 「提示词」→ 顶部 tab → 点 `core-persona`
2. 改正文 → 保存
3. 下一轮对话直接生效（不用重启、不用新开会话）

改坏了：这一行的「还原」→ 回到出厂正文；`_trash/` 里还留着你刚才那版。

### 6.2 加一条抗截断 / 起笔锁

1. 切到**尾部** tab
2. 新建块，id 例如 `tail-lock`，显示名「起笔锁」
3. 角色选 `user`（当指令，遵从度更高）
4. 正文写你要重申的话，保存
5. 看顶部统计的「尾部 N 字」变了没有——**变了才算进装配**

如果尾部一直显示 0：宿主补丁没装，或者尾部总开关关了。

### 6.3 临时关一块（不删）

块行左边的勾选框取消即可。关掉 = 完全不参与装配，不会留下空段，也不会留下"已禁用"的痕迹。

### 6.4 同一段既当资料又当指令

角色的差别是真实的：

| 角色 | 模型怎么看 | 适合 |
|---|---|---|
| `system` | 背景设定、资料 | 世界观、人物卡、知识库 |
| `user` | 用户的要求 → 遵从度高 | 禁令、格式要求、本轮任务 |
| `assistant` | 自己说过的话 → 既是示范也是承诺 | 语气示范、已答应的输出格式 |

一个块可以通过「同时挂到另一位置」出现在顶部和尾部，但**角色是块级的、共享的**。想让"顶部当资料、尾部当指令"，就复制成两个块、给不同角色。

### 6.5 把酒馆预设搬进来

酒馆预设的核心是"很多条条目 + 各自的注入位置和深度"。映射关系：

| 酒馆 | 本插件 |
|---|---|
| 条目正文 | 一个块 |
| 条目启用 | 块开关 |
| 条目顺序 | `order`（拖拽即改） |
| 位置在 prompt 前段 | `slots: ["top"]`，`order` 给小值 |
| 位置在对话后段 / 底部槽 | `slots: ["tail"]` |
| 注入深度 `injection_depth` | **不参与排布**。`tailDepth` 字段只为兼容而保留 |

尾部块的相对先后由 `order` 决定，不按深度算。想"越靠近生成点越重要"，就把 order 加大。

### 6.6 多机同步

**代码走 git，调参走状态目录，两者分开。**

```powershell
# 代码（两边都是公开仓库）
gh repo clone woodmeone/dsh-prompt D:\dsh-prompt
git pull / git push

# 你真正调出来的那套：只搬这两个
#   ~/.dsh/dsh-prompt/config.json    ← 顺序 / 开关 / 位置 / 角色
#   ~/.dsh/dsh-prompt/overrides/     ← 改过的正文
```

别只搬 `blocks/`——那里面是出厂正文。三档读是 `内联 > overrides > blocks`，你的东西住在后两档中的 `overrides`。

新机器上**宿主补丁要重新点一次**（它改的是那台机器上的宿主文件，不会从仓库继承），而且改完必须**完全退出 dsh 再启动**：补丁改的是磁盘上的 `.js`，正在跑的进程加载的还是启动时那一份。

### 6.7 只保留一块或几块

关掉总开关（面板顶部第一个勾选）→ 全部不注入，块表原样保留。
只留顶部：关掉「尾部注入」。只留尾部：关掉「顶部注入」。

---

## 七、配置

### 7.1 块表字段（`config.json`）

| 字段 | 说明 |
|---|---|
| `id` | 唯一键。字母数字或 `_` 开头，允许 `.` `-`，最长 64；**不许** Windows 保留名（`CON`/`NUL`/`COM1`…）和尾随点 |
| `name` | 显示名（最长 64 字） |
| `order` | 装配次序，`order` 相同按 `id` |
| `enabled` | 开关 |
| `role` | `system` / `user` / `assistant`，默认 `system` |
| `slots` | 数组，可同时含 `top` 和 `tail`；**空数组按 `["top"]` 处理**（避免建了块却永不生效） |
| `tailDepth` | 兼容字段，不参与排布 |
| `content` | 可选内联正文，优先级最高 |

### 7.2 插件配置（`cordis.patch.yml`）

```yaml
- id: dsh-prompt
  config:
    enabled: true                 # 总闸（含执行环境补丁层）
    promptBlocksEnabled: true     # 顶部注入（块引擎）
    promptTailEnabled: true       # 尾部注入
    promptTailMaxMessages: 8      # 尾部每轮最多几条
    autoRetry: true               # 请求异常自动重试
    retryMax: 3
    autoContinue: false           # 截断后自动续跑
    continueMax: 3
    continueText: "继续"
    capabilityProtocol: true      # 教模型主动发现 skill / MCP
    verbose: false                # 内部日志
```

> 上面是日常会动的键。其余是执行环境与老路径的内部开关——`autoApplyOnStart`、`autoUpdateOnStart`、`autoRevertOnMissing`、`injectOnce`、`stripMnemon`、`postPrompt`、`postPromptOrder`、`hooksDenyBypass`——默认值见 `lib/index.js` 顶部的配置表，一般不用碰。

> 运行时开关（面板上的勾选）改的是活配置，**不写回这个 yml**；重启后以 yml 为准。

---

## 八、排错

| 现象 | 多半是 | 怎么办 |
|---|---|---|
| 改了正文，对话没变化 | 块被关了 / 位置不对 / 空 override | 看行首勾选、看它在哪个 tab、看「顶部/尾部 N 字」有没有变 |
| 尾部块永远不进请求 | 宿主补丁没装 / 没重启 / 尾部总开关关 | 面板徽标是否「已装」；`dsh` 要**完全退出**再启动 |
| 「装宿主补丁」报锚点未命中 | 宿主版本 ≠ `dshTarget` | 报出版本号，按该版本真实字节重新对锚点，不会写坏文件 |
| 新建块报 id 非法 | 用了 `:`、空格、中文开头，或撞了 Windows 保留名 | 换 `[A-Za-z0-9_][A-Za-z0-9_.-]*` |
| 保存报过大 | 单块超 512 KB | 拆成两块，或把它降级成尾部重申 |
| 清空正文后仍生效 | 清空 = 写了一版空 override ≠ 关闭 | 要"不发"就关掉块；要"回出厂"就点「还原」 |
| 更新后宿主补丁失效 | `npm install` 冲掉了宿主文件改动 | 重新 `--apply` / 面板点「装宿主补丁」，再重启 |
| 顶部出现两段相似内容 | dsh-purge 与本插件都注册了 system section | 两者可以并存；只想留一套就关掉其一（见第九节） |

---

## 九、与 dsh-purge 的关系

两个插件都注册 `systemPrompt.section`，都在 `order: -100000` 放主段。**两个段并列，各自生效，不会互相覆盖。**

| 你想怎样 | 怎么做 |
|---|---|
| 两个都用（purge 管执行环境，本插件管提示词） | 什么都不用改 |
| 只用本插件管提示词 | 在 purge 的配置里关掉它的提示词层（注意 purge 的 `enabled` 是总闸，一关整层执行环境补丁一起没） |
| 只留 purge | 本插件 `enabled: false` |

**本插件不擅自改 purge 的任何文件**，连它留下的 `[dsh-purge]` 补丁标记都只在状态里上报。

---

## 十、命令行、自测、开发

### 10.1 命令行

```bash
dsh-prompt --status      # 宿主定位、补丁清单、shim、备份状态
dsh-prompt --apply       # 施加全部清洗（提示词 + 代码 + shim）
dsh-prompt --revert      # 回滚
dsh-prompt --uninstall   # 卸载（已应用则先回滚）
dsh-prompt --edit        # 编辑 prompt-inject.md（老路径，块引擎关掉时才用）
```

### 10.2 自测

```bash
npm test                          # 全套
node test/blocks.test.mjs         # 块引擎 + CRUD        —— 57 项
node test/inject.test.mjs         # 注入链路            —— 30 项
node test/e2e-shadow.mjs          # 端到端影子宿主       —— 12 项
node test/patch-anchor.test.mjs   # 宿主锚点（幂等 + 语法，需要真宿主）
```

全部使用隔离的临时 `$DSH_HOME`，**不碰真实 `~/.dsh`**。

涉及真宿主的测试不再写死路径，统一走 `test/host-locate.mjs`，优先级：

1. `DSH_PROMPT_AI_BASE` 环境变量（CI / 多机器的确定性入口）
2. PATH 上 `dsh` 启动器反推 —— **这就是"正在跑的那份"**
3. `core.findAiBase()`
4. npm / npx 缓存 `_npx/*`，按修改时间新→旧

每条候选都要实证（目录下真有 `dsh-agent-loop/lib/index.js`）才算数；一个都找不到时**明示跳过**，不假装通过。

```powershell
$env:DSH_PROMPT_AI_BASE = "C:\path\to\node_modules\@deepseek-ai"
node test/patch-anchor.test.mjs
```

### 10.3 目录

```
dsh-prompt/
├─ lib/
│  ├─ prompt-blocks.js   块引擎（只读装配：三档读、seed、装配）
│  ├─ prompt-edit.js     写入侧（CRUD、重排、还原、回收站、恢复出厂）
│  ├─ prompt-inject.js   注入（顶部 section、尾部请求期消息）
│  ├─ prompt-patches.js  宿主补丁（组装点改写）
│  ├─ prompt-panel.client.js  面板 UI
│  ├─ identity.js        身份清洗 / capability 协议 / 段名
│  ├─ update.js          更新频道、钉版本、zip 覆盖安装
│  └─ …                  执行环境层（core / rules / net-scope / redteam …）
├─ blocks/               出厂块正文（7 块）
├─ presets/              演练台 agent preset 声明
├─ skills/               演练台技能库
├─ test/                 自测（含 fresh-state 出厂态对照）
└─ client.js             Web 面板 bundle
```

---

## 十一、设计约束（改代码前必读）

1. **宿主补丁标记用 `[dsh-prompt]`**，与 `[dsh-purge]` / `[dsh-loom]` 可分辨
2. **尾部必须走 `buildRequest` 组装点**，不许走 `agent/pre-step` 返回 messages
3. **空 override 是有效状态**，不许"清空即回落默认"
4. **块 id 按 Windows 文件名约束**（保留名、尾随点、非法字符一律拒绝）
5. **装配侧无副作用**：不写盘、不抛；出错降级成空段
6. **失败一律 fail-open**：钩子缺失 / 抛异常都让请求按原样发出
7. **不碰别人的补丁**：检测到别人的标记只在状态里上报
8. **写入侧全部包 guard**，不裸抛

---

## 十二、许可

MIT。

执行环境层派生自 [dsh-purge](https://github.com/YuJunZhiXue/dsh-purge)，提示词装配层（块引擎、双位置注入、面板、三档读、回收站）为本项目新增。
