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
// ⚠ 这里必须把旧块**连同尾部空行一起**吃掉。
//   旧实现只切到 END 标记末尾，而 fragment 自己在 END 之后带了一个空行，
//   于是每跑一次就多留一个空行 —— 连跑三次 client.js 就多出 6 个空行，
//   每次重新注入都在污染 diff，且永远收敛不了。
//   切完再反向吃掉残留空行，让「跑 N 次」的结果与「跑 1 次」逐字节相同。
const bAtMark = client.indexOf(BEGIN);
const eAt = client.indexOf(END);
if (bAtMark >= 0 && eAt > bAtMark) {
  let tail = eAt + END.length;
  // 吃掉紧随其后的换行（fragment 自带的那个空行）
  while (client[tail] === "\n") tail += 1;
  client = client.slice(0, bAtMark) + client.slice(tail);
  // 再吃掉 BEGIN 之前因上次插入而残留的空行，避免每次插入都往上堆
  let bAt = bAtMark;
  while (bAt > 1 && client[bAt - 1] === "\n" && client[bAt - 2] === "\n") {
    client = client.slice(0, bAt - 1) + client.slice(bAt);
    bAt -= 1;
  }
}

// 找插入点：drill fragment 的开标记之前
const anchor = client.indexOf("/* __DSH_PROMPT_DRILL_BEGIN__ */");
if (anchor < 0) throw new Error("找不到 drill fragment 标记；先跑 patch-client-dock.mjs");

const indent = "\t\t";
const body = panel
  .split("\n")
  .map((l) => (l.length ? indent + l : l))
  .join("\n");

const fragment = `${BEGIN}
		// 「提示词」面板（源码在 lib/prompt-panel.client.js）
${body}
${END}

`;

client = client.slice(0, anchor) + fragment + client.slice(anchor);
fs.writeFileSync(clientPath, client, "utf8");

const bytes = Buffer.byteLength(fragment);
console.log(`注入面板片段 ${bytes} 字节 → client.js（总 ${Buffer.byteLength(client)} 字节）`);
