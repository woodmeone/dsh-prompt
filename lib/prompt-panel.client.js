/**
 * dsh-prompt · 「提示词」面板（嵌进 dsh-prompt 的 dock 第三个 tab）
 *
 * 这段代码由 scripts/build-client.mjs 注入 client.js 的 loader 工厂体内，
 * 所以能直接用外层作用域的 h / react / useState / useCallback / apiJson 等，
 * 不需要自己 require。
 *
 * 能力（用户要的四件事）：
 *   1. 拖拽排序   —— HTML5 draggable，拖完 POST /dsh-prompt/prompt/reorder
 *   2. 开关       —— 每块一个勾选框
 *   3. 增删改查   —— 新建 / 删除 / 编辑 / 撤销改动 / 恢复出厂
 *   4. 双位置视图 —— 顶部 / 尾部两个 tab
 *
 * 命名空间 .dshpm-* ，与 .dshp-* 不撞。
 */

const PROMPT_PANEL_CSS = `
.dshpm-wrap{display:flex;flex-direction:column;height:100%;min-height:0}
.dshpm-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;
  border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#3a3d44) 40%,transparent)}
.dshpm-bar .sp{flex:1}
.dshpm-btn{cursor:pointer;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#3a3d44) 70%,transparent);
  background:transparent;color:inherit;border-radius:7px;padding:3px 9px;font-size:12px}
.dshpm-btn:hover{background:color-mix(in srgb,currentColor 12%,transparent)}
.dshpm-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}
.dshpm-btn.danger{color:#f85149;border-color:color-mix(in srgb,#f85149 60%,transparent)}
.dshpm-btn[disabled]{opacity:.35;cursor:not-allowed}
.dshpm-tabs{display:flex;gap:4px;padding:6px 12px 0}
.dshpm-tab{appearance:none;border:0;border-bottom:2px solid transparent;background:transparent;color:inherit;
  opacity:.6;cursor:pointer;padding:5px 11px;font-size:12.5px}
.dshpm-tab:hover{opacity:.95}
.dshpm-tab.on{opacity:1;font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,#4c8dff)}
.dshpm-hint{padding:2px 12px 6px;opacity:.5;font-size:11px;line-height:1.55}
.dshpm-body{flex:1;min-height:0;overflow:auto;padding:4px 12px 14px}
.dshpm-row{display:grid;grid-template-columns:24px 28px 1fr 82px 60px 140px;gap:8px;align-items:center;
  padding:6px 3px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#3a3d44) 26%,transparent);border-radius:6px}
.dshpm-row:hover{background:color-mix(in srgb,currentColor 7%,transparent)}
.dshpm-row.open{background:color-mix(in srgb,#4c8dff 10%,transparent)}
.dshpm-row.drag{opacity:.4}
.dshpm-row.over{box-shadow:inset 0 2px 0 var(--dsw-alias-brand-primary,#4c8dff)}
.dshpm-grip{cursor:grab;opacity:.4;text-align:center;user-select:none;font-size:15px;line-height:1}
.dshpm-grip:active{cursor:grabbing}
.dshpm-name{font-weight:500;cursor:pointer;display:flex;align-items:center;gap:6px;min-width:0}
.dshpm-name .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshpm-badge{font-size:9.5px;padding:0 5px;border-radius:4px;border:1px solid currentColor;opacity:.65;flex:none}
.dshpm-num{text-align:right;font-variant-numeric:tabular-nums;opacity:.55;font-size:11px}
.dshpm-select{font-size:11px;background:transparent;color:inherit;
  border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:6px;padding:2px 4px}
.dshpm-editor{border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#3a3d44) 55%,transparent);
  border-radius:10px;margin:6px 0 12px;padding:10px}
.dshpm-editor textarea{width:100%;min-height:220px;resize:vertical;box-sizing:border-box;
  font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.6;padding:9px;border-radius:7px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#3a3d44) 70%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#101216) 70%,transparent);color:inherit}
.dshpm-tools{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
.dshpm-new{display:flex;gap:7px;align-items:center;padding:10px 0 3px;flex-wrap:wrap}
.dshpm-new input{border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#3a3d44) 70%,transparent);
  background:transparent;color:inherit;border-radius:7px;padding:4px 8px;font-size:12px;
  font-family:ui-monospace,Consolas,monospace}
.dshpm-new input.wide{min-width:165px}
.dshpm-msg{padding:6px 12px;font-size:12px}
.dshpm-msg.err{color:#f85149}
.dshpm-msg.ok{color:#3fb950}
.dshpm-empty{opacity:.5;padding:20px 4px;text-align:center}
`;

