window.__ModuleLoader__.load({
	id: "dsh-better-workspaces",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_dom_client = require("react-dom/client");

		const { useState, useEffect, useRef, useCallback, useSyncExternalStore } = react;
		const h = react.createElement;
		const NS = "better-workspaces";
		const API_BASE = "/better-workspaces/api";

		/* ================================================================ */
		/* util                                                              */
		/* ================================================================ */

		function cx() {
			let out = "";
			for (let i = 0; i < arguments.length; i += 1) {
				const part = arguments[i];
				if (part) out += (out === "" ? "" : " ") + part;
			}
			return out;
		}

		function qs(params) {
			const u = new URLSearchParams();
			for (const key of Object.keys(params)) {
				const value = params[key];
				if (value !== undefined && value !== null && value !== "" && value !== false) u.set(key, String(value));
			}
			const s = u.toString();
			return s === "" ? "" : "?" + s;
		}

		async function apiGet(path) {
			const res = await fetch(API_BASE + path, { headers: { Accept: "application/json" } });
			return await res.json();
		}

		async function apiPost(path, body) {
			const res = await fetch(API_BASE + path, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify(body ?? {}),
			});
			return await res.json();
		}

		function fmtNum(n) {
			if (typeof n !== "number" || Number.isNaN(n)) return "0";
			if (n >= 100000) return Math.round(n / 1000) + "k";
			return String(n);
		}

		function createStore(initial) {
			let state = initial;
			const listeners = new Set();
			return {
				get: () => state,
				set: (next) => {
					state = typeof next === "function" ? next(state) : next;
					for (const listener of listeners) {
						try { listener(); } catch { /* listener faults are isolated */ }
					}
				},
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			};
		}

		function useStore(store, selector) {
			const state = useSyncExternalStore(store.subscribe, store.get, store.get);
			return selector(state);
		}

		function fmtRelTime(ts, lang) {
			if (!ts) return "";
			const diff = Date.now() - ts;
			try {
				const rtf = new Intl.RelativeTimeFormat(lang === "en" ? "en" : "zh", { numeric: "auto" });
				const mins = Math.round(diff / 60000);
				if (Math.abs(mins) < 60) return rtf.format(-mins, "minute");
				const hours = Math.round(mins / 60);
				if (Math.abs(hours) < 24) return rtf.format(-hours, "hour");
				return rtf.format(-Math.round(hours / 24), "day");
			} catch {
				return new Date(ts).toLocaleString();
			}
		}

		/* ================================================================ */
		/* css                                                               */
		/* ================================================================ */

		const CSS = `
.dsh-bw-root-vars { --dsh-bw-green: var(--dsw-alias-state-success-primary, #1a7f37); --dsh-bw-red: var(--dsw-alias-state-error-primary, #cf222e); --dsh-bw-yellow: var(--dsw-alias-state-warn-primary, #9a6700); --dsh-bw-purple: #7347af; --dsh-bw-border: var(--dsw-alias-border-l3, rgba(128,128,128,.25)); --dsh-bw-hover: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); --dsh-bw-tertiary: var(--dsw-alias-label-tertiary, #8b949e); --dsh-bw-secondary: var(--dsw-alias-label-secondary, #59636e); --dsh-bw-primary-label: var(--dsw-alias-label-primary, #1f2328); --dsh-bw-accent: var(--dsw-alias-state-business-primary, #2f6feb); --dsh-bw-bg: var(--dsw-alias-bg-base, #fff); --dsh-bw-code: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
@media (prefers-color-scheme: dark) { .dsh-bw-root-vars { --dsh-bw-purple: #a890d5; } }
.dsh-bw-green { color: var(--dsh-bw-green); }
.dsh-bw-red { color: var(--dsh-bw-red); }
.dsh-bw-yellow { color: var(--dsh-bw-yellow); }
.dsh-bw-purple { color: var(--dsh-bw-purple); }

/* ---- sidebar rows: stretch + badge row ---- */
[class*="_sessionRow"] { height: auto !important; min-height: 32px; flex-wrap: wrap; align-content: center; row-gap: 0; }
.dsh-bw-badges { flex-basis: 100%; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 0 8px 3px 26px; font-size: 11px; line-height: 16px; color: var(--dsh-bw-tertiary); pointer-events: none; overflow: hidden; }
.dsh-bw-badge { display: inline-flex; align-items: center; gap: 3px; min-width: 0; white-space: nowrap; }
.dsh-bw-badge-branch { max-width: 45%; overflow: hidden; text-overflow: ellipsis; }
.dsh-bw-badge-diff { font-variant-numeric: tabular-nums; }
.dsh-bw-ring { flex: none; }

/* ---- hero control ---- */
.dsh-bw-hero { display: inline-flex; align-items: center; gap: 2px; min-width: 0; position: relative; }
.dsh-bw-hero-btn { max-width: 240px; min-height: 28px; color: var(--dsh-bw-primary-label); cursor: pointer; background: 0 0; border: none; border-radius: 16px; align-items: center; gap: 4px; padding: 0 8px; font-size: 13px; font-weight: 500; line-height: 20px; display: inline-flex; }
.dsh-bw-hero-btn:hover:not(:disabled), .dsh-bw-hero-btn[aria-expanded="true"] { background: var(--dsh-bw-hover); }
.dsh-bw-hero-btn:disabled { cursor: default; opacity: .6; }
.dsh-bw-hero-label { text-overflow: ellipsis; white-space: nowrap; overflow: hidden; }
.dsh-bw-hero-chevron { color: var(--dsw-alias-label-caption, #999); flex: none; }
.dsh-bw-hero-error { color: var(--dsh-bw-red); font-size: 12px; line-height: 18px; max-width: 320px; overflow-wrap: anywhere; padding: 0 8px; }
.dsh-bw-hero-panel-row { display: flex; align-items: center; gap: 6px; padding: 8px 10px; }
.dsh-bw-hero-input { border: .5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.4)); background: 0 0; color: var(--dsh-bw-primary-label); border-radius: 6px; outline: none; padding: 2px 8px; font-size: 12px; line-height: 20px; min-width: 140px; }

/* ---- popover ---- */
.dsh-bw-pop { position: relative; display: inline-flex; }
.dsh-bw-pop-panel { position: absolute; top: calc(100% + 4px); left: 0; z-index: 60; min-width: 180px; max-width: 340px; background: var(--dsh-bw-bg); border: 1px solid var(--dsh-bw-border); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 4px; color: var(--dsh-bw-primary-label); font-size: 12px; }
.dsh-bw-pop-right { left: auto; right: 0; }
.dsh-bw-menu { display: flex; flex-direction: column; max-height: 320px; overflow-y: auto; }
.dsh-bw-menu-item { display: flex; align-items: baseline; gap: 6px; width: 100%; text-align: left; background: 0 0; border: none; border-radius: 6px; padding: 5px 8px; cursor: pointer; color: var(--dsh-bw-primary-label); font-size: 12px; line-height: 18px; }
.dsh-bw-menu-item:hover:not(:disabled) { background: var(--dsh-bw-hover); }
.dsh-bw-menu-item:disabled { cursor: default; opacity: .55; }
.dsh-bw-menu-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-bw-menu-hint { flex: none; color: var(--dsh-bw-tertiary); font-size: 11px; }
.dsh-bw-menu-reason { flex: none; color: var(--dsh-bw-tertiary); font-size: 11px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-bw-menu-sep { height: 1px; background: var(--dsh-bw-border); margin: 4px 6px; }
.dsh-bw-menu-item-active .dsh-bw-menu-label { color: var(--dsh-bw-accent); font-weight: 500; }

/* ---- dock pill ---- */
.dsh-bw-pill { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; margin: 2px 0; border-radius: 12px; border: 1px solid var(--dsh-bw-border); background: 0 0; color: var(--dsh-bw-secondary); cursor: pointer; font-size: 12px; line-height: 1; font-variant-numeric: tabular-nums; }
.dsh-bw-pill:hover { background: var(--dsh-bw-hover); color: var(--dsh-bw-primary-label); }
.dsh-bw-pill-icon { color: var(--dsh-bw-tertiary); }

/* ---- shared view chrome ---- */
.dsh-bw-view { display: flex; flex-direction: column; flex: 1; min-height: 0; height: 100%; overflow: hidden; font-size: 13px; color: var(--dsh-bw-primary-label); background: var(--dsh-bw-bg); }
.dsh-bw-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--dsh-bw-border); flex-wrap: wrap; flex: none; }
.dsh-bw-toolbar-spacer { flex: 1; }
.dsh-bw-seg { display: inline-flex; border: 1px solid var(--dsh-bw-border); border-radius: 8px; overflow: hidden; }
.dsh-bw-seg button { background: 0 0; border: none; padding: 3px 10px; font-size: 12px; cursor: pointer; color: var(--dsh-bw-secondary); }
.dsh-bw-seg button[aria-pressed="true"] { background: var(--dsh-bw-hover); color: var(--dsh-bw-primary-label); font-weight: 500; }
.dsh-bw-btn { height: 26px; padding: 0 12px; border-radius: 13px; border: 1px solid var(--dsh-bw-border); background: 0 0; cursor: pointer; font-size: 12px; color: var(--dsh-bw-primary-label); display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.dsh-bw-btn:hover:not(:disabled) { background: var(--dsh-bw-hover); }
.dsh-bw-btn:disabled { opacity: .45; cursor: default; }
.dsh-bw-btn-primary { background: var(--dsh-bw-accent); border-color: transparent; color: #fff; }
.dsh-bw-btn-primary:hover:not(:disabled) { background: var(--dsh-bw-accent); filter: brightness(1.08); }
.dsh-bw-btn-danger { color: var(--dsh-bw-red); }
.dsh-bw-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--dsh-bw-secondary); cursor: pointer; user-select: none; }
.dsh-bw-banner { margin: 8px 16px 0; padding: 6px 10px; font-size: 12px; border-radius: 8px; flex: none; overflow-wrap: anywhere; }
.dsh-bw-banner-ok { background: color-mix(in srgb, var(--dsh-bw-green) 12%, transparent); color: var(--dsh-bw-green); }
.dsh-bw-banner-err { background: color-mix(in srgb, var(--dsh-bw-red) 12%, transparent); color: var(--dsh-bw-red); }
.dsh-bw-pr { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 420px; font-size: 12px; }
.dsh-bw-pr-num { flex: none; font-weight: 600; font-variant-numeric: tabular-nums; }
.dsh-bw-pr-title { color: var(--dsh-bw-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dsh-bw-pr a { color: var(--dsh-bw-accent); text-decoration: none; flex: none; }
.dsh-bw-branch { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--dsh-bw-secondary); min-width: 0; }
.dsh-bw-branch-name { font-family: var(--dsh-bw-code); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.dsh-bw-sync { font-size: 12px; color: var(--dsh-bw-tertiary); font-variant-numeric: tabular-nums; flex: none; }

/* ---- diff/files split ---- */
.dsh-bw-body { flex: 1; min-height: 0; display: flex; }
.dsh-bw-filelist { width: 320px; max-width: 40%; flex: none; border-right: 1px solid var(--dsh-bw-border); overflow-y: auto; }
.dsh-bw-fileitem { padding: 4px 10px; cursor: pointer; display: flex; gap: 6px; align-items: baseline; font-size: 12px; }
.dsh-bw-fileitem:hover { background: var(--dsh-bw-hover); }
.dsh-bw-fileitem-active { background: var(--dsh-bw-hover); }
.dsh-bw-fileitem-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-bw-fileitem-stat { flex: none; font-variant-numeric: tabular-nums; font-size: 11px; }
.dsh-bw-statusletter { flex: none; width: 14px; text-align: center; font-family: var(--dsh-bw-code); font-weight: 600; }
.dsh-bw-diffpane { flex: 1; min-width: 0; overflow: auto; }
.dsh-bw-empty { padding: 32px; text-align: center; color: var(--dsh-bw-tertiary); font-size: 13px; }
.dsh-bw-file { border-bottom: 1px solid var(--dsh-bw-border); }
.dsh-bw-filehead { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: var(--dsh-bw-bg); border-bottom: 1px solid var(--dsh-bw-border); cursor: pointer; font-size: 12px; }
.dsh-bw-filehead:hover { background: var(--dsh-bw-hover); }
.dsh-bw-caret { flex: none; color: var(--dsh-bw-tertiary); width: 12px; }
.dsh-bw-filepath { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--dsh-bw-code); font-weight: 500; }
.dsh-bw-filestat { flex: none; font-variant-numeric: tabular-nums; }
.dsh-bw-notice { padding: 12px; color: var(--dsh-bw-tertiary); font-size: 12px; }
.dsh-bw-hunkhdr { padding: 2px 12px 2px 100px; background: color-mix(in srgb, var(--dsh-bw-accent) 6%, transparent); color: var(--dsh-bw-tertiary); font-family: var(--dsh-bw-code); font-size: 11px; line-height: 18px; white-space: pre; overflow: hidden; }
.dsh-bw-line { display: flex; font-family: var(--dsh-bw-code); font-size: 12px; line-height: 18px; }
.dsh-bw-ln { flex: none; width: 44px; text-align: right; padding-right: 8px; color: var(--dsw-alias-label-caption, #999); user-select: none; font-size: 11px; line-height: 18px; }
.dsh-bw-code { flex: 1; min-width: 0; white-space: pre; padding-right: 12px; }
.dsh-bw-wrap .dsh-bw-code { white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-bw-line-add { background: color-mix(in srgb, var(--dsh-bw-green) 13%, transparent); }
.dsh-bw-line-del { background: color-mix(in srgb, var(--dsh-bw-red) 13%, transparent); }
.dsh-bw-line-meta { color: var(--dsh-bw-tertiary); font-style: italic; }
.dsh-bw-commitrow { display: flex; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--dsh-bw-border); align-items: center; flex: none; }
.dsh-bw-commit-input { flex: 1; min-width: 0; border: 1px solid var(--dsh-bw-border); background: 0 0; color: var(--dsh-bw-primary-label); border-radius: 8px; outline: none; padding: 4px 10px; font-size: 12px; line-height: 18px; }
.dsh-bw-commit-input:focus { border-color: var(--dsh-bw-accent); }
.dsh-bw-commits { overflow-y: auto; border-bottom: 1px solid var(--dsh-bw-border); max-height: 220px; flex: none; }
.dsh-bw-commit { padding: 5px 12px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; font-size: 12px; }
.dsh-bw-commit:hover { background: var(--dsh-bw-hover); }
.dsh-bw-commit-active { background: var(--dsh-bw-hover); }
.dsh-bw-sha { font-family: var(--dsh-bw-code); color: var(--dsh-bw-accent); flex: none; }
.dsh-bw-commit-subject { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-bw-commit-meta { flex: none; color: var(--dsh-bw-tertiary); font-size: 11px; }
.dsh-bw-unpushed-dot { flex: none; color: var(--dsh-bw-green); font-size: 11px; }
.dsh-bw-form { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; min-width: 260px; }
.dsh-bw-form label { font-size: 12px; color: var(--dsh-bw-secondary); display: flex; flex-direction: column; gap: 3px; }
.dsh-bw-form input[type="text"], .dsh-bw-form textarea { border: 1px solid var(--dsh-bw-border); background: 0 0; color: var(--dsh-bw-primary-label); border-radius: 6px; outline: none; padding: 4px 8px; font-size: 12px; font-family: inherit; }
.dsh-bw-form textarea { min-height: 80px; resize: vertical; }
.dsh-bw-form-actions { display: flex; gap: 6px; justify-content: flex-end; align-items: center; }

/* ---- files tab ---- */
.dsh-bw-tree { width: 300px; max-width: 40%; flex: none; border-right: 1px solid var(--dsh-bw-border); overflow-y: auto; padding: 4px 0; }
.dsh-bw-treeitem { padding: 2px 8px; cursor: pointer; display: flex; gap: 6px; align-items: center; white-space: nowrap; font-size: 12px; color: var(--dsh-bw-primary-label); }
.dsh-bw-treeitem:hover { background: var(--dsh-bw-hover); }
.dsh-bw-treeitem-active { background: var(--dsh-bw-hover); }
.dsh-bw-treeicon { flex: none; color: var(--dsh-bw-tertiary); width: 14px; text-align: center; }
.dsh-bw-treename { overflow: hidden; text-overflow: ellipsis; }
.dsh-bw-viewer { flex: 1; min-width: 0; overflow: auto; display: flex; flex-direction: column; }
.dsh-bw-viewer-head { flex: none; padding: 6px 12px; border-bottom: 1px solid var(--dsh-bw-border); font-family: var(--dsh-bw-code); font-size: 12px; display: flex; gap: 8px; align-items: center; }
.dsh-bw-viewer-body { flex: 1; min-height: 0; overflow: auto; }
.dsh-bw-viewer-body pre { margin: 0; font-family: var(--dsh-bw-code); font-size: 12px; line-height: 18px; }
.dsh-bw-vline { display: flex; }
.dsh-bw-vline:hover { background: var(--dsh-bw-hover); }
.dsh-bw-img { max-width: 100%; height: auto; margin: 12px; }
`;

		const CSS_TAG = "dsh-better-workspaces/client.css";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]') === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-better-workspaces";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		// apply the vars scope globally: attach class to <html>
		if (typeof document !== "undefined") document.documentElement.classList.add("dsh-bw-root-vars");

		/* ================================================================ */
		/* locale dictionaries                                               */
		/* ================================================================ */

		const zh = {
			"view.files": "文件",
			"view.diff": "diff",
			"hero.modeLocal": "本地",
			"hero.modeWorktree": "新建 worktree",
			"hero.wtTrigger": "wt: {branch}",
			"hero.pickBranch": "分支:{branch}",
			"hero.newBranchItem": "＋ 新建分支…",
			"hero.newBranchPlaceholder": "新分支名",
			"hero.create": "创建",
			"hero.creating": "创建中…",
			"hero.switching": "切换中…",
			"hero.failed": "失败:{message}",
			"hero.baseHint": "基于 {branch}",
			"hero.current": "当前",
			"hero.default": "默认",
			"pill.title": "查看代码变更",
			"pill.dirty": "{n} 个文件有改动",
			"diff.modeUncommitted": "未提交",
			"diff.modeBase": "对比基线",
			"diff.paneFiles": "文件",
			"diff.paneCommits": "提交",
			"diff.empty": "没有变更",
			"diff.binary": "二进制",
			"diff.binaryBody": "二进制文件,不显示内容",
			"diff.tooLarge": "过大",
			"diff.tooLargeBody": "该文件差异过大,已省略",
			"diff.truncated": "差异总量过大,部分文件已省略",
			"diff.refresh": "刷新",
			"diff.ignoreWs": "忽略空白",
			"diff.wrap": "自动换行",
			"diff.commitPlaceholder": "提交信息(暂存全部并提交)",
			"diff.commitAll": "提交全部",
			"diff.backToBranch": "← 返回分支 diff",
			"diff.unpushed": "未推送",
			"diff.prMergeable": "可合并",
			"diff.prConflicting": "有冲突",
			"diff.prDraft": "草稿",
			"diff.openPr": "打开",
			"diff.merge": "合并 PR",
			"diff.mergeMethod": "合并方式",
			"diff.method.squash": "squash",
			"diff.method.merge": "merge",
			"diff.method.rebase": "rebase",
			"diff.autoMerge": "自动合并",
			"diff.mergeRun": "执行合并",
			"diff.createPrTitle": "标题",
			"diff.createPrBody": "描述",
			"diff.createPrDraft": "以草稿创建",
			"diff.createPrRun": "创建 PR",
			"diff.commitListEmpty": "基线之上没有提交",
			"diff.loading": "加载中…",
			"diff.notGit": "此工作区不是 git 仓库",
			"diff.checks": "检查:{status}({completed}/{total})",
			"checks.success": "通过",
			"checks.pending": "进行中",
			"checks.failure": "失败",
			"checks.none": "无",
			"files.empty": "空目录",
			"files.textTooLong": "文件过长,仅显示前 {n} 行",
			"files.pickHint": "从左侧选择一个文件",
			"files.binary": "二进制文件({size} 字节),无法预览",
			"files.tooLarge": "文件过大({size} 字节),无法预览",
			"files.missing": "文件不存在",
			"actions.commit": "提交",
			"actions.pull": "拉取",
			"actions.push": "推送",
			"actions.fetch": "抓取远端",
			"actions.discard": "丢弃改动",
			"actions.mergeToBase": "合并到基线",
			"actions.updateFromBase": "从基线更新",
			"actions.createPr": "创建 PR",
			"actions.mergePr": "合并 PR",
			"actions.autoMergeOff": "关闭自动合并",
			"actions.archive": "归档 worktree",
			"actions.more": "更多",
			"actions.commit.done": "已提交",
			"actions.pull.done": "已拉取",
			"actions.push.done": "已推送",
			"actions.fetch.done": "已抓取远端",
			"actions.discard.done": "已丢弃改动",
			"actions.mergeToBase.done": "已合并到基线",
			"actions.updateFromBase.done": "已从基线更新",
			"actions.createPr.done": "PR 已创建",
			"actions.mergePr.done": "PR 已合并",
			"actions.autoMergeOff.done": "已关闭自动合并",
			"actions.archive.done": "worktree 已归档",
			"actions.failed": "操作失败",
			"actions.disabled.agentRunning": "Agent 正在运行",
			"actions.commit.clean": "无未提交改动",
			"actions.commit.noMessage": "请填写提交信息",
			"actions.pull.noRemote": "无远端",
			"actions.pull.upToDate": "已是最新",
			"actions.push.noRemote": "无远端",
			"actions.push.noBranch": "无分支(detached HEAD)",
			"actions.push.nothing": "无未推送提交",
			"actions.mergePr.noPr": "没有打开的 PR",
			"actions.mergePr.notOpen": "PR 未打开",
			"actions.mergePr.draft": "草稿 PR 不可合并",
			"actions.mergePr.conflicting": "PR 有冲突",
			"actions.merge.detached": "detached HEAD,无法合并",
			"actions.merge.dirtyCurrent": "有未提交改动,先提交或丢弃",
			"actions.merge.dirtyOwner": "基线分支工作区有未提交改动",
			"actions.merge.conflict": "合并冲突",
			"actions.mergeToBase.onBase": "当前就在基线分支",
			"actions.mergeToBase.noOwner": "基线分支未在任何 worktree 检出",
			"actions.mergeToBase.nothing": "无领先基线的提交",
			"actions.updateFromBase.noBase": "无法解析基线分支",
			"actions.updateFromBase.upToDate": "已包含基线全部提交",
			"actions.pr.notGithub": "远端不是 GitHub 或无法解析",
			"actions.archive.notManaged": "仅托管 worktree 可归档",
			"actions.discard.confirm": "确定丢弃全部未提交改动?不可恢复。",
			"actions.discard.unsafePath": "路径不安全",
			"actions.archive.confirm": "确定归档(删除)该 worktree 目录?",
			"actions.archive.unsafeConfirm": "{message}。仍然强制归档?",
			"actions.unknown": "未知操作:{name}",
		};

		const en = {
			"view.files": "Files",
			"view.diff": "diff",
			"hero.modeLocal": "Local",
			"hero.modeWorktree": "New worktree",
			"hero.wtTrigger": "wt: {branch}",
			"hero.pickBranch": "Branch: {branch}",
			"hero.newBranchItem": "＋ New branch…",
			"hero.newBranchPlaceholder": "New branch name",
			"hero.create": "Create",
			"hero.creating": "Creating…",
			"hero.switching": "Switching…",
			"hero.failed": "Failed: {message}",
			"hero.baseHint": "from {branch}",
			"hero.current": "current",
			"hero.default": "default",
			"pill.title": "View changes",
			"pill.dirty": "{n} files changed",
			"diff.modeUncommitted": "Uncommitted",
			"diff.modeBase": "vs base",
			"diff.paneFiles": "Files",
			"diff.paneCommits": "Commits",
			"diff.empty": "No changes",
			"diff.binary": "BIN",
			"diff.binaryBody": "Binary file — content hidden",
			"diff.tooLarge": "LARGE",
			"diff.tooLargeBody": "File diff too large — omitted",
			"diff.truncated": "Total diff too large — some files omitted",
			"diff.refresh": "Refresh",
			"diff.ignoreWs": "Ignore whitespace",
			"diff.wrap": "Wrap lines",
			"diff.commitPlaceholder": "Commit message (stage all & commit)",
			"diff.commitAll": "Commit all",
			"diff.backToBranch": "← Back to branch diff",
			"diff.unpushed": "unpushed",
			"diff.prMergeable": "mergeable",
			"diff.prConflicting": "conflicting",
			"diff.prDraft": "draft",
			"diff.openPr": "Open",
			"diff.merge": "Merge PR",
			"diff.mergeMethod": "Method",
			"diff.method.squash": "squash",
			"diff.method.merge": "merge",
			"diff.method.rebase": "rebase",
			"diff.autoMerge": "Auto-merge",
			"diff.mergeRun": "Merge",
			"diff.createPrTitle": "Title",
			"diff.createPrBody": "Description",
			"diff.createPrDraft": "Create as draft",
			"diff.createPrRun": "Create PR",
			"diff.commitListEmpty": "No commits above base",
			"diff.loading": "Loading…",
			"diff.notGit": "This workspace is not a git repository",
			"diff.checks": "Checks: {status} ({completed}/{total})",
			"checks.success": "passing",
			"checks.pending": "pending",
			"checks.failure": "failing",
			"checks.none": "none",
			"files.empty": "Empty directory",
			"files.textTooLong": "File too long — showing first {n} lines",
			"files.pickHint": "Select a file on the left",
			"files.binary": "Binary file ({size} bytes) — no preview",
			"files.tooLarge": "File too large ({size} bytes) — no preview",
			"files.missing": "File does not exist",
			"actions.commit": "Commit",
			"actions.pull": "Pull",
			"actions.push": "Push",
			"actions.fetch": "Fetch",
			"actions.discard": "Discard",
			"actions.mergeToBase": "Merge to base",
			"actions.updateFromBase": "Update from base",
			"actions.createPr": "Create PR",
			"actions.mergePr": "Merge PR",
			"actions.autoMergeOff": "Disable auto-merge",
			"actions.archive": "Archive worktree",
			"actions.more": "More",
			"actions.commit.done": "Committed",
			"actions.pull.done": "Pulled",
			"actions.push.done": "Pushed",
			"actions.fetch.done": "Fetched",
			"actions.discard.done": "Changes discarded",
			"actions.mergeToBase.done": "Merged into base",
			"actions.updateFromBase.done": "Updated from base",
			"actions.createPr.done": "PR created",
			"actions.mergePr.done": "PR merged",
			"actions.autoMergeOff.done": "Auto-merge disabled",
			"actions.archive.done": "Worktree archived",
			"actions.failed": "Action failed",
			"actions.disabled.agentRunning": "Agent is running",
			"actions.commit.clean": "Nothing to commit",
			"actions.commit.noMessage": "Enter a commit message",
			"actions.pull.noRemote": "No remote",
			"actions.pull.upToDate": "Up to date",
			"actions.push.noRemote": "No remote",
			"actions.push.noBranch": "No branch (detached HEAD)",
			"actions.push.nothing": "Nothing to push",
			"actions.mergePr.noPr": "No open PR",
			"actions.mergePr.notOpen": "PR is not open",
			"actions.mergePr.draft": "Draft PR cannot be merged",
			"actions.mergePr.conflicting": "PR has conflicts",
			"actions.merge.detached": "Detached HEAD — cannot merge",
			"actions.merge.dirtyCurrent": "Uncommitted changes — commit or discard first",
			"actions.merge.dirtyOwner": "Base branch working tree has uncommitted changes",
			"actions.merge.conflict": "Merge conflict",
			"actions.mergeToBase.onBase": "Already on the base branch",
			"actions.mergeToBase.noOwner": "Base branch is not checked out in any worktree",
			"actions.mergeToBase.nothing": "No commits ahead of base",
			"actions.updateFromBase.noBase": "Cannot resolve the base branch",
			"actions.updateFromBase.upToDate": "Already contains every base commit",
			"actions.pr.notGithub": "Remote is not GitHub or unparsable",
			"actions.archive.notManaged": "Only managed worktrees can be archived",
			"actions.discard.confirm": "Discard ALL uncommitted changes? This cannot be undone.",
			"actions.discard.unsafePath": "Unsafe path",
			"actions.archive.confirm": "Archive (delete) this worktree directory?",
			"actions.archive.unsafeConfirm": "{message}. Force archive anyway?",
			"actions.unknown": "Unknown action: {name}",
		};

		/* ================================================================ */
		/* module singletons (set in apply)                                  */
		/* ================================================================ */

		let appCtx = null;
		let feed = null;
		let tt = (key, params) => key;

		function t(key, params) {
			const raw = tt(key, params);
			if (raw === key && params) {
				// extremely small fallback interpolation if locale service returned the key
				let out = key;
				for (const name of Object.keys(params)) out = out.replace("{" + name + "}", String(params[name]));
				return out;
			}
			return raw;
		}

		function lang() {
			try {
				const value = appCtx && appCtx.locale && appCtx.locale.current;
				if (typeof value === "string" && value.startsWith("en")) return "en";
				if (typeof value === "function") {
					const v = value();
					if (typeof v === "string" && v.startsWith("en")) return "en";
				}
			} catch { /* default zh */ }
			return "zh";
		}

		/* ================================================================ */
		/* git feed (SSE + polling snapshot store)                           */
		/* ================================================================ */

		function createGitFeed() {
			const store = createStore({ byCwd: {}, tracked: {} });
			const serialized = new Map();
			let es = null;
			let pollTimer = null;

			function merge(snapshot) {
				if (!snapshot || typeof snapshot.cwd !== "string") return;
				let key;
				try {
					key = JSON.stringify({ ...snapshot, at: 0 });
				} catch {
					key = String(snapshot.at);
				}
				if (serialized.get(snapshot.cwd) === key) return;
				serialized.set(snapshot.cwd, key);
				store.set((s) => ({ ...s, byCwd: { ...s.byCwd, [snapshot.cwd]: snapshot } }));
			}

			async function pollCwd(cwd) {
				try {
					const result = await apiPost("/snapshots", { cwds: [cwd] });
					if (result && result.ok && result.byCwd && result.byCwd[cwd]) merge(result.byCwd[cwd]);
				} catch { /* transient */ }
			}

			async function pollAll() {
				const cwds = Object.keys(store.get().tracked);
				if (cwds.length === 0) return;
				try {
					const result = await apiPost("/snapshots", { cwds });
					if (result && result.ok) for (const key of Object.keys(result.byCwd)) merge(result.byCwd[key]);
				} catch { /* transient */ }
			}

			function connect() {
				try {
					es = new EventSource(API_BASE + "/events");
					es.addEventListener("snapshot", (event) => {
						try {
							merge(JSON.parse(event.data));
						} catch { /* malformed frame */ }
					});
				} catch {
					es = null; // polling covers
				}
			}

			connect();
			pollTimer = setInterval(pollAll, 15000);

			return {
				store,
				track(cwd) {
					if (!cwd) return;
					const already = store.get().tracked[cwd];
					if (!already) {
						store.set((s) => ({ ...s, tracked: { ...s.tracked, [cwd]: true } }));
						pollCwd(cwd);
					}
				},
				untrack(cwd) {
					if (!cwd) return;
					store.set((s) => {
						if (!s.tracked[cwd]) return s;
						const tracked = { ...s.tracked };
						delete tracked[cwd];
						return { ...s, tracked };
					});
				},
				refresh(cwd) {
					if (cwd) pollCwd(cwd);
					else pollAll();
				},
				dispose() {
					try { if (es) es.close(); } catch { /* ignore */ }
					if (pollTimer) clearInterval(pollTimer);
				},
			};
		}

		const detectCache = new Map();
		async function detectPath(path) {
			const hit = detectCache.get(path);
			if (hit && Date.now() - hit.at < 10000) return hit.value;
			let value;
			try {
				value = await apiGet("/detect" + qs({ path }));
			} catch {
				value = { ok: false, isGit: false };
			}
			detectCache.set(path, { at: Date.now(), value });
			return value;
		}

		/* ================================================================ */
		/* shared bits: checks ring, popover, menu                           */
		/* ================================================================ */

		function ChecksRing({ checks }) {
			const radius = 5;
			const circ = 2 * Math.PI * radius;
			const total = Math.max(checks.total || 0, 1);
			const frac = Math.min((checks.completed || 0) / total, 1);
			const color =
				checks.status === "failure" ? "var(--dsh-bw-red)" :
				checks.status === "pending" ? "var(--dsh-bw-yellow)" : "var(--dsh-bw-green)";
			return h("svg", {
				width: 12, height: 12, viewBox: "0 0 12 12", className: "dsh-bw-ring",
				"aria-label": t("diff.checks", { status: t("checks." + (checks.status || "none")), completed: checks.completed || 0, total: checks.total || 0 }),
			},
				h("circle", { cx: 6, cy: 6, r: radius, fill: "none", stroke: "currentColor", opacity: 0.22, strokeWidth: 2 }),
				frac > 0 && h("circle", {
					cx: 6, cy: 6, r: radius, fill: "none", stroke: color, strokeWidth: 2,
					strokeDasharray: (frac * circ).toFixed(2) + " " + circ.toFixed(2),
					transform: "rotate(-90 6 6)", strokeLinecap: "round",
				}));
		}

		function PrNumBadge({ pr }) {
			const colorClass = pr.state === "merged" ? "dsh-bw-purple" : pr.state === "open" ? "dsh-bw-green" : "dsh-bw-red";
			return h("span", { className: cx("dsh-bw-badge dsh-bw-pr-num", colorClass) }, "#" + pr.number);
		}

		function Popover({ trigger, children, align, panelClass }) {
			const [open, setOpen] = useState(false);
			const ref = useRef(null);
			useEffect(() => {
				if (!open) return undefined;
				const onDoc = (event) => {
					if (ref.current && !ref.current.contains(event.target)) setOpen(false);
				};
				const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
				document.addEventListener("mousedown", onDoc);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("mousedown", onDoc);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);
			return h("div", { className: "dsh-bw-pop", ref },
				trigger({ open, toggle: () => setOpen((o) => !o) }),
				open && h("div", { className: cx("dsh-bw-pop-panel", align === "right" && "dsh-bw-pop-right", panelClass) }, children(() => setOpen(false))));
		}

		function MenuList({ items, onSelect }) {
			return h("div", { className: "dsh-bw-menu" },
				items.map((item) =>
					item.separator
						? h("div", { key: item.id, className: "dsh-bw-menu-sep" })
						: h("button", {
							key: item.id, type: "button", className: cx("dsh-bw-menu-item", item.active && "dsh-bw-menu-item-active"),
							disabled: Boolean(item.disabled), title: item.disabled ? item.reason || undefined : item.title || undefined,
							onClick: () => { if (!item.disabled) onSelect(item.id); },
						},
							h("span", { className: "dsh-bw-menu-label" }, item.label),
							item.hint ? h("span", { className: "dsh-bw-menu-hint" }, item.hint) : null)));
		}

		function StatusLetter({ status }) {
			const letter = status === "added" ? "A" : status === "deleted" ? "D" : status === "renamed" ? "R" : status === "copied" ? "C" : status === "binary" ? "B" : status === "too_large" ? "L" : status === "type-changed" ? "T" : "M";
			const color = status === "added" ? "dsh-bw-green" : status === "deleted" ? "dsh-bw-red" : status === "renamed" || status === "copied" ? "dsh-bw-yellow" : "";
			return h("span", { className: cx("dsh-bw-statusletter", color) }, letter);
		}

		/**
		 * Find-or-create the Workspace for an absolute path and open its
		 * (reused blank or fresh) session — the hero staging exit and the
		 * post-archive escape hatch share this.
		 */
		async function openWorkspaceFor(path) {
			const workspaces = appCtx.workspaces;
			const items = (workspaces && (workspaces.items || (workspaces.getSnapshot && workspaces.getSnapshot().items))) || [];
			let workspace = items.find((w) => w.path === path);
			if (!workspace) {
				const created = await workspaces.create({ path });
				if (!created || !created.ok) {
					throw new Error((created && created.error && created.error.message) || "workspace create failed");
				}
				workspace = created.value.workspace;
			}
			const uiWorkspace = appCtx.get("uiWorkspace");
			let sessionId;
			if (uiWorkspace && uiWorkspace.connectWorkspace) {
				sessionId = await uiWorkspace.connectWorkspace(workspace.workspaceId);
			} else {
				const raw = await appCtx.sessions.create({ workspaceId: workspace.workspaceId });
				sessionId = typeof raw === "string" ? raw : raw && raw.value ? raw.value.sessionId || raw.value.session || raw.value : raw;
			}
			if (sessionId) appCtx.sessions.open(sessionId);
		}

		/* ================================================================ */
		/* sidebar badges                                                    */
		/* ================================================================ */

		function syncOf(snapshot) {
			const ahead = snapshot.upstream ? snapshot.upstream.ahead : snapshot.originDelta ? snapshot.originDelta.ahead : null;
			const behind = snapshot.upstream ? snapshot.upstream.behind : snapshot.originDelta ? snapshot.originDelta.behind : null;
			return { ahead, behind };
		}

		function Badges({ cwd }) {
			const snapshot = useStore(feed.store, (s) => (cwd ? s.byCwd[cwd] : undefined));
			useEffect(() => {
				if (!cwd) return undefined;
				feed.track(cwd);
				return () => feed.untrack(cwd);
			}, [cwd]);
			if (!snapshot || !snapshot.isGit) return null;
			const badges = [];
			const branchName = snapshot.branch ?? (snapshot.detached ? "@" + (snapshot.detachedShort || "") : null);
			if (branchName) {
				badges.push(h("span", { key: "br", className: "dsh-bw-badge dsh-bw-badge-branch", title: branchName }, branchName));
			}
			if (snapshot.pr && snapshot.pr.number) {
				badges.push(h(PrNumBadge, { key: "pr", pr: snapshot.pr }));
				if (snapshot.pr.checks && snapshot.pr.checks.status !== "none" && (snapshot.pr.checks.total || 0) > 0) {
					badges.push(h(ChecksRing, { key: "ck", checks: snapshot.pr.checks }));
				}
			}
			const stat = snapshot.diffStat;
			if (stat && (stat.additions > 0 || stat.deletions > 0)) {
				badges.push(h("span", { key: "ds", className: "dsh-bw-badge dsh-bw-badge-diff" },
					stat.additions > 0 ? h("span", { className: "dsh-bw-green" }, "+" + fmtNum(stat.additions)) : null,
					stat.additions > 0 && stat.deletions > 0 ? " " : null,
					stat.deletions > 0 ? h("span", { className: "dsh-bw-red" }, "−" + fmtNum(stat.deletions)) : null));
			}
			const sync = syncOf(snapshot);
			if ((sync.ahead || 0) > 0 || (sync.behind || 0) > 0) {
				badges.push(h("span", { key: "sy", className: "dsh-bw-badge dsh-bw-badge-diff" },
					(sync.ahead || 0) > 0 ? h("span", { title: "ahead" }, "↑" + sync.ahead) : null,
					(sync.ahead || 0) > 0 && (sync.behind || 0) > 0 ? " " : null,
					(sync.behind || 0) > 0 ? h("span", { title: "behind" }, "↓" + sync.behind) : null));
			}
			if (badges.length === 0) return null;
			return badges;
		}

		function fiberSessionId(element) {
			const key = Object.keys(element).find((k) => k.startsWith("__reactFiber$"));
			if (!key) return null;
			let fiber = element[key];
			let depth = 0;
			while (fiber && depth < 40) {
				const props = fiber.memoizedProps;
				if (props && props.node && typeof props.node === "object" && typeof props.node.id === "string") return props.node.id;
				fiber = fiber.return;
				depth += 1;
			}
			return null;
		}

		function createSidebarInjector(ctx) {
			const roots = new Map(); // container → react root
			let observer = null;
			let timer = null;
			let disposed = false;
			let anchorWarned = false;

			function sessionCwd(sessionId) {
				try {
					const snapshot = ctx.sessions.list.getSnapshot();
					const summary = snapshot.byId[sessionId];
					return summary && typeof summary.cwd === "string" && summary.cwd !== "" ? summary.cwd : null;
				} catch {
					return null;
				}
			}

			function schedule() {
				if (disposed || timer !== null) return;
				timer = setTimeout(() => {
					timer = null;
					pass();
				}, 300);
			}

			function pass() {
				if (disposed || typeof document === "undefined") return;
				// prune detached containers
				for (const [container, root] of [...roots.entries()]) {
					if (!container.isConnected) {
						try { root.unmount(); } catch { /* gone */ }
						roots.delete(container);
					}
				}
				let rows;
				try {
					rows = document.querySelectorAll('[class*="_sessionRow"]');
				} catch {
					return;
				}
				for (const row of rows) {
					// anchor self-check (ADR 0001): the shipped title span must exist
					if (!row.querySelector('[class*="_title"]')) {
						if (!anchorWarned) {
							anchorWarned = true;
							console.debug("[better-workspaces] session row anchor changed — badges degraded");
						}
						continue;
					}
					const sessionId = fiberSessionId(row);
					if (!sessionId) continue;
					const cwd = sessionCwd(sessionId);
					const rec = row.__dshBw;
					if (rec && rec.container.isConnected && rec.sessionId === sessionId && rec.cwd === cwd) continue;
					if (rec && rec.container.isConnected) {
						// identity or cwd changed → re-render in place when same session, rebuild otherwise
						if (rec.sessionId === sessionId) {
							rec.cwd = cwd;
							const root = roots.get(rec.container);
							if (root) root.render(h(Badges, { cwd }));
							continue;
						}
						try { roots.get(rec.container)?.unmount(); } catch { /* ignore */ }
						rec.container.remove();
						roots.delete(rec.container);
						row.__dshBw = undefined;
					}
					const container = document.createElement("div");
					container.className = "dsh-bw-badges";
					row.appendChild(container);
					const root = react_dom_client.createRoot(container);
					roots.set(container, root);
					row.__dshBw = { container, sessionId, cwd };
					root.render(h(Badges, { cwd }));
				}
			}

			return {
				start() {
					if (disposed) return;
					try {
						observer = new MutationObserver(schedule);
						observer.observe(document.body, { childList: true, subtree: true });
					} catch {
						observer = null;
					}
					let disposeSessions = () => {};
					try {
						disposeSessions = ctx.sessions.list.subscribe(schedule) || (() => {});
					} catch { /* no store */ }
					this._disposeSessions = disposeSessions;
					pass();
					// gentle keep-alive: React reorders rows without DOM add/remove at times
					this._interval = setInterval(() => { if (!disposed) pass(); }, 5000);
				},
				dispose() {
					disposed = true;
					if (timer !== null) clearTimeout(timer);
					try { observer && observer.disconnect(); } catch { /* ignore */ }
					try { this._disposeSessions && this._disposeSessions(); } catch { /* ignore */ }
					if (this._interval) clearInterval(this._interval);
					for (const [container, root] of roots.entries()) {
						try { root.unmount(); } catch { /* ignore */ }
						try { container.remove(); } catch { /* ignore */ }
					}
					roots.clear();
				},
			};
		}

		/* ================================================================ */
		/* hero worktree control                                             */
		/* ================================================================ */

		function HeroControl() {
			const sessions = appCtx.sessions;
			const listState = useSyncExternalStore(
				sessions.list.subscribe,
				() => sessions.list.getSnapshot(),
				() => sessions.list.getSnapshot(),
			);
			const currentId = listState.current;
			const summary = currentId ? listState.byId[currentId] : undefined;
			const cwd = summary && typeof summary.cwd === "string" && summary.cwd !== "" ? summary.cwd : null;
			const [detect, setDetect] = useState(null);
			const [staging, setStaging] = useState(false);
			const [branchPick, setBranchPick] = useState(null); // null → default
			const [newBranch, setNewBranch] = useState(false);
			const [newBranchName, setNewBranchName] = useState("");
			const [branches, setBranches] = useState(null);
			const [busy, setBusy] = useState(null);
			const [error, setError] = useState(null);

			useEffect(() => {
				let alive = true;
				setStaging(false);
				setBranchPick(null);
				setNewBranch(false);
				setNewBranchName("");
				setBranches(null);
				setError(null);
				if (!cwd) {
					setDetect(null);
					return () => { alive = false; };
				}
				setDetect(null);
				detectPath(cwd).then((value) => { if (alive) setDetect(value); });
				return () => { alive = false; };
			}, [cwd]);

			if (!cwd || !detect || !detect.isGit) return null;

			const isWorktree = Boolean(detect.isLinkedWorktree && detect.managed);
			const triggerLabel = isWorktree ? t("hero.wtTrigger", { branch: detect.branch || "" }) : t("hero.modeLocal");

			async function goLocal() {
				if (!isWorktree) return;
				setBusy(t("hero.switching"));
				setError(null);
				try {
					await openWorkspaceFor(detect.mainRepoRoot || detect.repoRoot);
				} catch (e) {
					setError(t("hero.failed", { message: String((e && e.message) || e) }));
				} finally {
					setBusy(null);
				}
			}

			async function openBranchList() {
				setStaging(true);
				setError(null);
				if (!branches) {
					try {
						const result = await apiGet("/branches" + qs({ cwd }));
						if (result.ok) setBranches(result);
						else setError(t("hero.failed", { message: result.error || "?" }));
					} catch (e) {
						setError(t("hero.failed", { message: String((e && e.message) || e) }));
					}
				}
			}

			async function createWorktree() {
				setBusy(t("hero.creating"));
				setError(null);
				try {
					const body = newBranch
						? { cwd, base: branchPick || (branches && branches.defaultBranch) || undefined, intent: "branch-off", branchName: newBranchName.trim() || undefined }
						: { cwd, base: branchPick || (branches && branches.defaultBranch) || undefined, intent: "checkout", branchName: branchPick || undefined };
					const result = await apiPost("/worktrees", body);
					if (!result.ok) throw new Error(result.message || "worktree create failed");
					setBusy(t("hero.switching"));
					await openWorkspaceFor(result.path);
					setStaging(false);
				} catch (e) {
					setError(t("hero.failed", { message: String((e && e.message) || e) }));
				} finally {
					setBusy(null);
				}
			}

			const branchItems = [];
			if (branches) {
				branchItems.push({ id: "__new__", label: t("hero.newBranchItem") });
				branchItems.push({ id: "__sep__", separator: true });
				for (const branch of (branches.branches || []).slice(0, 200)) {
					branchItems.push({
						id: branch.name,
						label: branch.name,
						hint: branch.current ? t("hero.current") : branch.name === branches.defaultBranch ? t("hero.default") : branch.hasRemote ? "origin" : null,
						active: (branchPick || branches.defaultBranch) === branch.name,
					});
				}
			}

			const effectiveBranch = branchPick || (branches && branches.defaultBranch) || "…";

			return h(react.Fragment, null,
				h(Popover, {
					align: "left",
					trigger: ({ open, toggle }) =>
						h("button", {
							type: "button", className: "dsh-bw-hero-btn", onClick: toggle, disabled: Boolean(busy),
							"aria-expanded": open, "aria-label": t("hero.modeLocal"),
						},
							h("span", { className: "dsh-bw-hero-label" }, busy || triggerLabel),
							h("span", { className: "dsh-bw-hero-chevron" }, "▾")),
					children: (close) =>
						h(MenuList, {
							items: [
								{ id: "local", label: t("hero.modeLocal"), active: !isWorktree, disabled: !isWorktree, reason: undefined },
								{ id: "new", label: t("hero.modeWorktree"), active: staging },
							],
							onSelect: (id) => {
								close();
								if (id === "local") goLocal();
								else openBranchList();
							},
						}),
				}),
				staging && h(Popover, {
					align: "left",
					trigger: ({ open, toggle }) =>
						h("button", { type: "button", className: "dsh-bw-hero-btn", onClick: toggle, disabled: Boolean(busy), "aria-expanded": open },
							h("span", { className: "dsh-bw-hero-label" }, t("hero.pickBranch", { branch: effectiveBranch })),
							h("span", { className: "dsh-bw-hero-chevron" }, "▾")),
					children: (close) =>
						branches === null
							? h("div", { className: "dsh-bw-hero-panel-row" }, t("diff.loading"))
							: newBranch
								? h("div", { className: "dsh-bw-hero-panel-row" },
									h("input", {
										className: "dsh-bw-hero-input", autoFocus: true, value: newBranchName,
										placeholder: t("hero.newBranchPlaceholder"),
										onChange: (e) => setNewBranchName(e.target.value),
										onKeyDown: (e) => { if (e.key === "Enter" && newBranchName.trim()) { close(); createWorktree(); } },
									}),
									h("span", { className: "dsh-bw-menu-hint" }, t("hero.baseHint", { branch: effectiveBranch })),
									h("button", {
										type: "button", className: "dsh-bw-btn dsh-bw-btn-primary", disabled: !newBranchName.trim() || Boolean(busy),
										onClick: () => { close(); createWorktree(); },
									}, t("hero.create")))
								: h(MenuList, {
									items: branchItems,
									onSelect: (id) => {
										if (id === "__new__") { setNewBranch(true); setBranchPick(null); return; }
										if (id === "__sep__") return;
										close();
										setBranchPick(id);
										setNewBranch(false);
										createWorktreeWith(id);
									},
								}),
				}),
				error ? h("span", { className: "dsh-bw-hero-error" }, error) : null);

			async function createWorktreeWith(branchName) {
				setBusy(t("hero.creating"));
				setError(null);
				try {
					const result = await apiPost("/worktrees", { cwd, base: branchName, intent: "checkout", branchName });
					if (!result.ok) throw new Error(result.message || "worktree create failed");
					setBusy(t("hero.switching"));
					await openWorkspaceFor(result.path);
					setStaging(false);
				} catch (e) {
					setError(t("hero.failed", { message: String((e && e.message) || e) }));
				} finally {
					setBusy(null);
				}
			}
		}

		function createHeroInjector() {
			let container = null;
			let root = null;
			let observer = null;
			let timer = null;
			let disposed = false;
			let anchorWarned = false;

			function teardown() {
				if (root) {
					try { root.unmount(); } catch { /* ignore */ }
					root = null;
				}
				if (container && container.isConnected) container.remove();
				container = null;
			}

			function pass() {
				if (disposed || typeof document === "undefined") return;
				let presetSlot = null;
				try {
					presetSlot = document.querySelector('[data-slot="conversation.hero.agentPreset"]');
				} catch { /* no dom */ }
				const parent = presetSlot && presetSlot.parentElement;
				const isHeroRow =
					parent && typeof parent.className === "string" && parent.className.indexOf("_heroWorkspaceRow") !== -1;
				if (!presetSlot || !parent || !isHeroRow) {
					// anchor self-check (ADR 0001): hero row absent or restructured → silent degradation
					if (presetSlot && parent && !isHeroRow && !anchorWarned) {
						anchorWarned = true;
						console.debug("[better-workspaces] hero row anchor changed — worktree control degraded");
					}
					teardown();
					return;
				}
				if (container && container.isConnected && container.parentElement === parent) return;
				teardown();
				container = document.createElement("div");
				container.className = "dsh-bw-hero";
				parent.insertBefore(container, presetSlot);
				root = react_dom_client.createRoot(container);
				root.render(h(HeroControl, null));
			}

			function schedule() {
				if (disposed || timer !== null) return;
				timer = setTimeout(() => {
					timer = null;
					pass();
				}, 300);
			}

			return {
				start() {
					try {
						observer = new MutationObserver(schedule);
						observer.observe(document.body, { childList: true, subtree: true });
					} catch {
						observer = null;
					}
					pass();
					this._interval = setInterval(() => { if (!disposed) pass(); }, 5000);
				},
				dispose() {
					disposed = true;
					if (timer !== null) clearTimeout(timer);
					try { observer && observer.disconnect(); } catch { /* ignore */ }
					if (this._interval) clearInterval(this._interval);
					teardown();
				},
			};
		}

		/* ================================================================ */
		/* dock pill                                                         */
		/* ================================================================ */

		function openDiffTab(sessionId) {
			try {
				const uiConversation = appCtx.get("uiConversation");
				if (uiConversation) {
					const binding = uiConversation.binding(sessionId);
					if (binding && binding.activate) {
						binding.activate("diff");
						return;
					}
				}
			} catch { /* fall through to DOM */ }
			try {
				const label = t("view.diff");
				const tabs = document.querySelectorAll('[class*="_tab"]');
				for (const tab of tabs) {
					if (tab.textContent && tab.textContent.trim() === label) {
						tab.click();
						return;
					}
				}
			} catch { /* give up quietly */ }
		}

		function GitDiffPill(props) {
			const sessionId = props.sessionId;
			const sessions = appCtx.sessions;
			const listState = useSyncExternalStore(
				sessions.list.subscribe,
				() => sessions.list.getSnapshot(),
				() => sessions.list.getSnapshot(),
			);
			const summary = sessionId ? listState.byId[sessionId] : undefined;
			const cwd = summary && typeof summary.cwd === "string" && summary.cwd !== "" ? summary.cwd : null;
			const snapshot = useStore(feed.store, (s) => (cwd ? s.byCwd[cwd] : undefined));
			useEffect(() => {
				if (!cwd) return undefined;
				feed.track(cwd);
				return () => feed.untrack(cwd);
			}, [cwd]);
			if (!cwd || !snapshot || !snapshot.isGit) return null;
			const stat = snapshot.diffStat;
			const hasDelta = Boolean(stat && (stat.additions > 0 || stat.deletions > 0));
			if (!snapshot.dirty && !hasDelta && !(snapshot.upstream && snapshot.upstream.ahead > 0)) return null;
			return h("button", {
				type: "button", className: "dsh-bw-pill", title: t("pill.title"),
				onClick: () => openDiffTab(sessionId),
			},
				h("span", { className: "dsh-bw-pill-icon" }, "±"),
				hasDelta
					? h("span", null,
						stat.additions > 0 ? h("span", { className: "dsh-bw-green" }, "+" + fmtNum(stat.additions)) : null,
						stat.additions > 0 && stat.deletions > 0 ? " " : null,
						stat.deletions > 0 ? h("span", { className: "dsh-bw-red" }, "−" + fmtNum(stat.deletions)) : null)
					: h("span", null, t("pill.dirty", { n: snapshot.changedFileCount || 0 })));
		}

		/* ================================================================ */
		/* diff view                                                         */
		/* ================================================================ */

		function useCwd(sessionId) {
			const sessions = appCtx.sessions;
			const get = useCallback(() => {
				try {
					const snapshot = sessions.list.getSnapshot();
					const summary = sessionId ? snapshot.byId[sessionId] : undefined;
					return summary && typeof summary.cwd === "string" && summary.cwd !== "" ? summary.cwd : null;
				} catch {
					return null;
				}
			}, [sessionId, sessions]);
			return useSyncExternalStore(sessions.list.subscribe, get, get);
		}

		function useRunning(sessionId) {
			const sessions = appCtx.sessions;
			const get = useCallback(() => {
				try {
					const snapshot = sessions.list.getSnapshot();
					const summary = sessionId ? snapshot.byId[sessionId] : undefined;
					return Boolean(summary && summary.running);
				} catch {
					return false;
				}
			}, [sessionId, sessions]);
			return useSyncExternalStore(sessions.list.subscribe, get, get);
		}

		function Hunk({ hunk, wrap }) {
			let oldNo = hunk.oldStart;
			let newNo = hunk.newStart;
			return h("div", { className: "dsh-bw-hunk" },
				h("div", { className: "dsh-bw-hunkhdr" }, "@@ -" + hunk.oldStart + "," + hunk.oldCount + " +" + hunk.newStart + "," + hunk.newCount + "@@" + (hunk.header ? " " + hunk.header : "")),
				hunk.lines.map((line, index) => {
					let oldCell = "";
					let newCell = "";
					if (line.type === "del" || line.type === "ctx") { oldCell = String(oldNo); oldNo += 1; }
					if (line.type === "add" || line.type === "ctx") { newCell = String(newNo); newNo += 1; }
					return h("div", {
						key: index,
						className: cx("dsh-bw-line", line.type === "add" && "dsh-bw-line-add", line.type === "del" && "dsh-bw-line-del", line.type === "meta" && "dsh-bw-line-meta", wrap && "dsh-bw-wrap"),
					},
						h("span", { className: "dsh-bw-ln" }, oldCell),
						h("span", { className: "dsh-bw-ln" }, newCell),
						h("span", { className: "dsh-bw-code" }, line.content));
				}));
		}

		function FileDiff({ file, wrap, anchorId }) {
			const [open, setOpen] = useState(true);
			return h("div", { className: "dsh-bw-file", id: anchorId },
				h("div", { className: "dsh-bw-filehead", onClick: () => setOpen((o) => !o) },
					h("span", { className: "dsh-bw-caret" }, open ? "▾" : "▸"),
					h(StatusLetter, { status: file.status }),
					h("span", { className: "dsh-bw-filepath", title: file.oldPath ? file.oldPath + " → " + file.path : file.path },
						file.oldPath ? file.oldPath + " → " + file.path : file.path),
					h("span", { className: "dsh-bw-filestat" },
						file.status === "binary" ? t("diff.binary")
							: file.status === "too_large" ? t("diff.tooLarge")
								: h(react.Fragment, null,
									h("span", { className: "dsh-bw-green" }, "+" + fmtNum(file.additions || 0)), " ",
									h("span", { className: "dsh-bw-red" }, "−" + fmtNum(file.deletions || 0))))),
				!open ? null
					: file.status === "binary" || file.status === "too_large"
						? h("div", { className: "dsh-bw-notice" }, file.status === "binary" ? t("diff.binaryBody") : t("diff.tooLargeBody"))
						: (file.hunks || []).map((hunk, index) => h(Hunk, { key: index, hunk, wrap })));
		}

		function DiffView(props) {
			const sessionId = props.sessionId;
			const cwd = useCwd(sessionId);
			const agentRunning = useRunning(sessionId);
			const snapshot = useStore(feed.store, (s) => (cwd ? s.byCwd[cwd] : undefined));
			useEffect(() => {
				if (!cwd) return undefined;
				feed.track(cwd);
				return () => feed.untrack(cwd);
			}, [cwd]);

			const [mode, setMode] = useState("uncommitted");
			const [pane, setPane] = useState("files");
			const [diff, setDiff] = useState(null);
			const [commits, setCommits] = useState(null);
			const [selectedCommit, setSelectedCommit] = useState(null);
			const [actions, setActions] = useState(null);
			const [selectedFile, setSelectedFile] = useState(null);
			const [running, setRunning] = useState(null);
			const [banner, setBanner] = useState(null);
			const [ignoreWs, setIgnoreWs] = useState(false);
			const [wrap, setWrap] = useState(false);
			const [commitMsg, setCommitMsg] = useState("");
			const [rev, setRev] = useState(0);
			const lastAutoRefetch = useRef(0);

			// auto refetch when the hub pushes a new snapshot revision (max 1 per 3s)
			const snapshotAt = snapshot ? snapshot.at : 0;
			useEffect(() => {
				if (!cwd) return;
				const now = Date.now();
				if (now - lastAutoRefetch.current < 3000) return;
				lastAutoRefetch.current = now;
				setRev((r) => r + 1);
			}, [snapshotAt, cwd]);

			const load = useCallback(async () => {
				if (!cwd) return;
				const commitSha = pane === "commits" && selectedCommit ? selectedCommit.sha : undefined;
				try {
					const [diffResult, actionsResult] = await Promise.all([
						apiGet("/diff" + qs({ cwd, mode, w: ignoreWs ? 1 : "", commit: commitSha })),
						apiGet("/actions" + qs({ cwd, running: agentRunning ? 1 : "" })),
					]);
					if (diffResult && diffResult.ok) setDiff(diffResult);
					if (actionsResult && actionsResult.ok) setActions(actionsResult);
					if (mode === "base" && pane === "commits" && !selectedCommit) {
						const commitsResult = await apiGet("/commits" + qs({ cwd }));
						if (commitsResult && commitsResult.ok) setCommits(commitsResult);
					}
				} catch { /* transient */ }
			}, [cwd, mode, pane, selectedCommit ? selectedCommit.sha : "", ignoreWs, agentRunning, rev]);

			useEffect(() => {
				setDiff(null);
				load();
			}, [load]);

			function localizeFailure(result) {
				if (result.reasonKey) {
					let text = t(result.reasonKey, result.params || {});
					if (result.conflictFiles && result.conflictFiles.length > 0) text += ": " + result.conflictFiles.join(", ");
					return text;
				}
				return result.message || t("actions.failed");
			}

			async function runAction(name, params, confirmText) {
				if (running) return;
				if (confirmText && !window.confirm(confirmText)) return;
				setRunning(name);
				setBanner(null);
				try {
					let result = await apiPost("/action", { cwd, name, params: params || {} });
					if (result && !result.ok && name === "archive" && result.reason === "unsafe") {
						const forced = window.confirm(t("actions.archive.unsafeConfirm", { message: result.message || "" }));
						if (forced) result = await apiPost("/action", { cwd, name, params: { ...(params || {}), force: true } });
					}
					if (result && result.ok) {
						setBanner({ kind: "ok", text: t("actions." + name + ".done") + (result.url ? " · " + result.url : "") });
						if (name === "commit") setCommitMsg("");
						if (name === "archive" && snapshot && snapshot.mainRepoRoot) {
							// leave the deleted worktree behind: hop to the main repo workspace
							openWorkspaceFor(snapshot.mainRepoRoot).catch(() => {});
						}
						lastAutoRefetch.current = Date.now();
						feed.refresh(cwd);
						setRev((r) => r + 1);
					} else {
						setBanner({ kind: "err", text: localizeFailure(result || {}) });
					}
				} catch (e) {
					setBanner({ kind: "err", text: String((e && e.message) || e) });
				} finally {
					setRunning(null);
				}
			}

			if (!cwd) return h("div", { className: "dsh-bw-view" }, h("div", { className: "dsh-bw-empty" }, t("diff.loading")));
			if (snapshot && snapshot.isGit === false) {
				return h("div", { className: "dsh-bw-view" }, h("div", { className: "dsh-bw-empty" }, t("diff.notGit")));
			}

			const ladder = (actions && actions.ladder) || [];
			const pr = snapshot ? snapshot.pr : null;
			const sync = snapshot ? syncOf(snapshot) : { ahead: 0, behind: 0 };
			const enabled = ladder.filter((entry) => !entry.disabled && entry.id !== "openPr");
			const primary = enabled.length > 0 ? enabled[0] : null;
			const rest = ladder.filter((entry) => entry !== primary && entry.id !== "openPr");

			function onPrimary() {
				if (!primary) return;
				if (primary.id === "commit") {
					if (!commitMsg.trim()) { setBanner({ kind: "err", text: t("actions.commit.noMessage") }); return; }
					runAction("commit", { message: commitMsg.trim(), addAll: true });
					return;
				}
				if (primary.id === "discard") { runAction("discard", {}, t("actions.discard.confirm")); return; }
				if (primary.id === "archive") { runAction("archive", { path: cwd }, t("actions.archive.confirm")); return; }
				runAction(primary.id, {});
			}

			function onMenuAction(id) {
				if (id === "commit") {
					if (!commitMsg.trim()) { setBanner({ kind: "err", text: t("actions.commit.noMessage") }); return; }
					runAction("commit", { message: commitMsg.trim(), addAll: true });
					return;
				}
				if (id === "discard") { runAction("discard", {}, t("actions.discard.confirm")); return; }
				if (id === "archive") { runAction("archive", { path: cwd }, t("actions.archive.confirm")); return; }
				runAction(id, {});
			}

			const toolbar = h("div", { className: "dsh-bw-toolbar" },
				h("div", { className: "dsh-bw-seg" },
					h("button", { type: "button", "aria-pressed": mode === "uncommitted", onClick: () => { setMode("uncommitted"); setSelectedCommit(null); } }, t("diff.modeUncommitted")),
					h("button", { type: "button", "aria-pressed": mode === "base", onClick: () => { setMode("base"); setSelectedCommit(null); } }, t("diff.modeBase"))),
				snapshot && snapshot.branch
					? h("span", { className: "dsh-bw-branch" }, "⎇", h("span", { className: "dsh-bw-branch-name", title: snapshot.branch }, snapshot.branch),
						snapshot.baseRefName && snapshot.baseRefName !== snapshot.branch ? h("span", { className: "dsh-bw-menu-hint" }, "← " + snapshot.baseRefName) : null)
					: null,
				snapshot && (sync.ahead > 0 || sync.behind > 0)
					? h("span", { className: "dsh-bw-sync" }, (sync.ahead > 0 ? "↑" + sync.ahead : "") + (sync.ahead > 0 && sync.behind > 0 ? " " : "") + (sync.behind > 0 ? "↓" + sync.behind : ""))
					: null,
				pr && pr.number
					? h("span", { className: "dsh-bw-pr" },
						h(PrNumBadge, { pr }),
						h("span", { className: "dsh-bw-pr-title", title: pr.title }, pr.title),
						pr.isDraft ? h("span", { className: "dsh-bw-menu-hint" }, t("diff.prDraft")) : null,
						pr.checks && pr.checks.status !== "none" ? h(ChecksRing, { checks: pr.checks }) : null,
						pr.mergeable === "CONFLICTING" ? h("span", { className: "dsh-bw-red" }, t("diff.prConflicting")) : null,
						pr.url ? h("a", { href: pr.url, target: "_blank", rel: "noreferrer" }, t("diff.openPr")) : null)
					: null,
				h("span", { className: "dsh-bw-toolbar-spacer" }),
				h("label", { className: "dsh-bw-check" },
					h("input", { type: "checkbox", checked: ignoreWs, onChange: (e) => setIgnoreWs(e.target.checked) }),
					t("diff.ignoreWs")),
				h("label", { className: "dsh-bw-check" },
					h("input", { type: "checkbox", checked: wrap, onChange: (e) => setWrap(e.target.checked) }),
					t("diff.wrap")),
				h("button", { type: "button", className: "dsh-bw-btn", onClick: () => { feed.refresh(cwd); setRev((r) => r + 1); }, disabled: Boolean(running) }, t("diff.refresh")),
				primary
					? h("button", {
						type: "button", className: cx("dsh-bw-btn", "dsh-bw-btn-primary", primary.id === "discard" && "dsh-bw-btn-danger"),
						onClick: onPrimary, disabled: Boolean(running),
					}, t("actions." + primary.id) + (primary.id === "push" && primary.params && primary.params.ahead ? " (" + primary.params.ahead + ")" : "") + (primary.id === "pull" && primary.params && primary.params.behind ? " (" + primary.params.behind + ")" : ""))
					: null,
				rest.length > 0
					? h(Popover, {
						align: "right",
						trigger: ({ toggle, open }) => h("button", { type: "button", className: "dsh-bw-btn", onClick: toggle, "aria-expanded": open }, t("actions.more"), " ▾"),
						children: (close) => h(MenuList, {
							items: rest.map((entry) => ({
								id: entry.id,
								label: t("actions." + entry.id),
								disabled: Boolean(entry.disabled) || Boolean(running),
								reason: entry.reasonKey ? t(entry.reasonKey, entry.params || {}) : Boolean(running) ? t("actions.disabled.agentRunning") : null,
								hint: entry.warn ? "!" : null,
							})),
							onSelect: (id) => { close(); onMenuAction(id); },
						}),
					})
					: null);

			const commitRow = mode === "uncommitted" && snapshot && snapshot.dirty
				? h("div", { className: "dsh-bw-commitrow" },
					h("input", {
						type: "text", className: "dsh-bw-commit-input", value: commitMsg, placeholder: t("diff.commitPlaceholder"),
						onChange: (e) => setCommitMsg(e.target.value),
						onKeyDown: (e) => {
							if (e.key === "Enter" && commitMsg.trim() && !running) {
								runAction("commit", { message: commitMsg.trim(), addAll: true });
							}
						},
						disabled: Boolean(running),
					}),
					h("button", {
						type: "button", className: "dsh-bw-btn dsh-bw-btn-primary", disabled: Boolean(running) || !commitMsg.trim(),
						onClick: () => runAction("commit", { message: commitMsg.trim(), addAll: true }),
					}, t("diff.commitAll")))
				: null;

			const bannerEl = banner
				? h("div", { className: cx("dsh-bw-banner", banner.kind === "ok" ? "dsh-bw-banner-ok" : "dsh-bw-banner-err") }, banner.text)
				: null;

			const files = (diff && diff.files) || [];
			const showCommitToggle = mode === "base";
			const fileList = h("div", { className: "dsh-bw-filelist" },
				showCommitToggle
					? h("div", { className: "dsh-bw-seg", style: { margin: "8px 10px" } },
						h("button", { type: "button", "aria-pressed": pane === "files", onClick: () => { setPane("files"); setSelectedCommit(null); } }, t("diff.paneFiles")),
						h("button", { type: "button", "aria-pressed": pane === "commits", onClick: () => setPane("commits") }, t("diff.paneCommits")))
					: null,
				pane === "files" || selectedCommit
					? files.length === 0
						? h("div", { className: "dsh-bw-empty" }, diff ? t("diff.empty") : t("diff.loading"))
						: files.map((file, index) =>
							h("div", {
								key: file.path,
								className: cx("dsh-bw-fileitem", selectedFile === file.path && "dsh-bw-fileitem-active"),
								onClick: () => {
									setSelectedFile(file.path);
									const anchor = document.getElementById("dsh-bw-f-" + index);
									if (anchor) anchor.scrollIntoView({ block: "start" });
								},
							},
								h(StatusLetter, { status: file.status }),
								h("span", { className: "dsh-bw-fileitem-path", title: file.path }, file.path),
								h("span", { className: "dsh-bw-fileitem-stat" },
									file.status === "binary" || file.status === "too_large"
										? ""
										: h(react.Fragment, null,
											h("span", { className: "dsh-bw-green" }, "+" + fmtNum(file.additions || 0)), " ",
											h("span", { className: "dsh-bw-red" }, "−" + fmtNum(file.deletions || 0))))))
					: h("div", { className: "dsh-bw-commits", style: { maxHeight: "none", flex: 1 } },
						!commits
							? h("div", { className: "dsh-bw-empty" }, t("diff.loading"))
							: commits.commits.length === 0
								? h("div", { className: "dsh-bw-empty" }, t("diff.commitListEmpty"))
								: commits.commits.map((commit) =>
									h("div", {
										key: commit.sha,
										className: cx("dsh-bw-commit", selectedCommit && selectedCommit.sha === commit.sha && "dsh-bw-commit-active"),
										onClick: () => setSelectedCommit(commit),
									},
										h("span", { className: "dsh-bw-sha" }, commit.short),
										h("span", { className: "dsh-bw-commit-subject", title: commit.subject }, commit.subject),
										commit.unpushed ? h("span", { className: "dsh-bw-unpushed-dot", title: t("diff.unpushed") }, "↑") : null,
										h("span", { className: "dsh-bw-commit-meta" }, fmtRelTime(commit.at, lang()))))));

			const diffPane = h("div", { className: "dsh-bw-diffpane" },
				selectedCommit
					? h("div", { className: "dsh-bw-toolbar" },
						h("button", { type: "button", className: "dsh-bw-btn", onClick: () => setSelectedCommit(null) }, t("diff.backToBranch")),
						h("span", { className: "dsh-bw-sha" }, selectedCommit.short),
						h("span", { className: "dsh-bw-commit-subject" }, selectedCommit.subject))
					: null,
				diff && diff.tooLarge ? h("div", { className: "dsh-bw-banner dsh-bw-banner-err" }, t("diff.truncated")) : null,
				files.length === 0
					? h("div", { className: "dsh-bw-empty" }, diff ? t("diff.empty") : t("diff.loading"))
					: files.map((file, index) => h(FileDiff, { key: (selectedCommit ? selectedCommit.sha : mode) + ":" + file.path, file, wrap, anchorId: "dsh-bw-f-" + index })));

			return h("div", { className: "dsh-bw-view" },
				toolbar,
				bannerEl,
				commitRow,
				h("div", { className: "dsh-bw-body" }, fileList, diffPane));
		}

		/* ================================================================ */
		/* files view                                                        */
		/* ================================================================ */

		function FilesView(props) {
			const cwd = useCwd(props.sessionId);
			const [trees, setTrees] = useState({});
			const [openDirs, setOpenDirs] = useState({ "": true });
			const [selected, setSelected] = useState(null);
			const [content, setContent] = useState(null);

			const loadDir = useCallback(async (path) => {
				if (!cwd) return;
				try {
					const result = await apiGet("/tree" + qs({ cwd, path }));
					if (result.ok) setTrees((prev) => ({ ...prev, [path]: result.entries }));
				} catch { /* transient */ }
			}, [cwd]);

			useEffect(() => {
				setTrees({});
				setOpenDirs({ "": true });
				setSelected(null);
				setContent(null);
				if (cwd) loadDir("");
			}, [cwd, loadDir]);

			async function toggleDir(path) {
				const next = { ...openDirs };
				if (next[path]) delete next[path];
				else {
					next[path] = true;
					if (!trees[path]) loadDir(path);
				}
				setOpenDirs(next);
			}

			async function openFile(path) {
				setSelected(path);
				setContent(null);
				try {
					const result = await apiGet("/file" + qs({ cwd, path }));
					setContent(result);
				} catch (e) {
					setContent({ ok: false, kind: "missing" });
				}
			}

			function renderLevel(path, depth) {
				const entries = trees[path];
				if (!entries) return [h("div", { key: path + ":loading", className: "dsh-bw-notice", style: { paddingLeft: 8 + depth * 14 } }, t("diff.loading"))];
				if (entries.length === 0) return [h("div", { key: path + ":empty", className: "dsh-bw-notice", style: { paddingLeft: 8 + depth * 14 } }, t("files.empty"))];
				const nodes = [];
				for (const entry of entries) {
					if (entry.type === "dir") {
						const isOpen = Boolean(openDirs[entry.path]);
						nodes.push(h("div", {
							key: entry.path, className: "dsh-bw-treeitem", style: { paddingLeft: 8 + depth * 14 },
							onClick: () => toggleDir(entry.path),
						},
							h("span", { className: "dsh-bw-treeicon" }, isOpen ? "▾" : "▸"),
							h("span", { className: "dsh-bw-treename" }, entry.name)));
						if (isOpen) nodes.push(...renderLevel(entry.path, depth + 1));
					} else {
						nodes.push(h("div", {
							key: entry.path,
							className: cx("dsh-bw-treeitem", selected === entry.path && "dsh-bw-treeitem-active"),
							style: { paddingLeft: 8 + depth * 14 + 20 },
							onClick: () => openFile(entry.path),
						},
							h("span", { className: "dsh-bw-treename" }, entry.name)));
					}
				}
				return nodes;
			}

			let viewer;
			if (!selected) viewer = h("div", { className: "dsh-bw-empty" }, t("files.pickHint"));
			else if (!content) viewer = h("div", { className: "dsh-bw-empty" }, t("diff.loading"));
			else if (content.kind === "text") {
				const MAX_LINES = 5000;
				const lines = content.content.split("\n");
				const truncated = lines.length > MAX_LINES;
				const shown = truncated ? lines.slice(0, MAX_LINES) : lines;
				viewer = h(react.Fragment, null,
					truncated ? h("div", { className: "dsh-bw-banner dsh-bw-banner-err" }, t("files.textTooLong", { n: MAX_LINES })) : null,
					h("div", { className: "dsh-bw-viewer-body" },
						h("pre", null, shown.map((line, index) =>
							h("div", { key: index, className: "dsh-bw-vline" },
								h("span", { className: "dsh-bw-ln" }, String(index + 1)),
								h("span", { className: "dsh-bw-code" }, line === "" ? " " : line))))));
			} else if (content.kind === "image") {
				viewer = h("div", { className: "dsh-bw-viewer-body" }, h("img", { className: "dsh-bw-img", src: content.url, alt: selected }));
			} else if (content.kind === "binary") {
				viewer = h("div", { className: "dsh-bw-empty" }, t("files.binary", { size: content.size }));
			} else if (content.kind === "too_large") {
				viewer = h("div", { className: "dsh-bw-empty" }, t("files.tooLarge", { size: content.size }));
			} else {
				viewer = h("div", { className: "dsh-bw-empty" }, t("files.missing"));
			}

			return h("div", { className: "dsh-bw-view" },
				h("div", { className: "dsh-bw-body" },
					h("div", { className: "dsh-bw-tree" }, cwd ? renderLevel("", 0) : h("div", { className: "dsh-bw-empty" }, t("diff.loading"))),
					h("div", { className: "dsh-bw-viewer" },
						selected ? h("div", { className: "dsh-bw-viewer-head" }, selected) : null,
						viewer)));
		}

		/* ================================================================ */
		/* apply                                                             */
		/* ================================================================ */

		const inject = ["slots", "locale", "sessions", "workspaces"];

		function apply(ctx) {
			appCtx = ctx;
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "better-workspaces: dictionaries");
			tt = ctx.locale.bind(NS);
			feed = createGitFeed();
			ctx.effect(() => () => feed.dispose(), "better-workspaces: feed");

			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "files",
				order: 20,
				locale: NS,
				label: () => tt("view.files"),
				inject: (sessionId) => ({ sessionId }),
			}, FilesView));

			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "diff",
				order: 30,
				locale: NS,
				label: () => tt("view.diff"),
				inject: (sessionId) => ({ sessionId }),
			}, DiffView));

			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "git-diff-pill",
				order: 100,
				locale: NS,
				inject: (sessionId) => ({ sessionId }),
			}, GitDiffPill));

			const sidebar = createSidebarInjector(ctx);
			const hero = createHeroInjector();
			ctx.effect(() => {
				sidebar.start();
				hero.start();
				return () => {
					sidebar.dispose();
					hero.dispose();
					try { document.documentElement.classList.remove("dsh-bw-root-vars"); } catch { /* ignore */ }
				};
			}, "better-workspaces: dom injection");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
