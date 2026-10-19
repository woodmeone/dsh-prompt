# dsh-prompt

> **DeepSeek Harness 提示词管理插件** —— 顶部 + 尾部双位置注入，块级拖拽排序、开关、增删改查。
>
> 一句话：**把你的破限提示词 / 预设 / 角色卡内容拆成块，按 U 型注意力的两个峰摆好，随时拧。**

---

## 一、它解决什么问题

LLM 的注意力是 **U 型**：开头和**紧邻生成点之前**最高，中间塌。所以提示词只有两个位置值得放：

| 位置 | 放什么 | 机制 |
|---|---|---|
| **顶部** | 人格、知识、大段契约 | `systemPrompt.section`（拼进那条 system 消息） |
| **尾部** | 本轮重申、抗截断、起笔锁 | 追加到**本轮请求**的 messages 末尾 |

本插件把提示词拆成**块**，每个块可以同时挂两个位置、单独开关、拖拽排序、随时改正文。

---

## 二、为什么尾部注入这样做

### 2.1 社区实测的分层

- 真实酒馆预设里，两个**底部槽都是 `user`** 身份（60 槽 = 58 system / 2 user / 0 assistant）
- 「规则去尾部，知识去前部」
- 抗截断是第六类破限机制：**愿意写但写一半停，效果等同拒绝**

### 2.2 关键：尾部**不能**走 `agent/pre-step`

宿主 `dsh-agent-loop` 会把 pre-step 返回的 messages **逐条落进持久日志**：

```js
// live 宿主 lib/index.js:1077
if (firstAttempt) for (const message of decision.messages)
  this.session.append("user/message", message, { surfaceOp: "append" });
```

而每轮请求的边界消息来自**持久日志的投影**：

```js
// live 宿主 lib/index.js:1278
const boundaryMessages = session.deriveMessages();
```

所以「pre-step 注入尾部」= **每轮往历史里追加一份** → 20 轮就是 20 份同样的续压块 → 上下文膨胀 + 同段重复 + 注意力稀释。

**这正是 dsh-loom 效果差的技术根因。**

### 2.3 本插件的做法：请求期追加

在 `buildRequest` 的**唯一组装点**上追加：

```js
// 补丁后（lib/prompt-patches.js）
let boundaryMessages = session.deriveMessages();
// [dsh-prompt] append tail blocks to this turn's request
{
  const __dshPromptTailFn = globalThis.__dshPromptTail;
  if (typeof __dshPromptTailFn === "function") {
    try {
      const __dshPromptExtra = __dshPromptTailFn();
      if (Array.isArray(__dshPromptExtra) && __dshPromptExtra.length > 0) {
        boundaryMessages = Object.freeze([...boundaryMessages, ...__dshPromptExtra]);
      }
    } catch { }
  }
}
```

三个收益：

| 收益 | 说明 |
|---|---|
| **不累积** | session log 干净，历史里永远只有一条尾部 |
| **不受角色校验约束** | `user/message message must have role "user"` 只在**落盘/加载边界**检查；请求期数组不落盘，所以 `assistant` 也可用 |
| **离生成点最近** | 消息数组末尾 = U 型第二峰 |

---

## 三、安装

### 3.1 依赖

```bash
# 需要 dsh ≥ 0.2.0-rc.2（本插件按该版本的宿主文本对齐锚点）
dsh --version
```

### 3.2 安装插件

```bash
# 在工作目录下
dsh plugin install <path-to-dsh-prompt>
# 或在 profiles/web/package.json 的 dsh.profile.bundles 里加上 dsh-prompt
```

### 3.3 新机器首次安装后默认得到什么

**先回答一个容易误判的问题：插件的块内容跟着插件走，但「你这台机器的调参」不跟着走。**

首次安装时，插件会把自带的 `blocks/*.md` seed 到 `$DSH_HOME/dsh-prompt/blocks/`，
并按内建默认表装配。得到的是**出厂态**：

| 块 | order | 默认开关 | 位置 | 正文 |
|---|---|---|---|---|
| core-persona 人格 | 100 | 开 | 顶部 | 1,727 字 |
| core-style 文风 | 200 | 开 | 顶部 | 675 字 |
| core-contract 核心执行契约 | 300 | 开 | 顶部 | 916 字 |
| core-jailbreak 破限 | 400 | 开 | 顶部 | 3,691 字 |
| core-armor 破甲 | 500 | 开 | 顶部 | 1,143 字 |
| **core-routing 任务路由** | 600 | **关** | 顶部 | 14,508 字 |
| core-tail 尾部续压 | 700 | 开 | **尾部** | 324 字 |

装配结果：**顶部 8,155 字 / 5 块，尾部 323 字 / 1 块**。

默认关掉 `core-routing` 是有意的：它一块占总量约 71%，日常对话用不上。

