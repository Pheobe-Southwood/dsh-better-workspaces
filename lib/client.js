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

/* ---- diff body split ---- */
.dsh-bw-body { flex: 1; min-height: 0; display: flex; }
.dsh-bw-filelist { width: 320px; max-width: 40%; flex: none; border-right: 1px solid var(--dsh-bw-border); overflow-y: auto; }
.dsh-bw-fileitem { padding: 4px 10px; cursor: pointer; display: flex; gap: 6px; align-items: baseline; font-size: 12px; }
.dsh-bw-fileitem:hover { background: var(--dsh-bw-hover); }
.dsh-bw-fileitem-active { background: var(--dsh-bw-hover); }
.dsh-bw-fileitem-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-bw-fileitem-stat { flex: none; font-variant-numeric: tabular-nums; font-size: 11px; }
.dsh-bw-editor { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
.dsh-bw-editor-bar { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--dsh-bw-border); flex: none; }
.dsh-bw-editor-path { font-size: 12px; color: var(--dsh-bw-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dsh-bw-editor-dirty { color: var(--dsh-bw-accent); font-size: 11px; flex: none; }
.dsh-bw-editor-area { flex: 1; min-height: 0; resize: none; border: none; outline: none; padding: 10px 12px; font-family: var(--dsh-bw-code); font-size: 12px; line-height: 1.55; color: var(--dsh-bw-primary-label); background: var(--dsh-bw-bg); tab-size: 4; white-space: pre; overflow: auto; }
.dsh-bw-fileedit { flex: none; margin-left: 8px; }
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

/* ---- right-sidebar diff tab ---- */
/* The panel is as narrow as 300px: stack the file list over the diff pane
   instead of the conversation view's side-by-side split. */
.dsh-bw-sb { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.dsh-bw-sb .dsh-bw-toolbar { padding-left: 12px; padding-right: 12px; }
.dsh-bw-sb .dsh-bw-commitrow { padding-left: 12px; padding-right: 12px; }
.dsh-bw-sb .dsh-bw-body { flex-direction: column; }
.dsh-bw-sb .dsh-bw-filelist { width: auto; max-width: none; max-height: 32%; border-right: none; border-bottom: 1px solid var(--dsh-bw-border); }
.dsh-bw-tabicon { display: inline-flex; width: 16px; height: 16px; flex: none; align-items: center; justify-content: center; }
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
			"view.diff": "diff",
			"guide.title": "代码变更",
			"guide.description": "查看本会话的代码变更，并提交 / 推送 / 建 PR",
			"hero.modeLocal": "本地",
			"hero.modeWorktree": "新建 worktree",
			"hero.pickBase": "基于:{branch}",
			"hero.pickExplicit": "新分支:{name}",
			"hero.stageHint": "选定基分支即创建并跳转，草稿随迁",
			"hero.stageCreateFallback": "立即创建",
			"hero.blockReason": "正在创建隔离 Worktree…",
			"hero.localSuffix": "（本地）",
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
			"pill.title": "在右侧栏查看代码变更",
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
			"view.diff": "diff",
			"guide.title": "Changes",
			"guide.description": "Review this session's changes - commit, push, or open a PR",
			"hero.modeLocal": "Local",
			"hero.modeWorktree": "New worktree",
			"hero.pickBase": "Base: {branch}",
			"hero.pickExplicit": "New: {name}",
			"hero.stageHint": "picking a base creates and jumps, carrying your draft",
			"hero.stageCreateFallback": "Create now",
			"hero.blockReason": "Creating isolated Worktree…",
			"hero.localSuffix": " (local)",
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
			"pill.title": "View changes in the sidebar",
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

		/* hero mode menu: two items, one active — 本地 (the workspace root IS
		 * the repository checkout) vs 新建 worktree (staging). ADR 0002/0004
		 * Phase A both specify both entries; a single-item menu stranded the
		 * user in the branch picker with no way back to 本地. */
		function heroModeItems(staging, translate) {
			return [
				{ id: "local", label: translate("hero.modeLocal"), active: !staging },
				{ id: "new", label: translate("hero.modeWorktree"), active: staging },
			];
		}

		/* A path-resolved async value is only valid for the path it was
		 * resolved for. The session switch renders with the NEW cwd and the
		 * OLD detect until the new detection lands (the detect-reset and
		 * title-sync effects run in the same commit, and the reset only takes
		 * effect on the next render) — consuming the old value under the new
		 * cwd renamed the WRONG workspace (its title became
		 * "<old worktree's source workspace> · <new session title>").
		 * Tag every detect result with its cwd and read it through here. */
		function liveDetect(entry, cwd) {
			return entry && cwd && entry.cwd === cwd ? entry.value : null;
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
			// cwd-tagged detection: {cwd, value} — see liveDetect above
			const [detect, setDetect] = useState(null);
			const [staging, setStaging] = useState(false);
			const [branchPick, setBranchPick] = useState(null); // null → default
			const [newBranch, setNewBranch] = useState(false);
			const [newBranchName, setNewBranchName] = useState("");
			const [explicitName, setExplicitName] = useState(null); // user-named branch (staging)
			const [branches, setBranches] = useState(null);
			const [busy, setBusy] = useState(null);
			const [error, setError] = useState(null);

			function resetStaging() {
				setStaging(false);
				setBranchPick(null);
				setNewBranch(false);
				setNewBranchName("");
				setExplicitName(null);
				setError(null);
			}

			useEffect(() => {
				let alive = true;
				resetStaging();
				setBranches(null);
				if (!cwd) {
					setDetect(null);
					return () => { alive = false; };
				}
				setDetect(null);
				detectPath(cwd).then((value) => { if (alive) setDetect({ cwd, value }); });
				return () => { alive = false; };
			}, [cwd]);

			// never read a detection resolved for another cwd
			const det = liveDetect(detect, cwd);

			/* worktree-session workspace title follows EVERY session title, not just
			 * the first one: dsh publishes a throwaway fallback title derived from
			 * the prompt text immediately and the model's title about a second later,
			 * so a one-shot latch froze sidebar rows on the fallback forever
			 * (observed: row "dsh-better-workspaces · 请给dsh-better-workspaces…"
			 * while the session row showed its real title — ADR 0004 Amendment 6.B).
			 * A title this plugin did not compose is a human's rename: left alone.
			 * EVERY hook must run before the non-git early return below —
			 * hooks after a conditional return crash the component with a
			 * hook-count mismatch (the hero dropdown vanished that way once) */
			const lastSyncedTitle = react.useRef(null);
			const summaryTitle = summary && typeof summary.title === "string" ? summary.title : null;
			react.useEffect(() => {
				if (!cwd || !det || !det.isLinkedWorktree || !det.managed) return;
				const ws = workspaceItems().find((w) => w.path === cwd);
				if (!ws) return;
				const prefix = det.sourceWorkspaceTitle || basenameOf(det.mainRepoRoot || det.repoRoot || cwd);
				const current = typeof ws.title === "string" ? ws.title : "";
				const composed = prefix ? prefix + " · " : "";
				// self-heal rows created before provenance titles existed: a bare
				// basename title on a managed worktree gets its prefix back
				const healed = !summaryTitle && prefix && det.branch && current === basenameOf(cwd)
					? composed + det.branch
					: null;
				const title = summaryTitle ? composed + summaryTitle : healed;
				if (!title || current === title) return;
				// only rewrite a title this plugin composed (or the untouched default
				// row title); a hand-picked workspace title is not ours to overwrite
				const ours = composed ? current.indexOf(composed) === 0 : current === basenameOf(cwd);
				if (!ours && !healed) return;
				if (lastSyncedTitle.current === title) return; // this exact title already failed
				lastSyncedTitle.current = title;
				(async () => {
					try {
						const renamed = await renameWorkspaceTolerant(ws.workspaceId, title);
						if (!renamed) lastSyncedTitle.current = null; // retry on the next title
					} catch {
						lastSyncedTitle.current = null;
					}
				})();
			}, [cwd, det, summaryTitle]);

			// worktree workspaces get no hero control: they ARE the pinned
			// result — staging another worktree from inside one is not a flow
			// we offer (the sidebar row keeps its badges; hero hides entirely)
			if (!cwd || !det || !det.isGit || det.isLinkedWorktree) return null;

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
					basenameOf(det.mainRepoRoot || det.repoRoot || cwd) ||
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
					// provenance title IMMEDIATELY after registration: the sidebar
					// row otherwise sits on the default basename title (= the
					// placeholder branch) while session create / draft migration /
					// archive run — the "branch name first, prefix later" flash.
					// workspaces.create accepts no title (Remote takes {path}
					// only), so the closest we can get is the very next call.
					await renameWorkspaceTolerant(workspaceId, (sourceTitle ? sourceTitle + " · " : "") + (result.branch || ""));
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
					resetStaging();
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
							"aria-expanded": open, "aria-label": t(staging ? "hero.modeWorktree" : "hero.modeLocal"),
						},
							h(BranchIcon),
							h("span", { className: "dsh-bw-hero-label" }, busy || t(staging ? "hero.modeWorktree" : "hero.modeLocal")),
							h("span", { className: "dsh-bw-hero-chevron" }, "▾")),
					children: (close) =>
						h(MenuList, {
							items: heroModeItems(staging, t),
							onSelect: (id) => {
								close();
								if (id === "local") { resetStaging(); return; }
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

		/** Whether this page can be opened at all: the official right column is up. */
		function sidebarAvailable() {
			return Boolean(appCtx.get("sidebarRight"));
		}

		/**
		 * Open (or reveal) the diff page in the official right Sidebar. The column
		 * expands in the same step, and an already-open diff tab is revealed rather
		 * than duplicated, because a page deduplicates within its pane.
		 */
		function openDiffTab() {
			const sidebarRight = appCtx.get("sidebarRight");
			if (!sidebarRight || typeof sidebarRight.openTab !== "function") return;
			try {
				sidebarRight.openTab(SIDEBAR_DIFF_KIND);
			} catch {
				/* no mounted right-column seat: nothing to open into */
			}
		}

		/** The pill's factual label: diffstat, then dirty count, then unpushed, then the bare tab name. */
		function pillLabel(snapshot, translate) {
			const stat = snapshot.diffStat;
			if (stat && (stat.additions > 0 || stat.deletions > 0)) {
				return h("span", null,
					stat.additions > 0 ? h("span", { className: "dsh-bw-green" }, "+" + fmtNum(stat.additions)) : null,
					stat.additions > 0 && stat.deletions > 0 ? " " : null,
					stat.deletions > 0 ? h("span", { className: "dsh-bw-red" }, "−" + fmtNum(stat.deletions)) : null);
			}
			if (snapshot.dirty) return h("span", null, translate("pill.dirty", { n: snapshot.changedFileCount || 0 }));
			const ahead = snapshot.upstream ? snapshot.upstream.ahead : 0;
			if (ahead > 0) return h("span", null, "↑" + ahead + " " + translate("diff.unpushed"));
			return h("span", null, translate("view.diff"));
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
			// The pill is the diff page's only door: the conversation no longer has
			// a diff tab, so a clean git session keeps the pill (showing "diff")
			// instead of dropping the view out of reach.
			if (!cwd || !snapshot || !snapshot.isGit || !sidebarAvailable()) return null;
			return h("button", {
				type: "button", className: "dsh-bw-pill", title: t("pill.title"),
				onClick: () => openDiffTab(),
			},
				h("span", { className: "dsh-bw-pill-icon" }, "±"),
				pillLabel(snapshot, t));
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
			// The right-sidebar pane keeps a tab's body mounted while another tab
			// is active; `visible` is false then, which parks the auto-refetch.
			const visible = props.visible !== false;
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
					try { det = await apiGet("/detect" + qs({ path: cwd })); } catch { det = null; }
					if (!alive) return;
					if (det && det.ok) setDetectLite(det);
					// /detect answers managed=true exactly when worktree metadata
					// exists; the task route re-guards the base ref itself
					if (det && det.ok && det.isLinkedWorktree && det.managed) {
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
				if (!cwd || !visible) return;
				const now = Date.now();
				if (now - lastAutoRefetch.current < 3000) return;
				lastAutoRefetch.current = now;
				setRev((r) => r + 1);
			}, [snapshotAt, cwd, visible]);

			// coming back into view is a reason to refresh at once
			const wasVisible = useRef(visible);
			useEffect(() => {
				const previous = wasVisible.current;
				wasVisible.current = visible;
				if (!visible || previous) return;
				lastAutoRefetch.current = Date.now();
				setRev((r) => r + 1);
			}, [visible]);

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
		/* official right-Sidebar page                                       */
		/* ================================================================ */

		/**
		 * This page type's identity in the tab system, and the key its body and
		 * chip title register under in `sidebar.right.pane.tab` /
		 * `sidebar.right.pane.tab.title`.
		 */
		const SIDEBAR_DIFF_ID = "dsh-better-workspaces/diff";
		/** Type discriminator; `ctx.sidebarRight.openTab` names it. */
		const SIDEBAR_DIFF_KIND = "bw-diff";

		/**
		 * The chip's glyph: a page with one added and one removed line — the
		 * plugin's own ± motif, drawn at DSH's 16px `currentColor` stroke weight
		 * so no extra runtime dependency is needed for one small icon.
		 * @param props - rendered size and class.
		 * @returns the glyph.
		 */
		function DiffGlyph({ size, className }) {
			const edge = size || 16;
			return h("svg", {
				viewBox: "0 0 16 16", width: edge, height: edge, className,
				fill: "none", stroke: "currentColor", strokeWidth: 1.25,
				strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
			},
				h("path", { d: "M3.5 2.25h5.75L12.5 5.5v8.25h-9z" }),
				h("path", { d: "M9.25 2.25V5.5h3.25" }),
				h("path", { d: "M6 8h4" }),
				h("path", { d: "M8 6v4" }),
				h("path", { d: "M6 11.5h4" }));
		}

		/**
		 * The diff page's registry definition: a page type (no resource address),
		 * offered the same way the official files panel offers itself.
		 *
		 * The `guide` entry is what puts a 代码变更 capsule beside the official
		 * 工作区文件 one on the sidebar's 开始 page (and behind its `+` control);
		 * the composer pill stays the one-click door. Declaring it costs the
		 * `defaultSeed` shortcut: the seed lands on a type directly only while
		 * exactly ONE guide entry exists, so a session whose right column has no
		 * stored layout now opens on 开始 (the chooser) instead of jumping into
		 * 工作区文件 — the trade-off recorded in ADR 0006 Amendment 1, which
		 * supersedes this definition's earlier deliberate no.
		 * @returns the definition to register.
		 */
		function sidebarDiffDefinition() {
			return {
				id: SIDEBAR_DIFF_ID,
				kind: SIDEBAR_DIFF_KIND,
				priority: "extension",
				title: () => t("view.diff"),
				guide: [{
					order: 20,
					title: () => t("guide.title"),
					description: () => t("guide.description"),
					icon: DiffGlyph,
				}],
			};
		}

		/** The diff page's body: the shared DiffView, aware of whether its tab is showing. */
		function SidebarDiffBody(props) {
			const info = props.useTabInfo();
			return h("div", { className: "dsh-bw-sb" },
				h(DiffView, { sessionId: props.sessionId, visible: info.tab.visible }));
		}

		/** The diff chip: the glyph before the tab's captured title. */
		function SidebarDiffTitle({ useTabInfo }) {
			const { tab } = useTabInfo();
			return h(react.Fragment, null,
				h(DiffGlyph, { size: 16, className: "dsh-bw-tabicon" }),
				tab.title);
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

			/* The diff view is an official right-Sidebar page type, not a
			   conversation view: dsh 0.1.5 shipped the sidebar files panel that
			   replaces our own 文件 view, and the diff moved beside it. The
			   registration waits for the sidebar's tab registry instead of
			   declaring it in `inject`, so a dsh without a right sidebar keeps
			   every other surface (hero, badges, worktree staging) alive. */
			ctx.inject(["sidebarRightTabs"], (sidebarCtx) => {
				sidebarCtx.effect(
					() => sidebarCtx.sidebarRightTabs.register(sidebarDiffDefinition()),
					"better-workspaces: diff tab type",
				);
				sidebarCtx.slots.inject("sidebar.right.pane.tab", () => sidebarCtx.slots.register({
					name: "sidebar.right.pane.tab",
					key: SIDEBAR_DIFF_ID,
					inject: (sessionId) => ({ sessionId }),
				}, SidebarDiffBody));
				sidebarCtx.slots.inject("sidebar.right.pane.tab.title", () => sidebarCtx.slots.register({
					name: "sidebar.right.pane.tab.title",
					key: SIDEBAR_DIFF_ID,
				}, SidebarDiffTitle));
			});

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
		exports.__bwTest = { failureMessage, mnemonicSlug, basenameOf, collectTouched, normalizeTouchedPaths, heroModeItems, liveDetect, pillLabel, SIDEBAR_DIFF_ID, SIDEBAR_DIFF_KIND };
		return module.exports;
	}
});
