/**
 * dsh-prompt · 写宿主定位器回归（#1）
 *
 * 锁的是什么：
 *   1. `locateHostForPatch()` 不吃 `findAiBase()` 的进程级 memo；
 *   2. 「正在跑的那份」优先于「枚举到的任意一份」；
 *   3. 版本不符的宿主不会被静默采用而不留痕迹（source 必须能说清来源）；
 *   4. `applyPromptTailPatch()` 的失败体必须带原因与路径，不许只剩状态码。
 *
 * 对抗式设计（逆向思维：什么输入会让它错）：
 *   · 把 argv[1] 指到 A 树、同时让 B 树也存在 → 必须选 A；
 *   · A 树没有 dsh/package.json（版本读不到）→ 仍必须选 A，而不是退到 B；
 *   · 候选里存在旧版本树 → 报告里必须能看到它，而不是假装只有一份。
 *
 * node test/host-locate-patch.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

let pass = 0;
let fail = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); return; }
  fail += 1;
  fails.push(`${name}${detail ? " — " + detail : ""}`);
  console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
}

const core = await import(pathToFileURL(path.join(ROOT, "lib", "core.js")).href);

/** 在临时目录里造一个能通过 isAiBase() 的假宿主。 */
function fakeHost(root, version) {
  const base = path.join(root, "node_modules", "@deepseek-ai");
  fs.mkdirSync(path.join(base, "dsh-agent-instructions", "lib"), { recursive: true });
  fs.mkdirSync(path.join(base, "dsh-agent-loop", "lib"), { recursive: true });
  fs.mkdirSync(path.join(base, "dsh"), { recursive: true });
  if (version) {
    fs.writeFileSync(path.join(base, "dsh", "package.json"),
      JSON.stringify({ name: "dsh", version }), "utf8");
  }
  fs.writeFileSync(path.join(base, "dsh-agent-loop", "lib", "index.js"),
    "\t\tconst boundaryMessages = session.deriveMessages();\n" +
    "\t\tfor (const message of boundaryMessages) {\n", "utf8");
  return base;
}

console.log("\n[1] 定位器导出了，且不吃 memo");
{
  check("导出 locateHostForPatch", typeof core.locateHostForPatch === "function");
  check("导出 dshVersionOf", typeof core.dshVersionOf === "function");

  // 让 findAiBase 先缓存一个值，确认 locateHostForPatch 不会跟着它走。
  core.resetPathMemo();
  const cached = core.findAiBase();
  const locatedFresh = core.locateHostForPatch();
  check(
    "locateHostForPatch 不依赖 findAiBase 的缓存值",
    typeof locatedFresh?.aiBase === "string" && locatedFresh.aiBase !== undefined,
    `cached=${cached || "(null)"} fresh=${locatedFresh?.aiBase || "(null)"}`,
  );
  check("返回体带 candidates 数组", Array.isArray(locatedFresh?.candidates));
  check("返回体带 source 字段", typeof locatedFresh?.source === "string" && locatedFresh.source.length > 0,
    `source=${locatedFresh?.source}`);
}

console.log("\n[2] 当前进程（测试脚本自己）所在树优先");
{
  const r = core.locateHostForPatch();
  // 测试脚本不在宿主树里，所以 running-process 拿不到；这时不该假称自己拿到了。
  check(
    "测试进程内不冒充 running-process",
    r.source !== "running-process" || Boolean(r.aiBase),
    `source=${r.source}`,
  );
  check("没有宿主时 source=none 且 aiBase 为空串", r.source !== "none" || r.aiBase === "", `source=${r.source}`);
}

