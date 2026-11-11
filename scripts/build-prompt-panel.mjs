/**
 * 把 lib/prompt-panel.client.js 注入 client.js 的 loader 工厂体内。
 *
 * 嵌入位置：drill fragment 之前（那里是工厂体内、组件声明区）。
 * 内容用标记包裹，便于重复运行（幂等）。
 *
 * node scripts/build-prompt-panel.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, "lib", "prompt-panel.client.js");
const clientPath = path.join(root, "client.js");

const BEGIN = "/* __DSH_PROMPT_PANEL_BEGIN__ */";
const END = "/* __DSH_PROMPT_PANEL_END__ */";

let panel = fs.readFileSync(src, "utf8").replace(/\r\n/g, "\n");
let client = fs.readFileSync(clientPath, "utf8").replace(/\r\n/g, "\n");

// 幂等：已有就替换掉旧块
//
// ⚠ 边界必须精确，否则每次重跑都会往 client.js 里堆空行。
//   旧写法只切到 END 标记末尾，而 fragment 自己在 END 之后带了一个空行，
//   于是每跑一次就多留一个空行 —— 实测连跑三次多出 6 行，永远收敛不了，
//   而且这些空行会混进业务 diff，让人看不出到底改了什么。
//
//   现在：删除时精确切到 END 结尾，并吃掉 fragment 自己引入的那**一个**换行；
//   其它空行一律不动（那是原作者写的排版）。
const bAt = client.indexOf(BEGIN);
const eAt = client.indexOf(END);
if (bAt >= 0 && eAt > bAt) {
  let tail = eAt + END.length;
  if (client[tail] === "\n") tail += 1;
  client = client.slice(0, bAt) + client.slice(tail);
}

// 找插入点：drill fragment 的开标记之前
const anchor = client.indexOf("/* __DSH_PROMPT_DRILL_BEGIN__ */");
if (anchor < 0) throw new Error("找不到 drill fragment 标记；先跑 patch-client-dock.mjs");

const indent = "\t\t";
const body = panel
  .split("\n")
  .map((l) => (l.length ? indent + l : l))
  .join("\n");

// fragment 自己只到 END 为止，后面**只带一个**换行（收尾 END 那一行）。
// 分隔空行由 client.js 的原有排版提供，不由 fragment 制造 ——
// 否则每跑一次就多一个空行，永远收敛不了。
const fragment = `${BEGIN}
		// 「提示词」面板（源码在 lib/prompt-panel.client.js）
${body}
${END}
`;

client = client.slice(0, anchor) + fragment + client.slice(anchor);
fs.writeFileSync(clientPath, client, "utf8");

const bytes = Buffer.byteLength(fragment);
console.log(`注入面板片段 ${bytes} 字节 → client.js（总 ${Buffer.byteLength(client)} 字节）`);
