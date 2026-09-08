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
body { --dsh-bw-green: var(--dsw-alias-state-success-primary, #1a7f37); --dsh-bw-red: var(--dsw-alias-state-error-primary, #cf222e); --dsh-bw-yellow: var(--dsw-alias-state-warn-primary, #9a6700); --dsh-bw-purple: #7347af; --dsh-bw-border: var(--dsw-alias-border-l3, rgba(128,128,128,.25)); --dsh-bw-hover: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); --dsh-bw-tertiary: var(--dsw-alias-label-tertiary, #8b949e); --dsh-bw-secondary: var(--dsw-alias-label-secondary, #59636e); --dsh-bw-primary-label: var(--dsw-alias-label-primary, #1f2328); --dsh-bw-accent: var(--dsw-alias-state-business-primary, #2f6feb); --dsh-bw-bg: var(--dsw-alias-bg-base, #fff); --dsh-bw-code: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
body[data-ds-dark-theme] { --dsh-bw-purple: #c9a4f0; }
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
.dsh-bw-pop-panel { position: absolute; top: calc(100% + 4px); left: 0; z-index: 60; min-width: 180px; max-width: 340px; background: var(--dsw-alias-bg-overlay, var(--dsh-bw-bg)); border: 1px solid var(--dsh-bw-border); border-radius: 10px; box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.18)); padding: 4px; color: var(--dsh-bw-primary-label); font-size: 12px; }
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
.dsh-bw-fileicon { display: inline-flex; width: 16px; height: 16px; flex: none; align-items: center; justify-content: center; }
.dsh-bw-fileicon svg { width: 16px; height: 16px; }
.dsh-bw-editor { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
.dsh-bw-editor-bar { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--dsh-bw-border); flex: none; }
.dsh-bw-editor-path { font-size: 12px; color: var(--dsh-bw-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dsh-bw-editor-dirty { color: var(--dsh-bw-accent); font-size: 11px; flex: none; }
.dsh-bw-editor-area { flex: 1; min-height: 0; resize: none; border: none; outline: none; padding: 10px 12px; font-family: var(--dsh-bw-code); font-size: 12px; line-height: 1.55; color: var(--dsh-bw-primary-label); background: var(--dsh-bw-bg); tab-size: 4; white-space: pre; overflow: auto; }
.dsh-bw-fileedit { flex: none; margin-left: 8px; }
.dsh-bw-viewer-head { display: flex; gap: 8px; align-items: center; }
.dsh-bw-viewer-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-bw-wt] > svg { display: none; }
.dsh-bw-wt-icon { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; }
.dsh-bw-wt-icon svg { width: 15px; height: 15px; }
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

		/* ================================================================ */
		/* locale dictionaries                                               */
		/* ================================================================ */

		const zh = {
			"view.files": "文件",
			"view.diff": "diff",
			"hero.modeLocal": "本地",
			"hero.modeWorktree": "新建 worktree",
			"hero.pickBase": "基于:{branch}",
			"hero.pickExplicit": "新分支:{name}",
			"hero.stageHint": "选定基分支即创建并跳转，草稿随迁",
			"hero.stageCreateFallback": "立即创建",
			"hero.blockReason": "正在创建隔离 Worktree…",
			"hero.localSuffix": "（本地）",
			"files.edit": "编辑",
			"files.save": "保存",
			"files.saving": "保存中…",
			"files.cancelEdit": "取消",
			"files.conflict": "文件在磁盘上已被修改",
			"files.reload": "重新加载",
			"files.editUnavailable": "该文件不可编辑",
			"files.saveFailed": "保存失败",
			"diff.editFile": "编辑",
			"diff.modeSession": "本会话",
			"diff.modeTask": "任务",
			"diff.sessionEmpty": "该会话尚未通过写文件工具修改文件",
			"diff.sessionUnavailable": "无法读取该会话的历史记录",
			"diff.taskUnavailable": "任务 diff 不可用：元数据缺少基 ref（需重启 dsh 以启用宿主新路由）",
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
			"hero.pickBase": "Base: {branch}",
			"hero.pickExplicit": "New: {name}",
			"hero.stageHint": "picking a base creates and jumps, carrying your draft",
			"hero.stageCreateFallback": "Create now",
			"hero.blockReason": "Creating isolated Worktree…",
			"hero.localSuffix": " (local)",
			"files.edit": "Edit",
			"files.save": "Save",
			"files.saving": "Saving…",
			"files.cancelEdit": "Cancel",
			"files.conflict": "File changed on disk since load",
			"files.reload": "Reload",
			"files.editUnavailable": "This file cannot be edited",
			"files.saveFailed": "Save failed",
			"diff.editFile": "Edit",
			"diff.modeSession": "This session",
			"diff.modeTask": "Task",
			"diff.sessionEmpty": "This session has not written any files yet",
			"diff.sessionUnavailable": "This session's history cannot be paged",
			"diff.taskUnavailable": "Task diff unavailable: metadata lacks a base ref (restart dsh to enable the host route)",
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

		/* git-branch glyph, stroke style to match the shell's hero icons */
		/* raw SVG string for DOM injection into shell workspace rows (the React
		 * BranchIcon below is for our own renders; injected nodes need markup) */
		const WT_ICON_SVG = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="4.75" cy="3.6" r="1.85"></circle><circle cx="4.75" cy="12.4" r="1.85"></circle><circle cx="11.6" cy="5.15" r="1.85"></circle><path d="M4.75 5.45v5.1"></path><path d="M11.6 7c0 2.85-2.55 3.35-4.55 3.65"></path></svg>';

		function BranchIcon(props) {
			return h("svg", Object.assign({
				width: "1em", height: "1em", viewBox: "0 0 16 16", fill: "none",
				stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round",
				"aria-hidden": "true", focusable: "false",
				style: { flex: "none", display: "block" },
			}, props || {}),
				h("circle", { cx: 4.75, cy: 3.6, r: 1.85 }),
				h("circle", { cx: 4.75, cy: 12.4, r: 1.85 }),
				h("circle", { cx: 11.6, cy: 5.15, r: 1.85 }),
				h("path", { d: "M4.75 5.45v5.1" }),
				h("path", { d: "M11.6 7c0 2.85-2.55 3.35-4.55 3.65" }));
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
		/* per-session attribution: the session log is the only per-session signal
		 * in a shared workspace (git state is per-cwd). We page the official
		 * session log and collect paths written by file-writing tools */
		const WRITE_TOOL_NAMES = new Set(["edit", "write", "multiedit", "notebookedit", "str_replace_editor", "str_replace_based_edit_tool"]);
		function collectTouched(node, out, depth) {
			if (!node || depth > 8 || out.size > 500) return;
			if (Array.isArray(node)) {
				for (const item of node) collectTouched(item, out, depth + 1);
				return;
			}
			if (typeof node !== "object") return;
			const name = typeof node.name === "string" ? node.name : typeof node.toolName === "string" ? node.toolName : null;
			if (name && WRITE_TOOL_NAMES.has(name.toLowerCase()) && node.input && typeof node.input === "object") {
				for (const key of ["file_path", "path", "filePath"]) {
					const v = node.input[key];
					if (typeof v === "string" && v !== "") out.add(v);
				}
			}
			for (const key of Object.keys(node)) collectTouched(node[key], out, depth + 1);
		}
		function normalizeTouchedPaths(found, cwd) {
			const out = new Set();
			const root = cwd.endsWith("/") ? cwd : cwd + "/";
			for (const candidate of found) {
				if (candidate.startsWith(root)) out.add(candidate.slice(root.length));
				else if (!candidate.startsWith("/")) out.add(candidate.replace(/^\.\//, ""));
			}
			return out;
		}
		const touchedCache = new Map();
		async function sessionTouchedPaths(sessionId, cwd, force) {
			const cached = touchedCache.get(sessionId);
			if (!force && cached && Date.now() - cached.at < 20000) return cached.paths;
			let paths = null;
			try {
				const binding = appCtx.sessions.binding ? appCtx.sessions.binding(sessionId) : null;
				const session = binding && binding.session;
				if (session && typeof session.readPage === "function") {
					const found = new Set();
					let through;
					for (let pageIdx = 0; pageIdx < 4; pageIdx += 1) {
						const page = await session.readPage({ maxMessages: 300 }, through);
						const records = page && page.records;
						if (!records) break;
						collectTouched(records, found, 0);
						if (!page.hasMore || records.length === 0) break;
						const seqs = records
							.map((r) => (r && typeof r.seq === "number" ? r.seq : null))
							.filter((v) => v !== null);
						if (seqs.length === 0) break;
						through = Math.min.apply(null, seqs) - 1;
						if (through < 0) break;
					}
					paths = normalizeTouchedPaths(found, cwd);
				}
			} catch { paths = null; }
			touchedCache.set(sessionId, { at: Date.now(), paths });
			return paths;
		}

		/* sessions.create resolves a bare id string over the gateway but older
		 * builds wrapped it — one normalizer for every call site */
		function normalizeSessionId(raw) {
			if (typeof raw === "string") return raw;
			if (raw && raw.value) return raw.value.sessionId || raw.value.session || raw.value;
			return raw && raw.sessionId ? raw.sessionId : raw;
		}

		function currentSessionId() {
			try {
				const sessions = appCtx.sessions;
				const snap = sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : sessions.getSnapshot && sessions.getSnapshot();
				return snap ? snap.current : undefined;
			} catch {
				return undefined;
			}
		}

		/* rename with the -2 collision fallback; false when both attempts fail.
		 * The controller face is positional — rename(workspaceId, title) — and
		 * throws RemoteError-shaped failures instead of returning {ok:false} */
		function renameErrorCode(e) {
			if (!e) return null;
			return e.code || (e.error && e.error.code) || (e.details && e.details.code) || null;
		}
		async function renameWorkspaceTolerant(workspaceId, title) {
			try {
				await appCtx.workspaces.rename(workspaceId, title);
				return true;
			} catch (e) {
				if (renameErrorCode(e) !== "workspace/name-conflict") return false;
				try {
					await appCtx.workspaces.rename(workspaceId, title + "-2");
					return true;
				} catch {
					return false;
				}
			}
		}

		function workspaceItems() {
			const workspaces = appCtx.workspaces;
			if (!workspaces) return [];
			if (workspaces.list && workspaces.list.getSnapshot) {
				const snap = workspaces.list.getSnapshot();
				return (snap && snap.items) || [];
			}
			return workspaces.items || [];
		}

		/* workspaces.create resolves the Workspace object ITSELF (gateway
		 * contract, dsh-git-worktree pre-session controller parity) — the old
		 * {ok,value} assumption threw "workspace create failed" right after a
		 * successful create, leaving orphan workspace rows behind */
		async function openWorkspaceFor(path) {
			let workspace = workspaceItems().find((w) => w.path === path);
			if (!workspace) {
				workspace = await appCtx.workspaces.create({ path });
				if (!workspace || workspace.path !== path) {
					throw new Error(failureMessage(workspace) || "workspace create failed");
				}
			}
			const sessionId = normalizeSessionId(await appCtx.sessions.create({ workspaceId: workspace.workspaceId }));
			if (sessionId) appCtx.sessions.open(sessionId);
			return { sessionId, workspace };
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

			/* workspace-row identity (ADR 0001 DOM heuristic): rows are matched
			 * by title text — managed-worktree workspaces swap the folder icon
			 * for the branch icon so their provenance is visible at a glance */
			let managedTitles = null;
			async function refreshManagedTitles() {
				const titles = new Set();
				// source 1: live git snapshots — any tracked cwd that IS a managed
				// worktree marks its workspace row (works even on old hosts)
				try {
					const snap = feed.store.get();
					const byCwd = (snap && snap.byCwd) || {};
					for (const cwdKey of Object.keys(byCwd)) {
						const entry = byCwd[cwdKey];
						if (!entry || !entry.managed || !entry.isLinkedWorktree) continue;
						const ws = workspaceItems().find((w) => w.path === cwdKey);
						if (ws && typeof ws.title === "string" && ws.title !== "") titles.add(ws.title);
					}
				} catch { /* store not ready yet */ }
				// source 2: host registry route (covers worktrees without sessions)
				try {
					const res = await apiGet("/worktree-workspaces");
					if (res && res.ok && Array.isArray(res.items)) {
						const ids = new Set(res.items.map((i) => i && i.workspaceId).filter(Boolean));
						for (const w of workspaceItems()) {
							if (ids.has(w.workspaceId) && typeof w.title === "string" && w.title !== "") titles.add(w.title);
						}
					}
				} catch { /* older host without the route */ }
				managedTitles = titles;
			}

			function passWorkspaceIcons() {
				if (disposed || typeof document === "undefined" || managedTitles === null) return;
				let rows;
				try {
					rows = document.querySelectorAll('[class*="_projectRow"]');
				} catch {
					return;
				}
				for (const row of rows) {
					const titleEl = row.querySelector('[class*="_title"]');
					const folderEl = row.querySelector('[class*="_folder"]');
					if (!titleEl || !folderEl) continue;
					const isWt = managedTitles.has(titleEl.textContent || "");
					const marked = folderEl.getAttribute("data-bw-wt") === "1";
					if (isWt && !marked) {
						folderEl.setAttribute("data-bw-wt", "1");
						const icon = document.createElement("span");
						icon.className = "dsh-bw-wt-icon";
						icon.innerHTML = WT_ICON_SVG;
						folderEl.appendChild(icon);
					} else if (!isWt && marked) {
						folderEl.removeAttribute("data-bw-wt");
						const prev = folderEl.querySelector(".dsh-bw-wt-icon");
						if (prev) prev.remove();
					}
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
				passWorkspaceIcons();
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
					let disposeWorkspaces = () => {};
					try {
						if (ctx.workspaces && ctx.workspaces.list && ctx.workspaces.list.subscribe) {
							disposeWorkspaces = ctx.workspaces.list.subscribe(() => {
								refreshManagedTitles().then(schedule);
							}) || (() => {});
						}
					} catch { /* no store */ }
					this._disposeWorkspaces = disposeWorkspaces;
					refreshManagedTitles().then(() => { if (!disposed) passWorkspaceIcons(); });
					pass();
					// gentle keep-alive: React reorders rows without DOM add/remove at times
					this._interval = setInterval(() => { if (!disposed) pass(); }, 5000);
				},
				dispose() {
					disposed = true;
					if (timer !== null) clearTimeout(timer);
					try { observer && observer.disconnect(); } catch { /* ignore */ }
					try { this._disposeSessions && this._disposeSessions(); } catch { /* ignore */ }
					try { this._disposeWorkspaces && this._disposeWorkspaces(); } catch { /* ignore */ }
					if (this._interval) clearInterval(this._interval);
					try {
						for (const el of document.querySelectorAll('[data-bw-wt]')) {
							el.removeAttribute("data-bw-wt");
							const icon = el.querySelector(".dsh-bw-wt-icon");
							if (icon) icon.remove();
						}
					} catch { /* no dom */ }
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

		/* paseo-style mnemonic placeholder slug (createNameId equivalent):
		 * adj-noun-hhhh — always a valid branch slug (lowercase, single hyphens). */
		const MNEMONIC_ADJ = ["amber", "brave", "calm", "clever", "coral", "cosmic", "crimson", "curious", "daring", "dusty", "eager", "electric", "emerald", "fading", "fierce", "floating", "gentle", "gilded", "golden", "hidden", "hollow", "humble", "icy", "indigo", "iron", "ivory", "jagged", "jolly", "keen", "lively", "lunar", "mellow", "misty", "molten", "muted", "nifty", "nimble", "noble", "pale", "patient", "polar", "proud", "quiet", "radiant", "rapid", "rustic", "sage", "scarlet", "serene", "shadow", "shifting", "silent", "silver", "solar", "solid", "somber", "swift", "tender", "tranquil", "umber", "vast", "velvet", "vivid", "wandering", "warm", "wild", "winter", "witty", "zealous"];
		const MNEMONIC_NOUN = ["anchor", "arrow", "aurora", "badger", "basalt", "beacon", "birch", "blossom", "brook", "canyon", "cedar", "cinder", "cipher", "cliff", "comet", "copper", "creek", "crest", "crystal", "current", "dawn", "delta", "dune", "ember", "estuary", "falcon", "fen", "fjord", "flint", "forest", "forge", "fossil", "gale", "galaxy", "garden", "geode", "glacier", "glade", "granite", "grove", "harbor", "heron", "horizon", "island", "ivy", "lagoon", "lantern", "larch", "lava", "leaf", "lynx", "marsh", "meadow", "meteor", "monsoon", "moss", "nebula", "oak", "oasis", "opal", "orbit", "otter", "peak", "pebble", "pine", "prairie", "quartz", "quill", "raven", "reef", "ridge", "river", "rose", "sable", "sequoia", "shoal", "sparrow", "spring", "steppe", "stone", "summit", "talon", "thicket", "tide", "timber", "tundra", "vale", "vine", "walrus", "willow", "wolf", "wren", "yarrow"];
		function mnemonicSlug() {
			const adj = MNEMONIC_ADJ[Math.floor(Math.random() * MNEMONIC_ADJ.length)];
			const noun = MNEMONIC_NOUN[Math.floor(Math.random() * MNEMONIC_NOUN.length)];
			const hex = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
			return adj + "-" + noun + "-" + hex;
		}

		/* pure helpers (unit-tested via __bwTest) */

		/** Last path segment, tolerant of trailing slashes. */
		function basenameOf(p) {
			const s = String(p || "").replace(/\/+$/, "");
			const i = s.lastIndexOf("/");
			return i >= 0 ? s.slice(i + 1) : s;
		}

		/** Exact failure text from any {message}|{error:string}|{error:{message}} shape. */
		function failureMessage(result) {
			if (!result) return null;
			if (typeof result.message === "string" && result.message) return result.message;
			const err = result.error;
			if (typeof err === "string" && err) return err;
			if (err && typeof err.message === "string" && err.message) return err.message;
			return null;
		}

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
			const [explicitName, setExplicitName] = useState(null); // user-named branch (staging)
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

			/* worktree-session workspace title follows the session title once the
			 * host (or user) names it — keeps sidebar rows meaningful.
			 * EVERY hook must run before the non-git early return below —
			 * hooks after a conditional return crash the component with a
			 * hook-count mismatch (the hero dropdown vanished that way once) */
			const titleSynced = react.useRef(false);
			const summaryTitle = summary && typeof summary.title === "string" ? summary.title : null;
			react.useEffect(() => {
				if (titleSynced.current) return;
				if (!cwd || !detect || !detect.isLinkedWorktree || !detect.managed) return;
				const prefix = detect.sourceWorkspaceTitle || basenameOf(detect.mainRepoRoot || detect.repoRoot || cwd);
				// self-heal rows created before provenance titles existed: a bare
				// basename title on a managed worktree gets its prefix back
				const ws0 = workspaceItems().find((w) => w.path === cwd);
				const healed = !summaryTitle && ws0 && prefix && detect.branch && ws0.title === basenameOf(cwd)
					? prefix + " · " + detect.branch
					: null;
				if (!summaryTitle && !healed) return;
				titleSynced.current = true;
				(async () => {
					try {
						const ws = workspaceItems().find((w) => w.path === cwd);
						if (!ws) return;
						const title = summaryTitle ? (prefix ? prefix + " · " + summaryTitle : summaryTitle) : healed;
						if (!title || ws.title === title) return;
						const renamed = await renameWorkspaceTolerant(ws.workspaceId, title);
						if (!renamed) titleSynced.current = false; // retry on next title change
					} catch {
						titleSynced.current = false;
					}
				})();
			}, [cwd, detect, summaryTitle]);

			// worktree workspaces get no hero control: they ARE the pinned
			// result — staging another worktree from inside one is not a flow
			// we offer (the sidebar row keeps its badges; hero hides entirely)
			if (!cwd || !detect || !detect.isGit || detect.isLinkedWorktree) return null;

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

			/* reference-aligned handoff (dsh-git-worktree pre-session controller,
			 * official APIs only): worktree → workspace → target session → draft
			 * migration → open → retire the source launcher; full rollback on any
			 * failure so a broken attempt leaves no orphan rows */
			async function prepareStagedWorktree(baseBranch, explicit) {
				const conversation = appCtx.get("uiConversation");
				const sourceId = currentSessionId();
				setBusy(t("hero.creating"));
				setError(null);
				let createdPath = null;
				let workspaceId = null;
				let targetId = null;
				if (conversation && conversation.blocks && sourceId) {
					try { conversation.blocks.set(sourceId, { reason: t("hero.blockReason") }); } catch { /* cosmetic */ }
				}
				// sidebar provenance: the workspace this session was launched from
				const items0 = workspaceItems();
				const srcWs =
					(sourceId && items0.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.indexOf(sourceId) !== -1)) ||
					items0.find((w) => w.path === cwd) ||
					null;
				const sourceTitle =
					(srcWs && typeof srcWs.title === "string" && srcWs.title.trim()) ||
					basenameOf(detect.mainRepoRoot || detect.repoRoot || cwd) ||
					"";
				try {
					const body = { cwd, intent: "branch-off", slug: mnemonicSlug(), sourceTitle };
					const named = explicit || explicitName;
					if (named) body.branchName = named;
					else body.base = baseBranch || branchPick || defaultBaseRef() || undefined;
					const result = await apiPost("/worktrees", body);
					if (!result.ok) throw new Error(failureMessage(result) || "worktree create failed");
					createdPath = result.path;
					setBusy(t("hero.switching"));
					const workspace = await appCtx.workspaces.create({ path: result.path });
					if (!workspace || workspace.path !== result.path) throw new Error(failureMessage(workspace) || "workspace create failed");
					workspaceId = workspace.workspaceId;
					targetId = normalizeSessionId(await appCtx.sessions.create({ workspaceId }));
					if (!targetId) throw new Error("session create failed");
					// carry the typed draft into the target composer (official input API)
					let draft = "";
					try {
						draft = (JSON.parse(localStorage.getItem("dsh.conversation." + sourceId) || "null") || {}).draft || "";
					} catch { draft = ""; }
					if (conversation && conversation.input && draft) {
						try {
							const targetBinding = appCtx.sessions.binding(targetId);
							const targetInput = targetBinding ? conversation.input.for(targetBinding.ctx || targetBinding) : null;
							if (targetInput && targetInput.actions) targetInput.actions.setDraft(draft);
						} catch { /* draft stays in source; user re-types */ }
					}
					appCtx.sessions.open(targetId);
					try {
						const srcBinding = appCtx.sessions.binding(sourceId);
						const srcInput = srcBinding && conversation && conversation.input ? conversation.input.for(srcBinding.ctx || srcBinding) : null;
						if (srcInput && srcInput.actions) srcInput.actions.setDraft("");
					} catch { /* cosmetic */ }
					// retire the blank launcher so Harness cannot route later tasks into it
					try { await appCtx.workspaces.archiveSession(sourceId); } catch { /* cosmetic */ }
					await renameWorkspaceTolerant(workspaceId, (sourceTitle ? sourceTitle + " · " : "") + (result.branch || ""));
					setStaging(false);
					setExplicitName(null);
					setBranchPick(null);
				} catch (e) {
					if (targetId) { try { await appCtx.workspaces.archiveSession(targetId); } catch { /* best effort */ } }
					if (workspaceId) { try { await appCtx.workspaces.delete(workspaceId); } catch { /* best effort */ } }
					if (createdPath) { try { await apiPost("/worktrees/archive", { path: createdPath, force: true }); } catch { /* best effort */ } }
					setError(t("hero.failed", { message: String((e && e.message) || e) }));
				} finally {
					if (conversation && conversation.blocks && sourceId) {
						try { conversation.blocks.set(sourceId, null); } catch { /* cosmetic */ }
					}
					setBusy(null);
				}
			}

			function refDisplay(ref) {
				if (typeof ref !== "string") return "";
				if (ref.indexOf("refs/heads/") === 0) return ref.slice("refs/heads/".length);
				if (ref.indexOf("refs/remotes/origin/") === 0) return ref.slice("refs/remotes/origin/".length);
				return ref;
			}

			function defaultBaseRef() {
				if (!branches || !branches.defaultBranch) return null;
				const entry = (branches.branches || []).find((b) => b.name === branches.defaultBranch);
				if (entry && entry.hasRemote) return "refs/remotes/origin/" + entry.name;
				if (entry && entry.hasLocal) return "refs/heads/" + entry.name;
				return branches.defaultBranch;
			}

			function confirmExplicitName(close) {
				const name = newBranchName.trim();
				if (!name) return;
				setExplicitName(name);
				setNewBranch(false);
				setBranchPick(null);
				if (close) close();
				prepareStagedWorktree(null, name);
			}

			/* paseo picker parity (new-workspace-picker-item.ts): the origin row
			 * comes first because it IS the default base — cutting from
			 * refs/remotes/origin/<name> starts at the true remote head even
			 * when the local branch lags; the local row shows as
			 * "<name>（本地）" with +N −M divergence when both sides exist */
			const defRef = defaultBaseRef();
			const picked = branchPick || defRef;
			const branchItems = [];
			if (branches) {
				branchItems.push({ id: "__new__", label: t("hero.newBranchItem") });
				branchItems.push({ id: "__sep__", separator: true });
				for (const branch of (branches.branches || []).slice(0, 200)) {
					if (branch.hasRemote) {
						const ref = "refs/remotes/origin/" + branch.name;
						branchItems.push({
							id: ref,
							label: branch.name,
							hint: ref === defRef ? t("hero.default") : null,
							active: picked === ref,
						});
					}
					if (branch.hasLocal) {
						const ref = "refs/heads/" + branch.name;
						const parts = [];
						if (branch.localAhead > 0) parts.push("+" + branch.localAhead);
						if (branch.localBehind > 0) parts.push("\u2212" + branch.localBehind);
						branchItems.push({
							id: ref,
							label: branch.hasRemote ? branch.name + t("hero.localSuffix") : branch.name,
							hint: branch.current ? t("hero.current") : parts.length ? parts.join(" ") : null,
							active: picked === ref,
						});
					}
				}
			}

			const effectiveBranch = refDisplay(picked) || "…";

			return h(react.Fragment, null,
				h(Popover, {
					align: "left",
					trigger: ({ open, toggle }) =>
						h("button", {
							type: "button", className: "dsh-bw-hero-btn", onClick: toggle, disabled: Boolean(busy),
							"aria-expanded": open, "aria-label": t("hero.modeLocal"),
						},
							h(BranchIcon),
							h("span", { className: "dsh-bw-hero-label" }, busy || t("hero.modeLocal")),
							h("span", { className: "dsh-bw-hero-chevron" }, "▾")),
					children: (close) =>
						h(MenuList, {
							items: [{ id: "new", label: t("hero.modeWorktree"), active: staging }],
							onSelect: () => {
								close();
								openBranchList();
							},
						}),
				}),
				staging && h(Popover, {
					align: "left",
					trigger: ({ open, toggle }) =>
						h("button", { type: "button", className: "dsh-bw-hero-btn", onClick: toggle, disabled: Boolean(busy), "aria-expanded": open },
							h(BranchIcon),
							h("span", { className: "dsh-bw-hero-label" },
								explicitName
									? t("hero.pickExplicit", { name: explicitName })
									: t("hero.pickBase", { branch: effectiveBranch })),
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
										onKeyDown: (e) => { if (e.key === "Enter" && newBranchName.trim()) confirmExplicitName(close); },
									}),
									h("span", { className: "dsh-bw-menu-hint" }, t("hero.baseHint", { branch: effectiveBranch })),
									h("button", {
										type: "button", className: "dsh-bw-btn dsh-bw-btn-primary", disabled: !newBranchName.trim() || Boolean(busy),
										onClick: () => confirmExplicitName(close),
									}, t("hero.create")))
								: h(MenuList, {
									items: branchItems,
									onSelect: (id) => {
										if (id === "__new__") { setNewBranch(true); setBranchPick(null); setExplicitName(null); return; }
										if (id === "__sep__") return;
										close();
										setBranchPick(id);
										setExplicitName(null);
										setNewBranch(false);
										prepareStagedWorktree(id);
									},
								}),
				}),
				staging ? h("span", { className: "dsh-bw-menu-hint" }, t("hero.stageHint")) : null,
				staging ? h("button", {
					type: "button", className: "dsh-bw-btn", disabled: Boolean(busy),
					onClick: () => prepareStagedWorktree(null),
				}, t("hero.stageCreateFallback")) : null,
				error ? h("span", { className: "dsh-bw-hero-error" }, error) : null);
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

		/* ================================================================ */
		/* file icons (vendored from paseo material-file-icons, MIT)          */
		/* ================================================================ */

		// Vendor icon table, transcribed from material-icon-theme. The SVGs are copied verbatim,
		// including their colours — see file-icon-svg.ts for the module that tones them down for our
		// surfaces. Keeping this file a faithful copy is what makes re-copying an icon a mechanical edit.
		//
		// See docs/file-icons.md for how to add one.

		const SVG_ICONS = {
		  _default: `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="m8.668 6h3.6641l-3.6641-3.668v3.668m-4.668-4.668h5.332l4 4v8c0 0.73828-0.59375 1.3359-1.332 1.3359h-8c-0.73828 0-1.332-0.59766-1.332-1.3359v-10.664c0-0.74219 0.59375-1.3359 1.332-1.3359m3.332 1.3359h-3.332v10.664h8v-6h-4.668z" fill="#90a4ae" /></svg>`,
		  astro: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#7c4dff" d="M12.106 25.849c-1.262-1.156-1.63-3.586-1.105-5.346a5.18 5.18 0 0 0 3.484 1.66 9.68 9.68 0 0 0 5.882-.734c.215-.106.413-.247.648-.39a3.5 3.5 0 0 1 .16 1.555 4.26 4.26 0 0 1-1.798 3.021c-.404.3-.832.569-1.25.852a2.613 2.613 0 0 0-1.15 3.372l.048.161a3.4 3.4 0 0 1-1.5-1.285 3.6 3.6 0 0 1-.578-1.962 9 9 0 0 0-.05-1.037c-.114-.831-.504-1.204-1.238-1.225a1.45 1.45 0 0 0-1.507 1.18c-.012.056-.028.112-.046.178M4.901 20a17.75 17.75 0 0 1 7.4-2l2.913-8.38a.765.765 0 0 1 1.527 0L19.7 18a14.24 14.24 0 0 1 7.399 2S20.704 2.877 20.692 2.842C20.51 2.33 20.202 2 19.787 2h-7.619c-.415 0-.71.33-.904.842z"/></svg>`,
		  c: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#0288d1" d="M19.563 22A5.57 5.57 0 0 1 14 16.437v-2.873A5.57 5.57 0 0 1 19.563 8H24V2h-4.437A11.563 11.563 0 0 0 8 13.563v2.873A11.564 11.564 0 0 0 19.563 28H24v-6Z"/></svg>`,
		  clojure: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path fill="#64dd17" d="M123.456 129.975a507 507 0 0 0-3.54 7.846c-4.406 9.981-9.284 22.127-11.066 29.908-.64 2.77-1.037 6.205-1.03 10.013 0 1.506.081 3.09.21 4.702a58.1 58.1 0 0 0 19.98 3.559 58.2 58.2 0 0 0 18.29-2.98c-1.352-1.237-2.642-2.554-3.816-4.038-7.796-9.942-12.146-24.512-19.028-49.01m-28.784-49.39C79.782 91.08 70.039 108.387 70.002 128c.037 19.32 9.487 36.403 24.002 46.94 3.56-14.83 12.485-28.41 25.868-55.63a219 219 0 0 0-2.714-7.083c-3.708-9.3-9.059-20.102-13.834-24.993-2.435-2.555-5.389-4.763-8.652-6.648"/><path fill="#7cb342" d="M178.532 194.535c-7.683-.963-14.023-2.124-19.57-4.081a69.4 69.4 0 0 1-30.958 7.249c-38.491 0-69.693-31.198-69.698-69.7 0-20.891 9.203-39.62 23.764-52.392-3.895-.94-7.956-1.49-12.104-1.482-20.45.193-42.037 11.51-51.025 42.075-.84 4.45-.64 7.813-.64 11.8 0 60.591 49.12 109.715 109.705 109.715 37.104 0 69.882-18.437 89.732-46.633-10.736 2.675-21.06 3.955-29.902 3.982-3.314 0-6.425-.177-9.305-.53"/><path fill="#29b6f6" d="M157.922 173.271c.678.336 2.213.884 4.35 1.49 14.375-10.553 23.717-27.552 23.754-46.764h-.005c-.055-32.03-25.974-57.945-58.011-58.009a58.2 58.2 0 0 0-18.213 2.961c11.779 13.426 17.443 32.613 22.922 53.6l.01.025c.01.017 1.752 5.828 4.743 13.538 2.97 7.7 7.203 17.231 11.818 24.178 3.03 4.655 6.363 8 8.632 8.981"/><path fill="#1e88e5" d="M128.009 18.29c-36.746 0-69.25 18.089-89.16 45.826 10.361-6.49 20.941-8.83 30.174-8.747 12.753.037 22.779 3.991 27.589 6.696a51 51 0 0 1 3.345 2.131 69.4 69.4 0 0 1 28.049-5.894c38.496.004 69.703 31.202 69.709 69.698h-.006c0 19.409-7.938 36.957-20.736 49.594 3.142.352 6.492.571 9.912.554 12.15.006 25.284-2.675 35.13-10.956 6.42-5.408 11.798-13.327 14.78-25.199.584-4.586.92-9.247.92-13.991 0-60.588-49.116-109.715-109.705-109.715"/></svg>`,
		  console: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#ff7043" d="M2 2a1 1 0 0 0-1 1v10c0 .554.446 1 1 1h12c.554 0 1-.446 1-1V3a1 1 0 0 0-1-1zm0 3h12v8H2zm1 2 2 2-2 2 1 1 3-3-3-3zm5 3.5V12h5v-1.5z"/></svg>`,
		  cpp: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#0288d1" d="M28 14v-4h-2v4h-6v-4h-2v4h-4v2h4v4h2v-4h6v4h2v-4h4v-2z"/><path fill="#0288d1" d="M13.563 22A5.57 5.57 0 0 1 8 16.437v-2.873A5.57 5.57 0 0 1 13.563 8H18V2h-4.437A11.563 11.563 0 0 0 2 13.563v2.873A11.564 11.564 0 0 0 13.563 28H18v-6Z"/></svg>`,
		  csharp: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#0288d1" d="M30 14v-2h-2V8h-2v4h-2V8h-2v4h-2v2h2v2h-2v2h2v4h2v-4h2v4h2v-4h2v-2h-2v-2Zm-4 2h-2v-2h2Zm-12.437 6A5.57 5.57 0 0 1 8 16.437v-2.873A5.57 5.57 0 0 1 13.563 8H18V2h-4.437A11.563 11.563 0 0 0 2 13.563v2.873A11.564 11.564 0 0 0 13.563 28H18v-6Z"/></svg>`,
		  css: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#7e57c2" d="M20 18h-2v-2h-2v2c0 .193 0 .703 1.254 1.033A3.345 3.345 0 0 1 20 22h2v2h2v-2c0-.388-.562-.851-1.254-1.034C20.356 20.34 20 18.84 20 18m-3.254 2.966C14.356 20.34 14 18.84 14 18h-2v-2h-2v8h2v-2h4v2h2v-2c0-.388-.562-.851-1.254-1.034"/><path fill="#7e57c2" d="M24 4H4v20a4 4 0 0 0 4 4h16.16A3.84 3.84 0 0 0 28 24.16V8a4 4 0 0 0-4-4m2 14h-2v-2h-2v2c0 .193 0 .703 1.254 1.033A3.345 3.345 0 0 1 26 22v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2 2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2 2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1 2-2h2a2 2 0 0 1 2 2Z"/></svg>`,
		  dart: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#4fc3f7" d="M16.83 2a1.3 1.3 0 0 0-.916.377l-.013.01L7.323 7.34l8.556 8.55v.005l10.283 10.277 1.96-3.529-7.068-16.96-3.299-3.297A1.3 1.3 0 0 0 16.828 2Z"/><path fill="#01579b" d="m7.343 7.32-4.955 8.565-.01.013a1.297 1.297 0 0 0 .004 1.835l.005.005 4.106 4.107 16.064 6.314 3.632-2.015-.098-.098-.025.002L15.995 15.97h-.012z"/><path fill="#01579b" d="m7.321 7.324 8.753 8.755h.013L26.16 26.156l3.835-.73L30 14.089l-4.049-3.965a6.5 6.5 0 0 0-3.618-1.612l.002-.043L7.323 7.325Z"/><path fill="#64b5f6" d="m7.332 7.335 8.758 8.75v.013l10.079 10.071L25.436 30H14.09l-3.967-4.048a6.5 6.5 0 0 1-1.611-3.618l-.045.004Z"/></svg>`,
		  database: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#ffca28" d="M16 24c-5.525 0-10-.9-10-2v4c0 1.1 4.475 2 10 2s10-.9 10-2v-4c0 1.1-4.475 2-10 2m0-8c-5.525 0-10-.9-10-2v4c0 1.1 4.475 2 10 2s10-.9 10-2v-4c0 1.1-4.475 2-10 2m0-12C10.477 4 6 4.895 6 6v4c0 1.1 4.475 2 10 2s10-.9 10-2V6c0-1.105-4.477-2-10-2"/></svg>`,
		  document: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/><path fill="#42a5f5" d="M8 16h8v2H8zm0-4h8v2H8zm6-10H6c-1.1 0-2 .9-2 2v16c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8zm4 18H6V4h7v5h5z"/></svg>`,
		  elixir: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#9575cd" d="M12.173 22.681c-3.86 0-6.99-3.64-6.99-8.13 0-3.678 2.773-8.172 4.916-10.91 1.014-1.296 2.93-2.322 2.93-2.322s-.982 5.239 1.683 7.319c2.366 1.847 4.106 4.25 4.106 6.363 0 4.232-2.784 7.68-6.645 7.68"/></svg>`,
		  erlang: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30"><path fill="#f44336" d="M5.207 4.33q-.072.075-.143.153Q1.5 8.476 1.5 15.33c0 4.418 1.155 7.862 3.459 10.34h19.415c2.553-1.152 4.127-3.43 4.127-3.43l-3.147-2.52L23.9 21.1c-.867.773-.845.931-2.315 1.78-1.495.674-3.04.966-4.634.966-2.515 0-4.423-.909-5.723-2.059-1.286-1.15-1.985-4.511-2.096-6.68l17.458.067-.183-1.472s-.847-7.129-2.541-9.372zm8.76.846c1.565 0 3.22.535 3.961 1.471.74.937.931 1.667.973 3.524H9.11c.112-1.955.436-2.81 1.373-3.698.936-.887 2.03-1.297 3.484-1.297"/></svg>`,
		  go: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#00acc1" d="M2 12h4v2H2zm-2 4h6v2H0zm4 4h2v2H4zm16.954-5H14v3h3.239a4.42 4.42 0 0 1-3.531 2 2.65 2.65 0 0 1-2.053-.858 2.86 2.86 0 0 1-.628-2.28A4.515 4.515 0 0 1 15.292 13a2.73 2.73 0 0 1 1.749.584l2.962-1.185A5.6 5.6 0 0 0 15.292 10a7.526 7.526 0 0 0-7.243 6.5 5.614 5.614 0 0 0 5.659 6.5 7.526 7.526 0 0 0 7.243-6.5 6.4 6.4 0 0 0 .003-1.5"/><path fill="#00acc1" d="M26.292 10a7.526 7.526 0 0 0-7.243 6.5 5.614 5.614 0 0 0 5.659 6.5 7.526 7.526 0 0 0 7.243-6.5 5.614 5.614 0 0 0-5.659-6.5m2.681 6.137A4.515 4.515 0 0 1 24.708 20a2.65 2.65 0 0 1-2.053-.858 2.86 2.86 0 0 1-.628-2.28A4.515 4.515 0 0 1 26.292 13a2.65 2.65 0 0 1 2.053.858 2.86 2.86 0 0 1 .628 2.28Z"/></svg>`,
		  gradle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#0097a7" d="M16 10v2h6c-2 0-3-2-6-2"/><path fill="#0097a7" d="M26 4h-2a4 4 0 0 0-4 4h4a1 1 0 0 1 2 0v4H16v-2h-5.317A2.683 2.683 0 0 0 8 12.683v2.634A2.683 2.683 0 0 0 10.683 18H16v2h-5.98A4.02 4.02 0 0 1 6 16v-2c-2 0-4 4-4 8 0 5 1 6 2 6h4v-4h4v4h4v-4h4v4h4v-6a2 2 0 0 0 2-2v-2a4 4 0 0 0 4-4V8a4 4 0 0 0-4-4m-4 12h-2a2 2 0 0 1-2-2h6a2 2 0 0 1-2 2"/></svg>`,
		  graphql: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#ec407a" d="M6 20h20v2H6z"/><circle cx="7" cy="21" r="3" fill="#ec407a"/><circle cx="16" cy="27" r="3" fill="#ec407a"/><circle cx="25" cy="21" r="3" fill="#ec407a"/><path fill="#ec407a" d="M6 10h20v2H6z"/><circle cx="7" cy="11" r="3" fill="#ec407a"/><circle cx="16" cy="5" r="3" fill="#ec407a"/><circle cx="25" cy="11" r="3" fill="#ec407a"/><path fill="#ec407a" d="M6 12h2v10H6zm18-2h2v12h-2z"/><path fill="#ec407a" d="m5.014 19.41 11.674 6.866L15.674 28 4 21.134z"/><path fill="#ec407a" d="M26.688 21.724 15.014 28.59 14 26.866 25.674 20zM5.124 10.382l11.415-7.29 1.077 1.686L6.2 12.068z"/><path fill="#ec407a" d="m25.798 12.067-11.415-7.29 1.077-1.685 11.415 7.29zM6.2 19.932l11.416 7.29-1.077 1.686-11.415-7.29z"/><path fill="#ec407a" d="m26.875 21.619-11.415 7.29-1.077-1.687 11.415-7.289zM5.877 22.6 16.04 3.686l1.762.946L7.638 23.546z"/><path fill="#ec407a" d="M24.361 23.545 14.197 4.633l1.761-.947 10.165 18.913z"/></svg>`,
		  groovy: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#26c6da" d="M19.322 2a6.5 6.5 0 0 1 4.352 1.419 4.55 4.55 0 0 1 1.685 3.662 5.82 5.82 0 0 1-1.886 4.275 6.04 6.04 0 0 1-4.34 1.846 4.15 4.15 0 0 1-2.385-.649 1.91 1.91 0 0 1-.936-1.603 1.6 1.6 0 0 1 .356-1.024 1.1 1.1 0 0 1 .861-.447q.469 0 .468.504a.79.79 0 0 0 .358.693 1.43 1.43 0 0 0 .826.245 3.1 3.1 0 0 0 2.39-1.573 5.66 5.66 0 0 0 1.154-3.39 2.64 2.64 0 0 0-.891-2.064 3.28 3.28 0 0 0-2.293-.812 6.18 6.18 0 0 0-4.086 1.736 12.9 12.9 0 0 0-3.215 4.557 13.4 13.4 0 0 0-1.233 5.36 5.86 5.86 0 0 0 1.091 3.723 3.53 3.53 0 0 0 2.905 1.372q3.058 0 5.848-4.002l2.935-.388q.546-.07.545.246a8 8 0 0 1-.423 1.24q-.421 1.097-1.152 3.668A12.7 12.7 0 0 0 26 17.72v1.66a14.2 14.2 0 0 1-4.055 2.57 10.38 10.38 0 0 1-2.764 5.931 6.7 6.7 0 0 1-4.806 2.11 3.3 3.3 0 0 1-2.012-.55 1.8 1.8 0 0 1-.718-1.514q0-2.685 5.634-5.212.532-1.766 1.152-3.507a8.6 8.6 0 0 1-2.853 2.323 7.4 7.4 0 0 1-3.48 1.01 5.46 5.46 0 0 1-4.366-2.093A8.1 8.1 0 0 1 6 15.122a11.6 11.6 0 0 1 1.966-6.426 14.7 14.7 0 0 1 5.162-4.862A12.44 12.44 0 0 1 19.322 2m-2.407 22.17q-4.055 1.875-4.054 3.695a.87.87 0 0 0 .999.97q1.964 0 3.055-4.665"/></svg>`,
		  h: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#0288d1" d="M18.5 11a5.49 5.49 0 0 0-4.5 2.344V4H8v24h6V17a2 2 0 0 1 4 0v11h6V16.5a5.5 5.5 0 0 0-5.5-5.5"/></svg>`,
		  haskell: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><g stroke-width="2.422"><path fill="#ef5350" d="m23.928 240.5 59.94-89.852-59.94-89.855h44.955l59.94 89.855-59.94 89.852z"/><path fill="#ffa726" d="m83.869 240.5 59.94-89.852-59.94-89.855h44.955l119.88 179.71h-44.95l-37.46-56.156-37.468 56.156z"/><path fill="#ffee58" d="m228.72 188.08-19.98-29.953h69.93v29.956h-49.95zm-29.97-44.924-19.98-29.953h99.901v29.953z"/></g></svg>`,
		  hcl: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#eceff1" d="M18 1.2V14h-4v-4l-4 2v16.37l4 2.43V18h4v4l4-2V3.63z"/><path fill="#eceff1" d="M14 1.2 2 8.49v15.02l4 2.43v-15.2l8-4.86zm12 4.86v15.2l-8 4.86v4.68l12-7.29V8.49z"/></svg>`,
		  hpp: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#0288d1" d="M28 6V2h-2v4h-6V2h-2v4h-4v2h4v4h2V8h6v4h2V8h4V6zm-15.5 5A5.49 5.49 0 0 0 8 13.344V4H2v24h6V17a2 2 0 0 1 4 0v11h6V16.5a5.5 5.5 0 0 0-5.5-5.5"/></svg>`,
		  html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#e65100" d="m4 4 2 22 10 2 10-2 2-22Zm19.72 7H11.28l.29 3h11.86l-.802 9.335L15.99 25l-6.635-1.646L8.93 19h3.02l.19 2 3.86.77 3.84-.77.29-4H8.84L8 8h16Z"/></svg>`,
		  image: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#26a69a" d="M8.5 6h4l-4-4zM3.875 1H9.5l4 4v8.6c0 .773-.616 1.4-1.375 1.4h-8.25c-.76 0-1.375-.627-1.375-1.4V2.4c0-.777.612-1.4 1.375-1.4M4 13.6h8V8l-2.625 2.8L8 9.4zm1.25-7.7c-.76 0-1.375.627-1.375 1.4s.616 1.4 1.375 1.4c.76 0 1.375-.627 1.375-1.4S6.009 5.9 5.25 5.9"/></svg>`,
		  java: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#f44336" d="M4 26h24v2H4zM28 4H7a1 1 0 0 0-1 1v13a4 4 0 0 0 4 4h10a4 4 0 0 0 4-4v-4h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2m0 8h-4V6h4Z"/></svg>`,
		  javascript: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#ffca28" d="M2 2v12h12V2zm6 6h1v4a1.003 1.003 0 0 1-1 1H7a1.003 1.003 0 0 1-1-1v-1h1v1h1zm3 0h2v1h-2v1h1a1.003 1.003 0 0 1 1 1v1a1.003 1.003 0 0 1-1 1h-2v-1h2v-1h-1a1.003 1.003 0 0 1-1-1V9a1.003 1.003 0 0 1 1-1"/></svg>`,
		  json: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path fill="#f9a825" d="M560-160v-80h120q17 0 28.5-11.5T720-280v-80q0-38 22-69t58-44v-14q-36-13-58-44t-22-69v-80q0-17-11.5-28.5T680-720H560v-80h120q50 0 85 35t35 85v80q0 17 11.5 28.5T840-560h40v160h-40q-17 0-28.5 11.5T800-360v80q0 50-35 85t-85 35zm-280 0q-50 0-85-35t-35-85v-80q0-17-11.5-28.5T120-400H80v-160h40q17 0 28.5-11.5T160-600v-80q0-50 35-85t85-35h120v80H280q-17 0-28.5 11.5T240-680v80q0 38-22 69t-58 44v14q36 13 58 44t22 69v80q0 17 11.5 28.5T280-240h120v80z"/></svg>`,
		  kotlin: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24"><defs><linearGradient id="a" x1="1.725" x2="22.185" y1="22.67" y2="1.982" gradientTransform="translate(1.306 1.129)scale(.89324)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7c4dff"/><stop offset=".5" stop-color="#d500f9"/><stop offset="1" stop-color="#ef5350"/></linearGradient></defs><path fill="url(#a)" d="M2.975 2.976v18.048h18.05v-.03l-4.478-4.511-4.48-4.515 4.48-4.515 4.443-4.477z"/></svg>`,
		  less: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#0277bd" d="M8 3a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2H3v2h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2v-2H8v-5a2 2 0 0 0-2-2 2 2 0 0 0 2-2V5h2V3m6 0a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1v2h-1a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-2v-2h2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5h-2V3z"/></svg>`,
		  lock: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#ffd54f" d="M25 12h-3V8a6 6 0 0 0-12 0v4H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V13a1 1 0 0 0-1-1M14 8a2 2 0 0 1 4 0v4h-4Zm2 17a4 4 0 1 1 4-4 4 4 0 0 1-4 4"/></svg>`,
		  lua: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#42a5f5" d="M30 6a3.86 3.86 0 0 1-1.167 2.833 4.024 4.024 0 0 1-5.666 0A3.86 3.86 0 0 1 22 6a3.86 3.86 0 0 1 1.167-2.833 4.024 4.024 0 0 1 5.666 0A3.86 3.86 0 0 1 30 6m-9.208 5.208A10.6 10.6 0 0 0 13 8a10.6 10.6 0 0 0-7.792 3.208A10.6 10.6 0 0 0 2 19a10.6 10.6 0 0 0 3.208 7.792A10.6 10.6 0 0 0 13 30a10.6 10.6 0 0 0 7.792-3.208A10.6 10.6 0 0 0 24 19a10.6 10.6 0 0 0-3.208-7.792m-1.959 7.625a4.024 4.024 0 0 1-5.666 0 4.024 4.024 0 0 1 0-5.666 4.024 4.024 0 0 1 5.666 0 4.024 4.024 0 0 1 0 5.666"/></svg>`,
		  markdown: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#42a5f5" d="m14 10-4 3.5L6 10H4v12h4v-6l2 2 2-2v6h4V10zm12 6v-6h-4v6h-4l6 8 6-8z"/></svg>`,
		  nix: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500"><g stroke-width=".395"><path fill="#1976d2" d="M133.347 451.499c0-.295-2.752-5.283-6.116-11.084s-6.116-10.776-6.116-11.055 9.514-16.889 21.143-36.912c11.629-20.022 21.323-36.798 21.542-37.279.346-.76-1.608-4.363-14.896-27.466-8.412-14.625-15.294-26.785-15.294-27.023 0-.5 24.46-43.501 25.206-44.31.414-.45.592-.384 1.078.395.32.513 16.876 29.256 36.791 63.87 62.62 108.85 74.852 130.01 75.41 130.46.3.242.544.554.544.694s-11.836.21-26.302.154c-23.023-.09-26.313-.175-26.393-.694-.11-.714-27.662-48.825-28.86-50.392-.746-.978-.906-1.035-1.426-.51-.688.696-28.954 49.323-29.49 50.733l-.364.96h-13.23c-10.895 0-13.228-.095-13.228-.538zm167.58-125.61c-.134-.216 1.189-2.863 2.939-5.882 6.924-11.944 84.29-145.75 96.49-166.88 7.143-12.371 13.143-22.465 13.334-22.433.362.062 25.86 43.105 25.86 43.655 0 .174-6.761 11.952-15.025 26.173-8.46 14.557-14.932 26.104-14.81 26.421.185.483 4.563.564 30.213.564h29.996l.957 1.48c.527.814 3.296 5.547 6.155 10.518s5.45 9.29 5.757 9.597c.705.705.703.724-.16 1.572-.396.388-3.36 5.323-6.588 10.965-3.228 5.643-6.056 10.387-6.285 10.543s-19.695.171-43.256.034l-42.84-.249-.803 1.15c-.442.632-7.505 12.736-15.696 26.897l-14.892 25.747h-15.486c-8.518 0-20.015.116-25.551.259-6.55.168-10.15.121-10.308-.135zm-133.75-157.86c-56.373-.055-102.5-.182-102.5-.282s5.617-10.132 12.481-22.294L89.64 123.34h30.332c27.113 0 30.332-.065 30.332-.611 0-.336-6.659-12.228-14.797-26.427s-14.797-25.917-14.797-26.04 2.682-4.853 5.96-10.51 6.003-10.578 6.056-10.934c.086-.586 1.375-.648 13.572-.648 7.412 0 13.463.143 13.446.317-.018.174.22.707.53 1.184.31.476 9.763 16.937 21.007 36.578 11.244 19.64 20.71 36.022 21.036 36.4.554.647 2.549.691 31.428.691h30.837l12.896 22.145c7.093 12.18 12.8 22.301 12.682 22.492-.117.19-4.776.303-10.352.249-5.575-.054-56.26-.143-112.63-.198z"/><path fill="#64b5f6" d="M23.046 238.939c-6.098 10.563-6.69 11.711-6.224 12.078.282.224 3.18 5.044 6.44 10.712s6.016 10.355 6.123 10.417c.106.061 13.585.153 29.95.204 16.367.052 29.994.23 30.285.399.473.273-1.08 3.094-14.637 26.574l-15.166 26.269 12.907 21.865c7.1 12.026 12.982 21.906 13.068 21.956s23.257-39.831 51.492-88.624c11.352-19.617 21.214-36.64 30.37-52.442 23.308-40.452 30.68-53.468 30.73-54.132-1.096-.11-6.141-.187-13.006-.216-3.945-.01-7.82-.02-12.75-.002l-25.341.092-15.42 26.706c-14.256 24.693-15.445 26.663-16.278 26.86l-.023.037c-.012.003-1.622-.001-1.826 0-4.29.062-20.453.063-40.226-.01-22.632-.082-41.615-.125-42.183-.096-.567.03-1.147-.03-1.29-.132-.141-.102-3.29 5.066-6.996 11.485zm205.16-190.3c-.123.149 5.62 10.392 12.761 22.763 12.2 21.131 89.393 155.03 96.276 167 1.503 2.613 2.92 4.803 3.443 5.348.9-1.249 3.532-5.63 7.954-13.219a1343 1343 0 0 1 10.05-17.76l6.606-11.443c.691-1.403.753-1.818.652-2.117-.161-.48-6.903-12.332-14.982-26.337-8.078-14.005-14.824-25.849-14.99-26.32a.73.73 0 0 1-.01-.366l-.426-.913 21.636-36.976c3.69-6.307 6.425-11.042 9.471-16.29 9.158-15.948 12.036-21.189 11.895-21.55-.126-.324-2.7-4.83-5.72-10.017-3.021-5.185-5.845-10.148-6.275-11.026-.483-.987-.734-1.364-1.1-1.456-.054.014-.083.018-.144.035-.42.112-5.455.195-11.19.185s-11.22.024-12.187.073l-1.76.089-14.998 25.978c-12.824 22.212-15.084 25.964-15.595 25.883-.024-.004-.15-.189-.235-.301-.109.066-.2.09-.271.05-.256-.148-7.144-11.902-15.306-26.119L279.4 48.817c-.116-.186-.444-.744-.458-.752-.476-.275-50.502.287-50.737.57zm-18.646 283.09c-.047.109-.026.262.043.48.328 1.05 25.338 43.735 25.772 43.985.206.119 14.178.239 31.05.266 26.65.044 30.749.152 31.234.832.307.43 9.987 17.214 21.513 37.296s21.152 36.627 21.394 36.767 5.926.243 12.633.23c6.705-.013 12.4.099 12.657.246.131.076.381-.141.851-.795l6.008-10.406c5.234-9.065 6.62-11.684 6.294-11.888-.575-.36-15.597-26.643-23.859-41.482-3.09-5.45-5.37-9.516-5.44-9.774-.196-.712-.066-.822 1.155-.98 1.956-.252 57.397-.057 58.071.205.237.092.79-.569 2.593-3.497 1.866-3.067 5.03-8.524 11.001-18.866 7.22-12.505 13.043-22.784 12.941-22.843s-.77-.051-1.489.016l-.046.001c-4.451.204-33.918.203-149.74.025-38.96-.06-69.786-.09-71.912-.072-1.12.01-2.095.076-2.66.172a.3.3 0 0 0-.062.083z"/></g></svg>`,
		  ocaml: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="m12.019 15.021.003-.008c-.005-.021-.006-.026-.003.008"/><path fill="#ff9800" d="M4.51 3.273a2.523 2.523 0 0 0-2.524 2.523V11.3c.361-.13.88-.898 1.043-1.085.285-.327.337-.743.478-1.006C3.83 8.612 3.886 8.2 4.62 8.2c.342 0 .478.08.71.39.16.216.438.615.568.882.15.307.396.724.503.808q.122.095.233.137c.119.044.218-.037.297-.1.102-.082.145-.247.24-.467.135-.317.283-.697.367-.83.146-.23.195-.501.352-.633.232-.195.535-.208.618-.225.466-.092.677.225.907.43.15.133.355.403.5.765.114.283.26.544.32.707.059.158.203.41.289.713.077.275.286.486.365.616 0 0 .121.34.858.65.16.067.482.176.674.246.32.116.63.101 1.025.054.281 0 .434-.408.562-.734.075-.193.148-.745.197-.902.048-.153-.064-.27.031-.405.112-.156.178-.164.242-.368.138-.436.936-.458 1.384-.458.374 0 .327.363.96.239.364-.072.714.046 1.1.149.324.086.63.184.812.398.119.139.412.834.113.863.029.035.05.099.104.134-.067.262-.357.075-.518.041-.217-.045-.37.007-.583.101-.363.162-.894.143-1.21.407-.27.223-.269.721-.394 1 0 0-.348.895-1.106 1.443-.194.14-.574.477-1.4.605a5.3 5.3 0 0 1-1.1.043c-.186-.009-.362-.018-.549-.02-.11-.002-.48-.013-.461.022l-.041.103.024.138c.015.083.019.149.022.225.006.157-.013.32-.005.478.017.328.138.627.154.958.017.368.199.758.375 1.059.067.114.169.128.213.269.052.161.003.333.028.505.1.668.292 1.366.592 1.97l.008.014c.371-.062.743-.196 1.226-.267.885-.132 2.115-.064 2.906-.138 2-.188 3.085.82 4.882.407V5.796a2.523 2.523 0 0 0-2.523-2.523zm-.907 11.144q-.022 0-.046.003c-.159.025-.313.08-.412.24-.08.13-.108.355-.164.505-.064.175-.176.338-.274.505-.18.305-.504.581-.644.879-.028.06-.053.13-.076.2v3.402c.163.028.333.062.524.113 1.407.375 1.75.407 3.13.25l.13-.018c.105-.22.187-.968.255-1.2.054-.178.127-.32.155-.5.026-.173-.003-.337-.017-.493-.04-.393.285-.533.44-.87.14-.304.22-.651.336-.963.11-.298.284-.721.579-.872-.036-.041-.617-.06-.772-.076a5 5 0 0 1-.5-.07c-.314-.064-.656-.126-.965-.2a10 10 0 0 1-.947-.328c-.298-.138-.503-.497-.732-.507m5.737.83c-.74.149-.97.876-1.32 1.451-.192.319-.396.59-.548.928-.14.312-.128.657-.368.924a2.55 2.55 0 0 0-.528.922c-.023.067-.088.776-.158.943l1.101-.078c1.026.07.73.464 2.332.378l2.529-.078a7 7 0 0 0-.228-.588c-.07-.147-.16-.434-.218-.56a3.5 3.5 0 0 0-.309-.526c-.184-.215-.227-.23-.28-.503-.095-.473-.344-1.33-.637-1.923-.151-.306-.403-.562-.634-.784-.2-.195-.655-.522-.734-.505z"/></svg>`,
		  php: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#1e88e5" d="M12 18.08c-6.63 0-12-2.72-12-6.08s5.37-6.08 12-6.08S24 8.64 24 12s-5.37 6.08-12 6.08m-5.19-7.95c.54 0 .91.1 1.09.31.18.2.22.56.13 1.03-.1.53-.29.87-.58 1.09q-.42.33-1.29.33h-.87l.53-2.76zm-3.5 5.55h1.44l.34-1.75h1.23c.54 0 .98-.06 1.33-.17.35-.12.67-.31.96-.58.24-.22.43-.46.58-.73.15-.26.26-.56.31-.88.16-.78.05-1.39-.33-1.82-.39-.44-.99-.65-1.82-.65H4.59zm7.25-8.33-1.28 6.58h1.42l.74-3.77h1.14c.36 0 .6.06.71.18s.13.34.07.66l-.57 2.93h1.45l.59-3.07c.13-.62.03-1.07-.27-1.36-.3-.27-.85-.4-1.65-.4h-1.27L12 7.35zM18 10.13c.55 0 .91.1 1.09.31.18.2.22.56.13 1.03-.1.53-.29.87-.57 1.09-.29.22-.72.33-1.3.33h-.85l.5-2.76zm-3.5 5.55h1.44l.34-1.75h1.22c.55 0 1-.06 1.35-.17.35-.12.65-.31.95-.58.24-.22.44-.46.58-.73.15-.26.26-.56.32-.88.15-.78.04-1.39-.34-1.82-.36-.44-.99-.65-1.82-.65h-2.75z"/></svg>`,
		  python: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#0288d1" d="M9.86 2A2.86 2.86 0 0 0 7 4.86v1.68h4.29c.39 0 .71.57.71.96H4.86A2.86 2.86 0 0 0 2 10.36v3.781a2.86 2.86 0 0 0 2.86 2.86h1.18v-2.68a2.85 2.85 0 0 1 2.85-2.86h5.25c1.58 0 2.86-1.271 2.86-2.851V4.86A2.86 2.86 0 0 0 14.14 2zm-.72 1.61c.4 0 .72.12.72.71s-.32.891-.72.891c-.39 0-.71-.3-.71-.89s.32-.711.71-.711"/><path fill="#fdd835" d="M17.959 7v2.68a2.85 2.85 0 0 1-2.85 2.859H9.86A2.85 2.85 0 0 0 7 15.389v3.75a2.86 2.86 0 0 0 2.86 2.86h4.28A2.86 2.86 0 0 0 17 19.14v-1.68h-4.291c-.39 0-.709-.57-.709-.96h7.14A2.86 2.86 0 0 0 22 13.64V9.86A2.86 2.86 0 0 0 19.14 7zM8.32 11.513l-.004.004.038-.004zm6.54 7.276c.39 0 .71.3.71.89a.71.71 0 0 1-.71.71c-.4 0-.72-.12-.72-.71s.32-.89.72-.89"/></svg>`,
		  r: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#1976d2" d="M11.956 4.05c-5.694 0-10.354 3.106-10.354 6.947 0 3.396 3.686 6.212 8.531 6.813v2.205h3.53V17.82c.88-.093 1.699-.259 2.475-.497l1.43 2.692h3.996l-2.402-4.048c1.936-1.263 3.147-3.034 3.147-4.97 0-3.841-4.659-6.947-10.354-6.947m1.584 2.712c4.349 0 7.558 1.45 7.558 4.753 0 1.77-.952 3.013-2.505 3.779a1 1 0 0 1-.228-.156c-.373-.165-.994-.352-.994-.352s3.085-.227 3.085-3.302-3.23-3.127-3.23-3.127h-7.092v7.413c-2.64-.766-4.462-2.392-4.462-4.255 0-2.63 3.52-4.753 7.868-4.753m.156 4.12h2.143s.983-.05.983.974c0 1.004-.983 1.004-.983 1.004h-2.143v-1.977m-.031 4.566h.952c.186 0 .28.052.445.207.135.103.28.3.404.476-.57.073-1.17.104-1.801.104z"/></svg>`,
		  react: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#00bcd4" d="M16 12c7.444 0 12 2.59 12 4s-4.556 4-12 4-12-2.59-12-4 4.556-4 12-4m0-2c-7.732 0-14 2.686-14 6s6.268 6 14 6 14-2.686 14-6-6.268-6-14-6"/><path fill="#00bcd4" d="M16 14a2 2 0 1 0 2 2 2 2 0 0 0-2-2"/><path fill="#00bcd4" d="M10.458 5.507c2.017 0 5.937 3.177 9.006 8.493 3.722 6.447 3.757 11.687 2.536 12.392a.9.9 0 0 1-.457.1c-2.017 0-5.938-3.176-9.007-8.492C8.814 11.553 8.779 6.313 10 5.608a.9.9 0 0 1 .458-.1m-.001-2A2.87 2.87 0 0 0 9 3.875C6.13 5.532 6.938 12.304 10.804 19c3.284 5.69 7.72 9.493 10.74 9.493A2.87 2.87 0 0 0 23 28.124c2.87-1.656 2.062-8.428-1.804-15.124-3.284-5.69-7.72-9.493-10.74-9.493Z"/><path fill="#00bcd4" d="M21.543 5.507a.9.9 0 0 1 .457.1c1.221.706 1.186 5.946-2.536 12.393-3.07 5.316-6.99 8.493-9.007 8.493a.9.9 0 0 1-.457-.1C8.779 25.686 8.814 20.446 12.536 14c3.07-5.316 6.99-8.493 9.007-8.493m0-2c-3.02 0-7.455 3.804-10.74 9.493C6.939 19.696 6.13 26.468 9 28.124a2.87 2.87 0 0 0 1.457.369c3.02 0 7.455-3.804 10.74-9.493C25.061 12.304 25.87 5.532 23 3.876a2.87 2.87 0 0 0-1.457-.369"/></svg>`,
		  react_ts: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#0288d1" d="M16 12c7.444 0 12 2.59 12 4s-4.556 4-12 4-12-2.59-12-4 4.556-4 12-4m0-2c-7.732 0-14 2.686-14 6s6.268 6 14 6 14-2.686 14-6-6.268-6-14-6"/><path fill="#0288d1" d="M16 14a2 2 0 1 0 2 2 2 2 0 0 0-2-2"/><path fill="#0288d1" d="M10.458 5.507c2.017 0 5.937 3.177 9.006 8.493 3.722 6.447 3.757 11.687 2.536 12.392a.9.9 0 0 1-.457.1c-2.017 0-5.938-3.176-9.007-8.492C8.814 11.553 8.779 6.313 10 5.608a.9.9 0 0 1 .458-.1m-.001-2A2.87 2.87 0 0 0 9 3.875C6.13 5.532 6.938 12.304 10.804 19c3.284 5.69 7.72 9.493 10.74 9.493A2.87 2.87 0 0 0 23 28.124c2.87-1.656 2.062-8.428-1.804-15.124-3.284-5.69-7.72-9.493-10.74-9.493Z"/><path fill="#0288d1" d="M21.543 5.507a.9.9 0 0 1 .457.1c1.221.706 1.186 5.946-2.536 12.393-3.07 5.316-6.99 8.493-9.007 8.493a.9.9 0 0 1-.457-.1C8.779 25.686 8.814 20.446 12.536 14c3.07-5.316 6.99-8.493 9.007-8.493m0-2c-3.02 0-7.455 3.804-10.74 9.493C6.939 19.696 6.13 26.468 9 28.124a2.87 2.87 0 0 0 1.457.369c3.02 0 7.455-3.804 10.74-9.493C25.061 12.304 25.87 5.532 23 3.876a2.87 2.87 0 0 0-1.457-.369"/></svg>`,
		  ruby: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#f44336" d="M18.041 3.177c2.24.382 2.879 1.919 2.843 3.527V6.67l-1.013 13.266-13.132.897h.008c-1.093-.044-3.518-.151-3.634-3.545l1.217-2.222 2.462 5.74 2.097-6.77-.045.009.018-.018 6.85 2.186L13.945 9.3l6.53-.409-5.144-4.212 2.71-1.51v.009M3.113 17.252v.017zM6.916 6.874c2.63-2.622 6.033-4.168 7.34-2.844 1.297 1.306-.072 4.523-2.702 7.135-2.666 2.613-6.015 4.248-7.322 2.933-1.306-1.324.036-4.612 2.675-7.224z"/></svg>`,
		  rust: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#ff7043" d="m30 12-4-2V6h-4l-2-4-4 2-4-2-2 4H6v4l-4 2 2 4-2 4 4 2v4h4l2 4 4-2 4 2 2-4h4v-4l4-2-2-4ZM6 16a9.9 9.9 0 0 1 .842-4H10v8H6.842A9.9 9.9 0 0 1 6 16m10 10a9.98 9.98 0 0 1-7.978-4H16v-2h-2v-2h4c.819.819.297 2.308 1.179 3.37a1.89 1.89 0 0 0 1.46.63h3.34A9.98 9.98 0 0 1 16 26m-2-12v-2h4a1 1 0 0 1 0 2Zm11.158 6H24a2.006 2.006 0 0 1-2-2 2 2 0 0 0-2-2 3 3 0 0 0 3-3q0-.08-.004-.161A3.115 3.115 0 0 0 19.83 10H8.022a9.986 9.986 0 0 1 17.136 10"/></svg>`,
		  sass: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#ec407a" d="M27.837 5.673a4.33 4.33 0 0 0-2.293-2.701c-2.362-1.261-6.11-1.298-9.548-.092a26.3 26.3 0 0 0-8.76 4.966c-2.752 2.542-3.438 4.925-3.189 6.194.523 2.668 3.274 4.539 5.485 6.042.418.284.822.559 1.175.816-1.429.76-4.261 2.444-5.088 4.248a3.88 3.88 0 0 0-.118 3.332A2.37 2.37 0 0 0 6.869 29.8a5.6 5.6 0 0 0 1.49.2 6.35 6.35 0 0 0 5.19-2.856 6.74 6.74 0 0 0 .864-5.382 7.3 7.3 0 0 1 2.044-.03 3.92 3.92 0 0 1 2.816 1.311 1.82 1.82 0 0 1 .423 1.262 1.55 1.55 0 0 1-.772 1.05c-.234.14-.586.355-.504.803.036.194.198.633.894.512a2.93 2.93 0 0 0 2.145-2.651 4 4 0 0 0-1.197-2.904 5.94 5.94 0 0 0-4.396-1.626 10.6 10.6 0 0 0-2.672.304 20 20 0 0 0-2.203-1.846c-1.712-1.3-3.33-2.529-3.235-4.26.125-2.263 2.468-4.532 6.964-6.744 4.016-1.976 7.254-2.037 8.944-1.438a2 2 0 0 1 1.204.883 2.77 2.77 0 0 1-.36 2.47 9.71 9.71 0 0 1-7.425 4.304 3.86 3.86 0 0 1-3.238-.757c-.278-.302-.593-.645-1.074-.383q-.565.31-.225 1.189a3.9 3.9 0 0 0 2.407 1.92 11.7 11.7 0 0 0 7.128-.671c3.527-1.35 6.681-5.202 5.756-8.787M11.895 24.475a4 4 0 0 1-.192.468 4.5 4.5 0 0 1-.753 1.081 2.83 2.83 0 0 1-2.533 1.107c-.056-.032-.078-.146-.085-.193a3.28 3.28 0 0 1 1.076-2.284 11.3 11.3 0 0 1 2.644-1.933 3.85 3.85 0 0 1-.157 1.754"/></svg>`,
		  scala: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#f44336" d="m6.457 9.894 12.523 5.163-.456 1.211L6 11.105Zm7.02-3.091L26 11.966l-.457 1.21L13.02 8.015ZM6.465 18.885l12.524 5.163-.457 1.21L6.01 20.097Zm7.007-3.086 12.524 5.163-.456 1.21-12.524-5.162Z"/><path fill="#f44336" d="M6 24.07V30l19.997-3.106V20.96zM6 5.11v5.99l20-3.11V2zm0 9.96v5.03l20-3.11v-5.03z"/></svg>`,
		  settings: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/><path fill="#42a5f5" d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.6.6 0 0 0-.18-.03c-.17 0-.34.09-.43.25l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1q.09.03.18.03c.17 0 .34-.09.43-.25l2-3.46c.12-.22.07-.49-.12-.64zm-1.98-1.71c.04.31.05.52.05.73s-.02.43-.05.73l-.14 1.13.89.7 1.08.84-.7 1.21-1.27-.51-1.04-.42-.9.68c-.43.32-.84.56-1.25.73l-1.06.43-.16 1.13-.2 1.35h-1.4l-.19-1.35-.16-1.13-1.06-.43c-.43-.18-.83-.41-1.23-.71l-.91-.7-1.06.43-1.27.51-.7-1.21 1.08-.84.89-.7-.14-1.13c-.03-.31-.05-.54-.05-.74s.02-.43.05-.73l.14-1.13-.89-.7-1.08-.84.7-1.21 1.27.51 1.04.42.9-.68c.43-.32.84-.56 1.25-.73l1.06-.43.16-1.13.2-1.35h1.39l.19 1.35.16 1.13 1.06.43c.43.18.83.41 1.23.71l.91.7 1.06-.43 1.27-.51.7 1.21-1.07.85-.89.7zM12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4m0 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2"/></svg>`,
		  svelte: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><path fill="#ff5722" d="M175.94 24.328c-13.037.252-26.009 3.872-37.471 11.174L79.912 72.818a67.13 67.13 0 0 0-30.355 44.906 70.8 70.8 0 0 0 6.959 45.445 67.2 67.2 0 0 0-10.035 25.102 71.54 71.54 0 0 0 12.236 54.156c23.351 33.41 69.468 43.311 102.81 22.07l58.559-37.158a67.36 67.36 0 0 0 30.355-44.906 70.77 70.77 0 0 0-6.982-45.422 67.65 67.65 0 0 0 10.059-25.102 71.63 71.63 0 0 0-12.236-54.156v-.18c-15.324-21.925-40.453-33.727-65.342-33.246zm5.137 28.68a46.5 46.5 0 0 1 36.09 19.969 42.98 42.98 0 0 1 7.365 32.557 45 45 0 0 1-1.393 5.455l-1.123 3.37-2.986-2.247a75.9 75.9 0 0 0-22.902-11.45l-2.244-.651.201-2.246a13.16 13.16 0 0 0-2.379-8.711 13.99 13.99 0 0 0-14.953-5.412 12.8 12.8 0 0 0-3.594 1.572l-58.578 37.25a12.24 12.24 0 0 0-5.502 8.15 13.1 13.1 0 0 0 2.246 9.834 14.03 14.03 0 0 0 14.93 5.569 13.5 13.5 0 0 0 3.594-1.573l22.453-14.234a41.8 41.8 0 0 1 11.898-5.232 46.48 46.48 0 0 1 49.914 18.502 43.02 43.02 0 0 1 7.363 32.557 40.42 40.42 0 0 1-18.254 27.078l-58.58 37.316a43 43 0 0 1-11.898 5.23A46.545 46.545 0 0 1 82.81 227.14a42.98 42.98 0 0 1-7.341-32.557 38 38 0 0 1 1.39-5.41l1.102-3.37 3.008 2.246a75.9 75.9 0 0 0 22.836 11.361l2.244.65-.201 2.247a13.25 13.25 0 0 0 2.447 8.644 14.03 14.03 0 0 0 15.043 5.569 13.1 13.1 0 0 0 3.592-1.573l58.467-37.316a12.17 12.17 0 0 0 5.502-8.173 12.96 12.96 0 0 0-2.246-9.811 14.03 14.03 0 0 0-15.043-5.568 12.8 12.8 0 0 0-3.592 1.57l-22.453 14.258a42.9 42.9 0 0 1-11.877 5.209 46.52 46.52 0 0 1-49.846-18.5 43.02 43.02 0 0 1-7.297-32.557A40.42 40.42 0 0 1 96.798 96.98l58.646-37.316a42.8 42.8 0 0 1 11.811-5.21 46.5 46.5 0 0 1 13.822-1.444z"/></svg>`,
		  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#ffb300" d="M29.168 14.03a2.7 2.7 0 0 0-1.968-.83 2.51 2.51 0 0 0-1.929.8h-4.443l3.078-3.078a2.835 2.835 0 0 0 2.857-2.842 2.6 2.6 0 0 0-.831-1.969 2.82 2.82 0 0 0-2.014-.788 2.67 2.67 0 0 0-1.968.788 2.36 2.36 0 0 0-.812 1.922L18 11.17V6.726a2.51 2.51 0 0 0 .8-1.929 2.7 2.7 0 0 0-.832-1.968 2.745 2.745 0 0 0-3.936 0 2.7 2.7 0 0 0-.832 1.968 2.51 2.51 0 0 0 .8 1.93v4.443l-3.138-3.138a2.36 2.36 0 0 0-.812-1.922 2.66 2.66 0 0 0-1.968-.788 2.83 2.83 0 0 0-2.014.788 2.6 2.6 0 0 0-.831 1.969 2.74 2.74 0 0 0 .831 2.013 2.8 2.8 0 0 0 2.026.829l3.078 3.078H6.729a2.51 2.51 0 0 0-1.929-.8 2.7 2.7 0 0 0-1.968.831 2.745 2.745 0 0 0 0 3.937 2.7 2.7 0 0 0 1.968.832 2.51 2.51 0 0 0 1.929-.8h4.443l-3.078 3.077a2.835 2.835 0 0 0-2.857 2.842 2.6 2.6 0 0 0 .831 1.969 2.82 2.82 0 0 0 2.014.788 2.67 2.67 0 0 0 1.968-.788 2.36 2.36 0 0 0 .812-1.922L14 20.827v4.444a2.51 2.51 0 0 0-.8 1.929 2.784 2.784 0 0 0 4.768 1.968A2.7 2.7 0 0 0 18.8 27.2a2.51 2.51 0 0 0-.8-1.929v-4.444l3.138 3.138a2.36 2.36 0 0 0 .812 1.922 2.66 2.66 0 0 0 1.968.788 2.83 2.83 0 0 0 2.014-.788 2.6 2.6 0 0 0 .831-1.969 2.74 2.74 0 0 0-.831-2.013 2.8 2.8 0 0 0-2.026-.829L20.828 18h4.443a2.51 2.51 0 0 0 1.93.8 2.784 2.784 0 0 0 1.967-4.769Z"/></svg>`,
		  swift: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ff6e40" d="M17.087 19.721c-2.36 1.36-5.59 1.5-8.86.1a13.8 13.8 0 0 1-6.23-5.32c.67.55 1.46 1 2.3 1.4 3.37 1.57 6.73 1.46 9.1 0-3.37-2.59-6.24-5.96-8.37-8.71-.45-.45-.78-1.01-1.12-1.51 8.28 6.05 7.92 7.59 2.41-1.01 4.89 4.94 9.43 7.74 9.43 7.74.16.09.25.16.36.22.1-.25.19-.51.26-.78.79-2.85-.11-6.12-2.08-8.81 4.55 2.75 7.25 7.91 6.12 12.24-.03.11-.06.22-.05.39 2.24 2.83 1.64 5.78 1.35 5.22-1.21-2.39-3.48-1.65-4.62-1.17"/></svg>`,
		  terraform: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#5c6bc0" d="m2 10 8 4V6L2 2zm10 5 8 4v-8l-8-4zm0 11 8 4v-8l-8-4zm10-14v8l8-4V8z"/></svg>`,
		  toml: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#cfd8dc" d="M4 6V4h8v2H9v7H7V6z"/><path fill="#ef5350" d="M4 1v1H2v12h2v1H1V1zm8 0v1h2v12h-2v1h3V1z"/></svg>`,
		  typescript: `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 16 16"><path fill="#0288d1" d="M2 2v12h12V2zm4 6h3v1H8v4H7V9H6zm5 0h2v1h-2v1h1a1.003 1.003 0 0 1 1 1v1a1.003 1.003 0 0 1-1 1h-2v-1h2v-1h-1a1.003 1.003 0 0 1-1-1V9a1.003 1.003 0 0 1 1-1"/></svg>`,
		  vue: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#41b883" d="M1.791 3.851 12 21.471 22.209 3.936V3.85H18.24l-6.18 10.616L5.906 3.851z"/><path fill="#35495e" d="m5.907 3.851 6.152 10.617L18.24 3.851h-3.723L12.084 8.03 9.66 3.85z"/></svg>`,
		  webassembly: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#7c4dff" d="M22 18h4v4h-4z"/><path fill="#7c4dff" d="M20 2a4 4 0 0 1-8 0H2v28h28V2Zm-2 24h-2v2h-4v-2h-2v2H6v-2H4V16h2v10h4V16h2v10h4V16h2Zm10 2h-2v-4h-4v4h-2V18h2v-2h4v2h2Z"/></svg>`,
		  xml: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#8bc34a" d="M13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4c0-1.11.89-2 2-2m.12 13.5 3.74 3.74 1.42-1.41-2.33-2.33 2.33-2.33-1.42-1.41zm11.16 0-3.74-3.74-1.42 1.41 2.33 2.33-2.33 2.33 1.42 1.41z"/></svg>`,
		  yaml: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ff5252" d="M13 9h5.5L13 3.5zM6 2h8l6 6v12c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2m12 16v-2H9v2zm-4-4v-2H6v2z"/></svg>`,
		  zig: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#f9a825" d="M2 8h6v4H2zm8 0h12v4H10zm0 12h12v4H10zm14 0h2v4h-2zM8 20l-3 4H2V12h4v8zm14-8h-6l-6 8h6z"/><path fill="#f9a825" d="M16 20h-6l-6 8m12-16h6l6-8m2 4v16h-4V12h-2l3-4z"/></svg>`,
		};

		const EXTENSION_TO_ICON = {
		  astro: "astro",
		  bash: "console",
		  c: "c",
		  cfg: "settings",
		  clj: "clojure",
		  conf: "settings",
		  cpp: "cpp",
		  cs: "csharp",
		  css: "css",
		  dart: "dart",
		  erl: "erlang",
		  ex: "elixir",
		  exs: "elixir",
		  gif: "image",
		  go: "go",
		  gql: "graphql",
		  gradle: "gradle",
		  graphql: "graphql",
		  groovy: "groovy",
		  h: "h",
		  hcl: "hcl",
		  hpp: "hpp",
		  hs: "haskell",
		  html: "html",
		  ico: "image",
		  ini: "settings",
		  java: "java",
		  jpeg: "image",
		  jpg: "image",
		  js: "javascript",
		  json: "json",
		  jsx: "react",
		  kt: "kotlin",
		  less: "less",
		  lock: "lock",
		  lua: "lua",
		  markdown: "markdown",
		  md: "markdown",
		  ml: "ocaml",
		  nix: "nix",
		  php: "php",
		  png: "image",
		  py: "python",
		  r: "r",
		  rb: "ruby",
		  rs: "rust",
		  scala: "scala",
		  scss: "sass",
		  sh: "console",
		  sql: "database",
		  svelte: "svelte",
		  svg: "svg",
		  swift: "swift",
		  tf: "terraform",
		  toml: "toml",
		  ts: "typescript",
		  tsx: "react_ts",
		  txt: "document",
		  vue: "vue",
		  wasm: "webassembly",
		  webp: "image",
		  xml: "xml",
		  yaml: "yaml",
		  yml: "yaml",
		  zig: "zig",
		};

		function getRawFileIconSvg(fileName) {
		  const ext = getExtension(fileName);
		  if (ext) {
		    const iconName = EXTENSION_TO_ICON[ext];
		    if (iconName && SVG_ICONS[iconName]) return SVG_ICONS[iconName];
		  }
		  return SVG_ICONS["_default"];
		}

		function getExtension(name) {
		  const idx = name.lastIndexOf(".");
		  if (idx === -1 || idx === name.length - 1) return null;
		  return name.slice(idx + 1).toLowerCase();
		}

		/* Oklab desaturation ported from paseo utils/color.ts (MIT): vendor icon
		 * colors are pulled toward neutral at equal perceived lightness so a
		 * column of icons does not outshout the row's status information */
		function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
		function linearToSrgb(c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
		function linearRgbToOklab(r, g, b) {
			const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
			const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
			const sn = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
			return {
				L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * sn,
				a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * sn,
				b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * sn,
			};
		}
		function oklabToLinearRgb(L, a, b) {
			const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
			const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
			const sn = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
			return [
				4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * sn,
				-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * sn,
				-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * sn,
			];
		}
		function parseHexColor(hex) {
			const body = hex.charAt(0) === "#" ? hex.slice(1) : hex;
			if (!/^[0-9a-fA-F]+$/.test(body)) return null;
			let expanded;
			if (body.length === 3) expanded = body[0] + body[0] + body[1] + body[1] + body[2] + body[2];
			else if (body.length === 6) expanded = body;
			else return null;
			return [
				Number.parseInt(expanded.slice(0, 2), 16) / 255,
				Number.parseInt(expanded.slice(2, 4), 16) / 255,
				Number.parseInt(expanded.slice(4, 6), 16) / 255,
			];
		}
		function toHexChannel(c) {
			const clamped = Math.min(255, Math.max(0, Math.round(c * 255)));
			return clamped.toString(16).padStart(2, "0");
		}
		function desaturateHexColor(hex, amount) {
			const rgb = parseHexColor(hex);
			if (!rgb) return hex;
			const lab = linearRgbToOklab(srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2]));
			const lin = oklabToLinearRgb(lab.L, lab.a * amount, lab.b * amount);
			return "#" + toHexChannel(linearToSrgb(lin[0])) + toHexChannel(linearToSrgb(lin[1])) + toHexChannel(linearToSrgb(lin[2]));
		}
		const FILE_ICON_CHROMA = 0.65;
		const tonedIconCache = new Map();
		function toneSvg(svg) { return svg.replace(/#[0-9a-fA-F]+/g, (hex) => desaturateHexColor(hex, FILE_ICON_CHROMA)); }
		function getFileIconSvg(fileName) {
			const raw = getRawFileIconSvg(fileName);
			let toned = tonedIconCache.get(raw);
			if (toned === undefined) {
				toned = toneSvg(raw);
				tonedIconCache.set(raw, toned);
			}
			return toned;
		}
		function FileIcon(props) {
			return h("span", { className: "dsh-bw-fileicon", dangerouslySetInnerHTML: { __html: getFileIconSvg(props.name) } });
		}

		/* ================================================================ */
		/* file editor (CAS-protected writes via POST /file)                  */
		/* ================================================================ */

		function FileEditor(props) {
			const [text, setText] = useState(props.initialContent != null ? props.initialContent : null);
			const [base, setBase] = useState(props.initialContent != null ? props.initialContent : null);
			const [sha1, setSha1] = useState(props.initialSha1 || null);
			const [saving, setSaving] = useState(false);
			const [error, setError] = useState(null);
			const [conflict, setConflict] = useState(false);

			const load = useCallback(async () => {
				try {
					const r = await apiGet("/file" + qs({ cwd: props.cwd, path: props.path }));
					if (r && r.ok && r.kind === "text") {
						setText(r.content);
						setBase(r.content);
						setSha1(r.sha1 || null);
						setError(null);
						setConflict(false);
					} else {
						setError(t("files.editUnavailable"));
					}
				} catch {
					setError(t("files.editUnavailable"));
				}
			}, [props.cwd, props.path]);

			useEffect(() => {
				if (props.initialContent != null) return;
				load();
			}, [load, props.initialContent]);

			async function save() {
				if (text === null || saving) return;
				setSaving(true);
				setError(null);
				try {
					const r = await apiPost("/file", {
						cwd: props.cwd, path: props.path, content: text, baseSha1: sha1 || undefined,
					});
					if (r && r.ok) {
						setBase(text);
						if (r.sha1) setSha1(r.sha1);
						setConflict(false);
						if (props.onSaved) props.onSaved();
					} else if (r && r.error === "conflict") {
						setConflict(true);
						setError(t("files.conflict"));
					} else {
						setError(failureMessage(r) || t("files.saveFailed"));
					}
				} catch (e) {
					setError(String((e && e.message) || e));
				} finally {
					setSaving(false);
				}
			}

			if (text === null) return h("div", { className: "dsh-bw-empty" }, error || t("diff.loading"));
			const dirty = text !== base;
			return h("div", { className: "dsh-bw-editor" },
				h("div", { className: "dsh-bw-editor-bar" },
					h("span", { className: "dsh-bw-editor-path", title: props.path }, props.path),
					dirty ? h("span", { className: "dsh-bw-editor-dirty" }, "\u25cf") : null,
					h("span", { style: { flex: 1 } }),
					error ? h("span", { className: "dsh-bw-hero-error" }, error) : null,
					conflict ? h("button", { type: "button", className: "dsh-bw-btn", onClick: load }, t("files.reload")) : null,
					h("button", {
						type: "button", className: "dsh-bw-btn dsh-bw-btn-primary",
						disabled: !dirty || saving, onClick: save,
					}, saving ? t("files.saving") : t("files.save")),
					h("button", { type: "button", className: "dsh-bw-btn", onClick: props.onClose }, t("files.cancelEdit"))),
				h("textarea", {
					className: "dsh-bw-editor-area", value: text, spellCheck: false,
					onChange: (e) => setText(e.target.value),
					onKeyDown: (e) => {
						if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
							e.preventDefault();
							save();
						}
					},
				}));
		}

		function FileDiff({ file, wrap, anchorId, onEdit }) {
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
									h("span", { className: "dsh-bw-red" }, "−" + fmtNum(file.deletions || 0)))),
					onEdit && file.status !== "binary" && file.status !== "too_large" && file.status !== "deleted"
						? h("button", {
							type: "button", className: "dsh-bw-btn dsh-bw-fileedit",
							onClick: (e) => { e.stopPropagation(); onEdit(file.path); },
						}, t("diff.editFile"))
						: null),
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
			const [touched, setTouched] = useState(null);
			const [detectLite, setDetectLite] = useState(null);
			const [taskMissing, setTaskMissing] = useState(false);
			const [pane, setPane] = useState("files");
			const [diff, setDiff] = useState(null);
			const [commits, setCommits] = useState(null);
			const [selectedCommit, setSelectedCommit] = useState(null);
			const [actions, setActions] = useState(null);
			const [selectedFile, setSelectedFile] = useState(null);
			const [editingFile, setEditingFile] = useState(null);
			const [running, setRunning] = useState(null);
			const [banner, setBanner] = useState(null);
			const [ignoreWs, setIgnoreWs] = useState(false);
			const [wrap, setWrap] = useState(false);
			const [commitMsg, setCommitMsg] = useState("");
			const [rev, setRev] = useState(0);
			const lastAutoRefetch = useRef(0);
			// paseo-parity defaults: a managed worktree session's history IS the
			// task diff (base..worktree); a shared-workspace session falls back to
			// its own transcript-attributed files, then to plain uncommitted
			useEffect(() => {
				let alive = true;
				setDetectLite(null);
				setTouched(null);
				setTaskMissing(false);
				if (!cwd) return undefined;
				(async () => {
					let det = null;
					try { det = await apiGet("/detect" + qs({ cwd })); } catch { det = null; }
					if (!alive) return;
					if (det && det.ok) setDetectLite(det);
					if (det && det.ok && det.isLinkedWorktree && det.managed && det.baseRef) {
						setMode("task");
						return;
					}
					const paths = await sessionTouchedPaths(sessionId, cwd);
					if (!alive) return;
					setTouched(paths);
					setMode(paths && paths.size > 0 ? "session" : "uncommitted");
				})();
				return () => { alive = false; };
			}, [cwd, sessionId]);

			useEffect(() => {
				if (mode !== "session" || !cwd) return undefined;
				let alive = true;
				sessionTouchedPaths(sessionId, cwd, true).then((paths) => { if (alive) setTouched(paths); });
				return () => { alive = false; };
			}, [mode, rev, sessionId, cwd]);


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
					else if (diffResult && diffResult.error === "task-base-missing") {
						setTaskMissing(true);
						setMode("uncommitted");
					}
					if (actionsResult && actionsResult.ok) setActions(actionsResult);
					if ((mode === "base" || mode === "task") && pane === "commits" && !selectedCommit) {
						const commitsResult = await apiGet("/commits" + qs({
							cwd,
							base: mode === "task" && diffResult && diffResult.ok ? diffResult.refs.baseRef : undefined,
						}));
						if (commitsResult && commitsResult.ok) setCommits(commitsResult);
					}
				} catch { /* transient */ }
			}, [cwd, mode, pane, selectedCommit ? selectedCommit.sha : "", ignoreWs, agentRunning, rev]);

			useEffect(() => {
				setDiff(null);
				setEditingFile(null);
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
					h("button", {
						type: "button", "aria-pressed": mode === "session",
						disabled: touched !== null && touched.size === 0,
						title: touched === null ? t("diff.sessionUnavailable") : touched && touched.size === 0 ? t("diff.sessionEmpty") : undefined,
						onClick: () => { setMode("session"); setSelectedCommit(null); },
					}, t("diff.modeSession")),
					detectLite && detectLite.isLinkedWorktree && detectLite.managed
						? h("button", { type: "button", "aria-pressed": mode === "task", onClick: () => { setMode("task"); setSelectedCommit(null); } }, t("diff.modeTask"))
						: null,
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
			const taskBanner = taskMissing
				? h("div", { className: "dsh-bw-banner dsh-bw-banner-err" }, t("diff.taskUnavailable"))
				: null;

			const allFiles = (diff && diff.files) || [];
			const files = mode === "session" && touched ? allFiles.filter((f) => touched.has(f.path)) : allFiles;
			const showCommitToggle = mode === "base" || mode === "task";
			const fileList = h("div", { className: "dsh-bw-filelist" },
				showCommitToggle
					? h("div", { className: "dsh-bw-seg", style: { margin: "8px 10px" } },
						h("button", { type: "button", "aria-pressed": pane === "files", onClick: () => { setPane("files"); setSelectedCommit(null); } }, t("diff.paneFiles")),
						h("button", { type: "button", "aria-pressed": pane === "commits", onClick: () => setPane("commits") }, t("diff.paneCommits")))
					: null,
				pane === "files" || selectedCommit
					? files.length === 0
						? h("div", { className: "dsh-bw-empty" }, mode === "session" && touched && touched.size === 0 ? t("diff.sessionEmpty") : diff ? t("diff.empty") : t("diff.loading"))
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
					: files.map((file, index) => h(FileDiff, {
						key: (selectedCommit ? selectedCommit.sha : mode) + ":" + file.path,
						file, wrap, anchorId: "dsh-bw-f-" + index,
						onEdit: (path) => setEditingFile(path),
					})));

			return h("div", { className: "dsh-bw-view" },
				toolbar,
				bannerEl,
				taskBanner,
				commitRow,
				h("div", { className: "dsh-bw-body" }, fileList,
					editingFile
						? h(FileEditor, {
							cwd,
							path: editingFile,
							onSaved: () => { load(); },
							onClose: () => { setEditingFile(null); load(); },
						})
						: diffPane));
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
			const [editing, setEditing] = useState(false);

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
				setEditing(false);
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
				setEditing(false);
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
							style: { paddingLeft: 8 + depth * 14 },
							onClick: () => openFile(entry.path),
						},
							h(FileIcon, { name: entry.name }),
							h("span", { className: "dsh-bw-treename" }, entry.name)));
					}
				}
				return nodes;
			}

			let viewer;
			if (editing && selected && content && content.kind === "text") {
				viewer = h(FileEditor, {
					cwd,
					path: selected,
					initialContent: content.content,
					initialSha1: content.sha1 || null,
					onSaved: () => { setEditing(false); openFile(selected); },
					onClose: () => { setEditing(false); openFile(selected); },
				});
			} else if (!selected) viewer = h("div", { className: "dsh-bw-empty" }, t("files.pickHint"));
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
						selected
							? h("div", { className: "dsh-bw-viewer-head" },
								h("span", { className: "dsh-bw-viewer-title", title: selected }, selected),
								content && content.kind === "text" && !editing
									? h("button", { type: "button", className: "dsh-bw-btn", onClick: () => setEditing(true) }, t("files.edit"))
									: null)
							: null,
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
				};
			}, "better-workspaces: dom injection");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__bwTest = { failureMessage, mnemonicSlug, basenameOf, getFileIconSvg, desaturateHexColor, collectTouched, normalizeTouchedPaths };
		return module.exports;
	}
});