**所以「装上就有我现在这些提示词」——不是。** 出厂态**不含**下面这些属于
单机状态的东西，因为它们存在 `$DSH_HOME/dsh-prompt/`，不在插件包里：

| 你现在的状态 | 出厂态 |
|---|---|
| 顶部 22,667 字 / 6 块 | 顶部 8,155 字 / 5 块 |
| `core-routing` **开着** | 默认关 |
| 顺序：contract → persona → jailbreak → armor → style → routing | persona → style → contract → jailbreak → armor → routing |
| 有自建块 `1213`（关着） | 没有 |
| `core-contract` 用覆盖版（919 字） | 出厂版（916 字） |
| `core-tail` 用覆盖版（334 字） | 出厂版（324 字） |

想看任意一台机器上的实际差异：

```bash
node test/fresh-state.mjs          # 出厂态 vs 本机现役
node test/fresh-state.mjs --fresh  # 只看出厂态
```

### 3.4 施加尾部注入补丁

尾部注入需要**一条宿主补丁**（改 `dsh-agent-loop/lib/index.js` 的组装点）。
在插件的「提示词」面板里点一次即可，或直接调 API：

```bash
curl -X POST http://127.0.0.1:<port>/dsh-prompt/prompt \
  -H 'content-type: application/json' \
  -d '{"op":"status"}'      # 看 host.has_ours
```

**不施加补丁时**：顶部注入照常工作，尾部在面板里能看到装配结果但不进请求。
面板顶部会显示「宿主补丁 已装 / 未装」。

### 3.5 多机同步 / 第二台机器

本仓库是**私有**的，用途是个人多机同步，不是对外分发。

**第一步：拉代码**

```powershell
# 私有仓库，先登录
gh auth login
gh repo clone woodmeone/dsh-prompt D:\dsh-prompt
```

**第二步：装进 profile**

```powershell
dsh plugin --profile web add file:D:\dsh-prompt
```

**第三步：在那台机器上逐项启用**（宿主补丁**不会**从仓库继承）

```
1. 完全退出 dsh，重启
2. dock →「提示词」tab → 点「装宿主补丁」
3. 「清洗」页 → 点「应用」
4. 再完全退出 dsh 并重启一次
5. 新开一轮对话
```

第 4 步的重启不能省：宿主补丁改的是磁盘上的 `.js`，而正在跑的进程
加载的还是启动时那一份。

**两处必读注意**

| 注意 | 说明 |
|---|---|
| **宿主补丁逐机独立** | 它改的是**那台机器**上的 `dsh-agent-loop/lib/index.js`。新机器必须自己点一次 |
| **锚点绑宿主版本** | 插件声明 `dshTarget: 0.2.0-rc.2`。宿主版本不同 → 点「装宿主补丁」会报「锚点未命中（宿主版本可能不同）」。此时把版本号报出来，按新版本真实字节重新对锚点 |

**如果想让第二台机器也拥有「你现在这套调参」**（不是出厂态），
把状态目录整份搬过去 —— 它是纯数据，与插件版本解耦：

```powershell
# 在旧机器上取
#   C:\Users\WoodMe\.dsh\dsh-prompt\config.json    ← 顺序 / 开关 / 位置 / 角色
#   C:\Users\WoodMe\.dsh\dsh-prompt\overrides\     ← 你改过的正文
# 覆盖到新机器同名路径，然后重启 dsh（或面板点「刷新」）
```

> 别只搬 `blocks/`：那里面是出厂正文。真正属于你的是 `config.json` + `overrides/`。
> 三档读优先级 `内联 > overrides/ > blocks/`，见第六节。

**日常同步**就是普通 git：

```powershell
git add -A ; git commit -m "..." ; git push
# 另一台
git pull
```

### 3.6 ⚠ 与 dsh-purge 的关系

两个插件都注册 `systemPrompt.section`，**都会往 -100000 放主段**。

| 你想怎样 | 怎么做 |
|---|---|
| 两个都用（purge 执行环境 + prompt 提示词管理） | **不用改**。两个段并列，各自生效 |
| 只用 dsh-prompt 管提示词 | 在 purge 的配置里关掉它的提示词层（注意 purge 的 `enabled` 是总闸，关掉 46 个补丁一起没） |
| 只留 purge | 在 dsh-prompt 的配置里 `enabled: false` |

**本插件不擅自改 purge 的任何文件。**

---

## 四、配置

`cordis.patch.yml`：

```yaml
- id: dsh-prompt
  config:
    enabled: true              # 总开关
    topEnabled: true           # 顶部注入
    tailEnabled: true          # 尾部注入
    tailMaxMessages: 8         # 尾部每轮最多拼几条
    verbose: false             # 内部日志
```

---

## 五、面板

挂在与 dsh-purge 相同的位置（右下角浮动 dock），作为第三个 tab「提示词」。

