# 0002 configSource 拆出 corrupt 值

## 背景

`config.json` 存在但读不懂时，旧实现走 `readJson` 的 `catch { return null }`，
`null` 就回落到内建默认表。于是"文件不存在"（全新安装，正常）和
"文件在但读不懂"（数据事故）走同一条路，可观测结果都是 `configSource: "builtin"`。

实测后果：用户自建两个块 → 把 `config.json` 写坏 → `describe` 从 9 块变 7 块。
用户那两个块在界面上人间蒸发。文件其实还在盘上（`blocks/mine1.md` 完好），
但面板照常渲染出厂态、不报错、不提示。没有任何信号告诉任何人出事了。

这是"静默失真"里最严重的一类：**守住了"不抛"这条纪律，却也没告诉任何人出了问题。**

## 决策与取舍

**选定：把 `configSource` 的值域从 `builtin` 拆出 `corrupt`，并附 `configError` 说明原因。**

放弃的方案：

1. **直接抛异常**
   放弃原因：违反装配侧的铁纪律 —— 装配每轮都被调用，抛异常会把整个
   systemPrompt 组装弄塌，等于人格/破限/契约一起消失。这正是 dsh-loom 的失败方式。
2. **保持 `builtin`，只在日志里 warn**
   放弃原因：日志用户看不到。面板是唯一会被看见的地方，信号必须到那里。
3. **加一个独立布尔 `configCorrupt: true`，`configSource` 不动**
   放弃原因：两个字段表达同一件事，迟早不一致。值域里多一个值更内聚 ——
   "来源是什么"本来就有四种答案，`corrupt` 是其中之一。

关键取舍：**降级行为完全不变，只把"降级发生了"这件事暴露出来。**
仍然回落出厂表、仍然不抛、仍然 fail-open。变的只是可观测性。

## 后果

- `configSource` 值域：`config` / `builtin` / `corrupt` / `none`。
- **这是一处有意的破坏性变更**：任何断言 `configSource === "builtin"` 的代码，
  在 config 损坏时都会失效。`blocks.test.mjs` 里那条旧断言正是这个 bug 的守护者，
  已同步改为断言 `corrupt`。
- `ENOENT` 被明确排除在 `corrupt` 之外 —— 全新安装不该看到红字。
  同理"数据目录被整体删除"仍是 `builtin`。
- 面板会显示「块表读取失败，当前显示的是出厂默认 —— 你自建的块可能没有加载」，
  并带文件路径与原因。