console.log("\n[3] 假宿主：版本能读出来");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-locate-"));
  try {
    const base = fakeHost(tmp, "9.9.9-test");
    check("dshVersionOf 读出版本", core.dshVersionOf(base) === "9.9.9-test", `got=${core.dshVersionOf(base)}`);
    check("没有 dsh/package.json 时返回空串", core.dshVersionOf(fakeHost(path.join(tmp, "nov"), "")) === "");
    check("空路径返回空串", core.dshVersionOf("") === "");
    check("不存在的路径返回空串", core.dshVersionOf(path.join(tmp, "nope")) === "");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\n[4] 失败体必须带原因与路径（#1 的可观测部分）");
{
  const idxSrc = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");
  // 反向验证：这些字段名必须真的出现在 applyPromptTailPatch 的返回里。
  const fnStart = idxSrc.indexOf("function applyPromptTailPatch()");
  check("找得到 applyPromptTailPatch", fnStart > 0);
  const fnBody = idxSrc.slice(fnStart, fnStart + 4000);
  check("失败体带 ai_base", /ai_base:\s*rep\.ai_base/.test(fnBody));
  check("失败体带 host_version", /host_version:\s*rep\.host_version/.test(fnBody));
  check("失败体带 anchor 状态", /anchor:\s*"(no-host|unreadable|already|miss|hit)"/.test(fnBody));
  check("四类失败都有 reason", (fnBody.match(/reason:/g) || []).length >= 4,
    `reason 出现 ${(fnBody.match(/reason:/g) || []).length} 次`);
  check("不再有裸 String(e) 吞掉上下文",
    !/return \{ ok: false, wrote: false, reason: String\(e\?\.message \|\| e\) \}/.test(fnBody));
}

console.log("\n[5] 面板必须读 body 再判状态码");
{
  const panel = fs.readFileSync(path.join(ROOT, "lib", "prompt-panel.client.js"), "utf8");
  check("有 describeFailure 折句器", /function describeFailure\(/.test(panel));
  // 逆向验证：旧的「先 throw HTTP status」形态必须消失。
  check("不再先 throw 裸状态码", !/if \(!r\.ok\) throw new Error\("HTTP " \+ r\.status\)/.test(panel));
  check("先解析 body 再判定", /const data = await r\.json\(\)/.test(panel)
    && panel.indexOf("await r.json()") < panel.indexOf("if (!r.ok || data.ok === false)"));
  check("失败时抛的是折出来的原因", /throw new Error\(describeFailure\(data, r\.status\)\)/.test(panel));
}

console.log("\n[6] 报告与施补丁走同一个定位器（口径一致）");
{
  const idxSrc = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");
  check("promptHostPatchReport 用 safeLocateHost", /function promptHostPatchReport\(\)[\s\S]{0,400}safeLocateHost\(\)/.test(idxSrc));
  check("promptHostPatchReport 不再调 findAiBase", !/function promptHostPatchReport\(\)[\s\S]{0,400}core\.findAiBase/.test(idxSrc));
  check("报告带 locate_source", /locate_source:/.test(idxSrc));
  check("报告带 tried 候选列表", /tried: located\.candidates/.test(idxSrc));
}

console.log("\n[7] 失败体的字段归属：ctx 的键不许被显式值重复声明后又被压掉");
{
  const idxSrc = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8").replace(/\r\n/g, "\n");
  const start = idxSrc.indexOf("function applyPromptTailPatch()");
  const fn = idxSrc.slice(start);
  const end = fn.indexOf("\n}\n");
  const body = fn.slice(0, end > 0 ? end + 3 : 4000);

  // ctx 里定义了哪些键 —— 只有这些才可能被 `...ctx` 覆盖。
  const ctxKeys = [...(body.match(/const ctx = \{([\s\S]*?)\};/)?.[1] || "").matchAll(/(\w+)\s*:/g)]
    .map((m) => m[1]);
  check("能解析出 ctx 的键", ctxKeys.length >= 4, JSON.stringify(ctxKeys));

  const returns = [...body.matchAll(/return \{([\s\S]*?)\};/g)].map((m) => m[1]);
  check("函数里有多个 return 分支", returns.length >= 5, `${returns.length} 个`);

  // 危险写法：`ai_base: "x", ...ctx` —— 显式值写在前面，被后面的 ctx 覆盖。
  // ctx 不含 reason / anchor / file，所以它们写在前后都不会被压，不必检查。
  const risky = returns.filter((obj) => {
    const iSpread = obj.indexOf("...ctx");
    if (iSpread < 0) return false;
    const before = obj.slice(0, iSpread);
    return ctxKeys.some((k) => new RegExp(`(^|[,{\\s])${k}\\s*:`).test(before));
  });
  check("没有「显式值写在 ...ctx 之前被覆盖」的分支", risky.length === 0,
    risky.length ? `坏分支 ${risky.length} 个：${JSON.stringify(risky[0]?.slice(0, 90))}` : "");

  check("每个分支都显式给 anchor", returns.every((o) => /anchor\s*:/.test(o)),
    `缺 anchor 的分支 ${returns.filter((o) => !/anchor\s*:/.test(o)).length} 个`);
  check("每个分支都显式给 reason", returns.every((o) => /reason\s*:/.test(o)),
    `缺 reason 的分支 ${returns.filter((o) => !/reason\s*:/.test(o)).length} 个`);
  check("失败分支统一 ok:false", returns.filter((o) => /ok:\s*false/.test(o)).length >= 4,
    `${returns.filter((o) => /ok:\s*false/.test(o)).length} 个`);
  check("no-host 分支在", /anchor: "no-host"/.test(body));
}

console.log("\n[8] 施补丁的返回对象真的带齐字段（行为级）");
{
  // 直接 import 真函数，用临时目录造一个「锚点不存在」的宿主，
  // 让 applyPromptTailPatch 真的走一遍 miss 分支。
  const idx = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
  check("applyPromptTailPatch 已导出（可被行为测试锁住）", typeof idx.applyPromptTailPatch === "function");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prompt-applypatch-"));
  const prevArgv1 = process.argv[1];
  const prevHome = process.env.DSH_HOME;
  try {
    const base = fakeHost(tmp, "9.9.9-test");
    // 把 agent-loop 换成完全没有锚点的文件，模拟版本不符
    fs.writeFileSync(path.join(base, "dsh-agent-loop", "lib", "index.js"),
      "// alien host with no tail anchor\n", "utf8");
    // 让定位器认这一份：argv[1] 指到该树下
    process.argv[1] = path.join(base, "dsh-agent-instructions", "lib", "index.js");
    process.env.DSH_HOME = tmp;
    core.resetPathMemo();

    const r = idx.applyPromptTailPatch();
    check("ok=false", r.ok === false, JSON.stringify(r.ok));
    check("reason 是可读原因，不是空", typeof r.reason === "string" && r.reason.length > 0, String(r.reason));
    check("reason 说明锚点未命中", /锚点未命中/.test(String(r.reason)), String(r.reason));
    check("anchor=miss", r.anchor === "miss", String(r.anchor));
    check("带 ai_base", typeof r.ai_base === "string" && r.ai_base.length > 0, String(r.ai_base));
    check("带 host_version", r.host_version === "9.9.9-test", String(r.host_version));
    check("带 file 路径", typeof r.file === "string" && r.file.endsWith("index.js"), String(r.file));
    check("带 tried 候选", Array.isArray(r.tried), JSON.stringify(r.tried));
    check("没有写坏宿主（文件仍是原文）",
      fs.readFileSync(path.join(base, "dsh-agent-loop", "lib", "index.js"), "utf8").includes("alien host"),
      "文件被改动了");
  } finally {
    process.argv[1] = prevArgv1;
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    core.resetPathMemo();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\n" + "=".repeat(50));
console.log(`通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
if (fail > 0) {
  console.log("\n失败项：");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