| 能力 | 操作 |
|---|---|
| **拖拽排序** | 按住 ⠿ 拖到目标位置，松手即提交完整顺序 |
| **开关** | 每块一个勾选框，关掉即不参与装配（**不残留**） |
| **增删改查** | 新建 / 删除 / 编辑正文 / 撤销改动 / 恢复出厂 |
| **双位置** | 顶部 / 尾部两个 tab，同一张块表按 `slots` 过滤 |
| **一块两挂** | 「同时挂到另一位置」按钮 |
| **角色** | 每块可选 system / user / assistant |

面板调 `/dsh-prompt/prompt`，全部 op 只动 `$DSH_HOME/dsh-prompt/`。

---

## 六、存储

```
$DSH_HOME/dsh-prompt/
├─ config.json          ← 块表：id / name / order / enabled / role / slots
├─ blocks/<id>.md       ← 出厂正文
├─ overrides/<id>.md    ← 你的改动（三档读：内联 > override > blocks）
└─ _trash/<时间戳>/    ← 被替换 / 被删的内容，不销毁
```

**三档读优先级**：`config.json` 里的内联 `content` > `overrides/<id>.md` > `blocks/<id>.md`。

**空 override 的语义**：override 文件存在就以上它为准，**即使内容为空**
（= 你明确要这段不发）。要让块回出厂，用「还原」按钮删掉 override。

> 这与 dsh-purge 的「清空即让位」是两条路。purge 里清空文件会被兜底覆盖回去；
> 本插件的空 override 是**有效状态**。

---

## 七、块字段

| 字段 | 说明 |
|---|---|
| `id` | 唯一键，`[A-Za-z0-9_]` 开头，允许 `._:-` |
| `name` | 显示名 |
| `order` | 装配次序（**顺序即语义**，后读到的覆盖先读到的） |
| `enabled` | 开关 |
| `role` | `system` / `user` / `assistant`（**块级一等字段**，不由位置推导） |
| `slots` | 数组，可同时含 `top` 和 `tail` |
| `tailDepth` | 只为兼容酒馆预设的 `injection_depth` 而存在，**不参与排布** |

---

## 八、自测

```bash
npm test
# 或分开跑
node test/blocks.test.mjs        # 块引擎 + CRUD —— 57 项
node test/inject.test.mjs        # 注入链路 —— 30 项
node test/patch-anchor.test.mjs  # 宿主锚点（幂等 + 语法）—— 14 项
node test/e2e-shadow.mjs         # 端到端影子宿主 —— 12 项
```

全部用隔离的临时 `$DSH_HOME`，**不碰真实 ~/.dsh**。

### 宿主定位（跨机器）

涉及真宿主的测试（`patch-anchor` / `e2e-shadow` / `adversarial` / `apply-real` /
`regression-real`）不再写死路径，统一走 `test/host-locate.mjs`。优先级：

1. `DSH_PROMPT_AI_BASE` 环境变量 —— 显式指定，CI 与多机器的确定性入口
2. PATH 上的 `dsh` 启动器反推 —— **这就是「正在跑的那份」**
3. `core.findAiBase()`
4. npm / npx 缓存 `_npx/*`，按修改时间新→旧

> 为什么第 2 条排在 `findAiBase()` 前面：实测宿主进程**外**跑
> `core.findAiBase()` 会解析到另一份旧安装（未打补丁），与 PATH 上
> `dsh` 实际加载的那份不是一处。测试必须打正在跑的那份，否则
> 锚点断言对不上，人会误以为是补丁坏了。

每条候选都要**实证**（目录下真有 `dsh-agent-loop/lib/index.js`）才算数。
一个都找不到时，测试打印「跳过」并正常退出 —— 是明示跳过，不是假装通过。

多机器 / 多份安装时用环境变量钉死：

```powershell
$env:DSH_PROMPT_AI_BASE = "C:\path\to\node_modules\@deepseek-ai"
node test/patch-anchor.test.mjs
```

---

## 九、设计约束（写代码前必读）

1. **宿主补丁标记用 `[dsh-prompt]`**，与 `[dsh-purge]` / `[dsh-loom]` 可分辨
2. **尾部必须走 `buildRequest` 组装点**，不许走 `agent/pre-step` 返回 messages
3. **锚点按 live 宿主真实字节写**（`@deepseek-ai/dsh@0.2.0-rc.2`，含 tab 缩进）
4. **空文本 section 会被 `renderPrompt` 过滤** → `text: () => ""` 是合法的「静默关掉」
5. **失败一律 fail-open**：钩子缺失 / 抛异常都让请求按原样发出
6. **不碰别人的补丁**：检测到 `[dsh-loom]` / `[dsh-purge]` 只在状态里上报，不擅自删
7. 不建 git commit / push

---

## 十、许可

MIT。基于 [dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) 的执行环境层派生，
提示词装配层为本项目新增。