// 只注入一次；必须在组件之前声明
const promptStyleOnce = { done: false };
function injectPromptPanelCss() {
	if (promptStyleOnce.done || typeof document === "undefined") return;
	promptStyleOnce.done = true;
	if (document.querySelector('style[data-dshpm="1"]')) return;
	const s = document.createElement("style");
	s.setAttribute("data-dshpm", "1");
	s.textContent = PROMPT_PANEL_CSS;
	document.head.append(s);
}

const PROMPT_API = "/dsh-prompt/prompt";

/**
 * 把服务端失败体折成一句人话。
 *
 * 为什么必须先读 body 再判状态码：`applyPatch` 的失败原因是
 * `{ok:false, reason:"锚点未命中（宿主版本可能不同）", file}`，HTTP 400 只是
 * 它的外壳。旧版先 `throw new Error("HTTP " + r.status)`，body 从未被读，
 * 用户只能看到 400 —— 原因全丢。
 */
function describeFailure(data, status) {
	const parts = [];
	const reason = data && (data.reason || data.error);
	if (reason) parts.push(String(reason));
	else parts.push(status ? "HTTP " + status : "op failed");
	if (data && data.ai_base) parts.push("宿主 " + data.ai_base);
	if (data && data.agent_loop) parts.push("文件 " + data.agent_loop);
	if (data && data.host_version) parts.push("版本 " + data.host_version);
	if (data && data.anchor) parts.push("锚点 " + data.anchor);
	if (data && Array.isArray(data.tried) && data.tried.length > 1) {
		parts.push("候选 " + data.tried.length + " 份");
	}
	return parts.join(" · ");
}

async function promptApi(op, payload) {
	const args = Object.assign({ op }, payload || {});
	const r = await fetch(PROMPT_API, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(args),
		credentials: "same-origin",
	});
	// 先解析 body：失败原因写在里面，状态码只是外壳。
	const data = await r.json().catch(() => null);
	if (!data) throw new Error("返回不是 JSON（HTTP " + r.status + "）");
	if (!r.ok || data.ok === false) throw new Error(describeFailure(data, r.status));
	return data;
}

const PROMPT_SLOT_TABS = [
	{ key: "top", label: "顶部", hint: "拼进 systemPrompt 的一大段（system 段内，order 升序）。越靠后越靠近对话。" },
	{ key: "tail", label: "尾部", hint: "每轮作为请求末尾的消息追加，不落盘，所以不会逐轮累积。U 型曲线末端，注意力最强。" },
];

function PromptBlocksPanel() {
	const [tab, setTab] = useState("top");
	const [snap, setSnap] = useState(null);
	const [draft, setDraft] = useState({});
	const [activeId, setActiveId] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const [okMsg, setOkMsg] = useState("");
	const [newBlock, setNewBlock] = useState({ id: "", name: "" });
	const [dragId, setDragId] = useState("");
	const [overId, setOverId] = useState("");

	const refresh = useCallback(async () => {
		setBusy(true);
		try {
			const d = await promptApi("status");
			setSnap(d);
			setErr("");
		} catch (e) {
			setErr(String((e && e.message) || e));
		} finally {
			setBusy(false);
		}
	}, []);

	useEffect(() => {
		injectPromptPanelCss();
		refresh();
	}, [refresh]);

	const doOp = async (op, payload, okText) => {
		setErr(""); setOkMsg("");
		setBusy(true);
		try {
			const r = await promptApi(op, payload);
			setOkMsg(okText || "已生效");
			setSnap(await promptApi("status"));
			return r;
		} catch (e) {
			setErr(String((e && e.message) || e));
			return null;
		} finally {
			setBusy(false);
		}
	};

	const plugin = (snap && snap.plugin) || {};
	const allBlocks = (snap && snap.blocks && snap.blocks.blocks) || [];
	const items = ((snap && snap.blocks && snap.blocks.items) || [])
		.filter((b) => Array.isArray(b.slots) && b.slots.includes(tab));

	const onDrop = async (targetId) => {
		const src = dragId;
		setDragId(""); setOverId("");
		if (!src || src === targetId) return;
		const ids = items.map((b) => b.id);
		const from = ids.indexOf(src);
		const to = ids.indexOf(targetId);
		if (from < 0 || to < 0) return;
		ids.splice(from, 1);
		ids.splice(to, 0, src);
		await doOp("reorder", { slot: tab, ids }, "顺序已更新");
	};

	const active = items.find((b) => b.id === activeId) || null;
	const activeContent = active ? (activeId in draft ? draft[activeId] : active.content) : "";
	const otherSlot = tab === "top" ? "tail" : "top";

	return h("div", { className: "dshpm-wrap" },
		h("div", { className: "dshpm-bar" },
			h("label", { style: { display: "flex", gap: 6, alignItems: "center", fontSize: "12px" } },
				h("input", {
					type: "checkbox", checked: plugin.enabled !== false, disabled: busy,
					onChange: (e) => doOp("setEnabled", { enabled: e.target.checked }, "总开关已更新"),
				}), "总开关"),
			h("label", { style: { display: "flex", gap: 6, alignItems: "center", fontSize: "12px" } },
				h("input", {
					type: "checkbox", checked: plugin.topEnabled !== false, disabled: busy,
					onChange: (e) => doOp("setEnabled", { topEnabled: e.target.checked }, "顶部已更新"),
				}), "顶部"),
			h("label", { style: { display: "flex", gap: 6, alignItems: "center", fontSize: "12px" } },
				h("input", {
					type: "checkbox", checked: plugin.tailEnabled !== false, disabled: busy,
					onChange: (e) => doOp("setEnabled", { tailEnabled: e.target.checked }, "尾部已更新"),
				}), "尾部"),
			h("span", { className: "sp" }),
			h("span", { style: { fontSize: "11px", opacity: .55 } },
				"顶部 " + ((snap && snap.top && snap.top.bytes) || 0) + " 字 · 尾部 "
				+ ((snap && snap.tail && snap.tail.bytes) || 0) + " 字"),
			(snap && snap.host && snap.host.has_ours)
				? h("span", {
					style: { fontSize: "11px", opacity: .55 },
					title: [snap.host.agent_loop, snap.host.ai_base, snap.host.host_version ? "dsh " + snap.host.host_version : ""]
						.filter(Boolean).join("\n"),
				}, "宿主补丁 已装" + (snap.host.host_version ? " · " + snap.host.host_version : ""))
				: h("button", {
					type: "button", className: "dshpm-btn", disabled: busy,
					title: "尾部注入需要一条宿主补丁。不改这条，尾部块装配得出来但发不出去。",
					onClick: () => doOp("applyPatch", {}, "宿主补丁已施加（下次启动完全生效）"),
				}, "装宿主补丁"),
			h("button", { type: "button", className: "dshpm-btn", disabled: busy, onClick: refresh }, "刷新"),
			h("button", {
				type: "button", className: "dshpm-btn", disabled: busy,
				onClick: () => doOp("restoreFactory", {}, "已恢复出厂"),
			}, "恢复出厂"),
		),

		h("div", { className: "dshpm-tabs" },
			PROMPT_SLOT_TABS.map((s) => {
				const n = allBlocks.filter((b) => Array.isArray(b.slots) && b.slots.includes(s.key)).length;
				return h("button", {
					key: s.key, type: "button",
					className: "dshpm-tab" + (tab === s.key ? " on" : ""),
					onClick: () => { setTab(s.key); setActiveId(""); },
				}, s.label + "（" + n + "）");
			}),
		),
		h("div", { className: "dshpm-hint" }, (PROMPT_SLOT_TABS.find((s) => s.key === tab) || {}).hint),

		err ? h("div", { className: "dshpm-msg err" }, err) : null,
		okMsg ? h("div", { className: "dshpm-msg ok" }, okMsg) : null,

		h("div", { className: "dshpm-body" },
			items.length === 0
				? h("div", { className: "dshpm-empty" }, "这个位置还没有块。在下面新建一个。")
				: items.map((b) => {
					const isOpen = activeId === b.id;
					const hasOther = Array.isArray(b.slots) && b.slots.includes(otherSlot);
					return h("div", {
						key: b.id,
						className: "dshpm-row" + (isOpen ? " open" : "") + (dragId === b.id ? " drag" : "") + (overId === b.id ? " over" : ""),
						onDragOver: (e) => { e.preventDefault(); setOverId(b.id); },
						onDrop: (e) => { e.preventDefault(); onDrop(b.id); },
					},
						h("div", {
							className: "dshpm-grip", title: "拖动排序", draggable: true,
							onDragStart: () => setDragId(b.id),
							onDragEnd: () => { setDragId(""); setOverId(""); },
						}, "⠿"),
						h("input", {
							type: "checkbox", title: "开关", checked: b.enabled, disabled: busy,
							onChange: (e) => doOp("setMeta", { id: b.id, patch: { enabled: e.target.checked } },
								e.target.checked ? "已开启" : "已关闭"),
						}),
						h("div", { className: "dshpm-name", onClick: () => setActiveId(isOpen ? "" : b.id) },
							h("span", { className: "t" }, b.name),
							b.builtin ? h("span", { className: "dshpm-badge" }, "默认") : null,
							b.contentSource === "override" ? h("span", { className: "dshpm-badge" }, "已改") : null,
							b.contentSource === "none" ? h("span", { className: "dshpm-badge", style: { color: "#d29922" } }, "无正文") : null,
						),
						h("select", {
							className: "dshpm-select", value: b.role, disabled: busy,
							title: "角色：system=当资料 / user=当指令 / assistant=当自己说过的话",
							onChange: (e) => doOp("setMeta", { id: b.id, patch: { role: e.target.value } }, "角色已更新"),
						},
							h("option", { value: "system" }, "system"),
							h("option", { value: "user" }, "user"),
							h("option", { value: "assistant" }, "assistant"),
						),
						h("div", { className: "dshpm-num" }, b.bytes + " 字"),
						h("div", { style: { display: "flex", gap: "5px" } },
							h("button", {
								type: "button", className: "dshpm-btn", disabled: busy,
								onClick: () => setActiveId(isOpen ? "" : b.id),
							}, isOpen ? "收起" : "编辑"),
							b.builtin
								? h("button", {
									type: "button", className: "dshpm-btn",
									disabled: busy || b.contentSource !== "override",
									title: "丢弃改动，回到出厂正文",
									onClick: () => doOp("revert", { id: b.id }, "已还原正文"),
								}, "还原")
								: h("button", {
									type: "button", className: "dshpm-btn danger", disabled: busy,
									onClick: () => doOp("remove", { id: b.id }, "已删除"),
								}, "删除"),
						),
						isOpen ? h("div", { className: "dshpm-editor", style: { gridColumn: "1 / -1" } },
							h("textarea", {
								value: activeContent,
								placeholder: "这个块的正文…",
								onChange: (e) => {
									const next = Object.assign({}, draft);
									next[b.id] = e.target.value;
									setDraft(next);
								},
							}),
							h("div", { className: "dshpm-tools" },
								h("button", {
									type: "button", className: "dshpm-btn primary", disabled: busy,
									onClick: () => doOp("setContent", { id: b.id, content: activeContent }, "正文已保存"),
								}, "保存"),
								h("button", {
									type: "button", className: "dshpm-btn", disabled: busy,
									onClick: () => {
										const next = Object.assign({}, draft);
										next[b.id] = b.content;
										setDraft(next);
										setErr(""); setOkMsg("");
									},
								}, "放弃修改"),
								h("button", {
									type: "button", className: "dshpm-btn", disabled: busy,
									title: "同时挂到另一个位置 / 从另一个位置移除",
									onClick: () => {
										const cur = (b.slots || []).slice();
										const next = hasOther ? cur.filter((s) => s !== otherSlot) : cur.concat([otherSlot]);
										if (!next.length) { setErr("至少要保留一个位置"); return; }
										doOp("setMeta", { id: b.id, patch: { slots: next } }, "位置已更新");
									},
								}, hasOther ? "从另一位置移除" : "同时挂到另一位置"),
								h("span", { style: { opacity: .5, fontSize: "11px" } },
									"来源：" + b.contentSource + " · " + activeContent.length + " 字"),
							),
						) : null,
					);
				}),

			h("div", { className: "dshpm-new" },
				h("input", {
					className: "wide", placeholder: "新块 id（字母数字 _ . : -）",
					value: newBlock.id,
					onChange: (e) => setNewBlock({ id: e.target.value, name: newBlock.name }),
				}),
				h("input", {
					className: "wide", placeholder: "显示名",
					value: newBlock.name,
					onChange: (e) => setNewBlock({ id: newBlock.id, name: e.target.value }),
				}),
				h("button", {
					type: "button", className: "dshpm-btn primary",
					disabled: busy || !newBlock.id.trim(),
					onClick: async () => {
						const id = newBlock.id.trim();
						const nm = newBlock.name.trim() || id;
						const r = await doOp("add", {
							block: { id, name: nm, slots: [tab], role: tab === "tail" ? "user" : "system" },
						}, "已新建");
						if (r) setNewBlock({ id: "", name: "" });
					},
				}, "新建到「" + (PROMPT_SLOT_TABS.find((s) => s.key === tab) || {}).label + "」"),
			),
		),
	);
}
