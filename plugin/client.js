window.__ModuleLoader__.load({
	id: "dsh-appdata-scanner",
	factory(require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// React 由宿主注入，插件不自带也不走 CDN。
		const react = require("react");
		//#region 常量
		/** 本插件身份：样式表去重标签用。 */
		const PLUGIN_ID = "dsh-appdata-scanner";
		/** 面板 id：左侧栏图标条目（sidebar.panellist 的 id）与主区页面（main 的 key）共用。 */
		const PANEL_ID = "appdata-scanner";
		/** 文案命名空间。 */
		const NS = "appdataScanner";
		/** host 半提供的只读接口前缀。 */
		const API = "/api/appdata-scanner";
		/** 标签页标题。标题槽位不注入 locale，因此用固定中文文案。 */
		const TITLE = "AppData Scanner";
		/** 联网结论的固定标签，与 src/lookup.mjs 的 LABEL 同义。 */
		const NET_LABEL = "【联网·未证实】";
		/** 面包屑最左那一段的名字：当前看的是 AppData 之下。 */
		const ROOT_LABEL = "AppData";
		/** 「查一下」按钮文案：host 有搜索 key 时是联网查询，缺 key 时降级成生成查询串。 */
		const LOOKUP_LABEL = "❓ 查一下";
		const LOOKUP_COPY_LABEL = "📋 生成查询";
		/** 安全级判定：配色与中文标签。 */
		const SAFETY = {
			safe: { text: "可安全删除", className: "adc-safe" },
			mixed: { text: "需拆分确认", className: "adc-mixed" },
			never: { text: "不可删除", className: "adc-never" },
			unknown: { text: "未证实", className: "adc-unknown" }
		};
		/** 排序维度：id 直接就是 host 的 sort 参数。 */
		const SORTS = [
			{ id: "name", label: "名称" },
			{ id: "size", label: "大小" },
			{ id: "date", label: "修改日期" }
		];
		/** 不是当前目录体积的排序方向文案。 */
		const DEFAULT_SORT = { sort: "name", dir: "asc" };
		/** 排序选择的持久化键。 */
		const SORT_STORAGE_KEY = PLUGIN_ID + ".tree.sort";
		/** 目录树的缩进步长（px）。 */
		const DEPTH_STEP = 14;
		//#endregion
		//#region 样式
		/** 只用宿主主题变量，安全级配色写死三种语义色。 */
		const CSS = ".adc-root{width:100%;max-width:100%;box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px}" +
			".adc-bar{flex:none;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1)}" +
			".adc-stats{display:flex;align-items:center;gap:14px;flex:1 1 auto;flex-wrap:wrap;min-width:0}" +
			".adc-stat{display:flex;flex-direction:column;gap:1px;min-width:0}" +
			".adc-statLabel{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px}" +
			".adc-statValue{font-size:13px;font-weight:500;white-space:nowrap}" +
			".adc-btn{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,.375rem);background:var(--dsw-alias-button-floating-fill,transparent);color:inherit;font:inherit;font-size:12px;line-height:18px;padding:4px 8px;cursor:pointer;flex:none}" +
			".adc-btn:hover{background:var(--dsw-static-neutral-100,rgba(0,0,0,.05))}" +
			".adc-btn[disabled]{opacity:.55;cursor:default}" +
			".adc-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b82f6));outline-offset:2px}" +
			".adc-btnOn{border-color:var(--dsw-alias-state-business-primary,#3b82f6);color:var(--dsw-alias-state-business-primary,#3b82f6)}" +
			".adc-env{flex:none;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:4px 10px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);border-bottom:.5px solid var(--dsw-alias-border-l1);word-break:break-all;user-select:text;-webkit-user-select:text}" +
			".adc-envWarn{color:#9a6700;background:color-mix(in srgb,#bf8700 14%,transparent);border-bottom-color:color-mix(in srgb,#bf8700 40%,transparent)}" +
			"body[data-ds-dark-theme] .adc-envWarn{color:#e3b341}" +
			".adc-envWarnText{font-weight:500}" +
			".adc-toolbar{flex:none;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1)}" +
			".adc-nav{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;flex-wrap:wrap}" +
			".adc-crumbs{display:flex;align-items:center;flex-wrap:wrap;min-width:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}" +
			".adc-crumb{box-sizing:border-box;border:none;background:transparent;color:inherit;font:inherit;font-size:11px;line-height:16px;padding:1px 3px;border-radius:var(--dsw-radius-sm,.375rem);cursor:pointer;white-space:nowrap;max-width:14em;overflow:hidden;text-overflow:ellipsis}" +
			".adc-crumb:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-static-neutral-100,rgba(0,0,0,.06))}" +
			".adc-crumb:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b82f6));outline-offset:1px}" +
			".adc-crumbNow{color:var(--dsw-alias-label-primary);font-weight:500;cursor:default}" +
			".adc-crumbNow:hover{background:transparent}" +
			".adc-crumbSep{color:var(--dsw-alias-label-tertiary)}" +
			".adc-sort{display:flex;align-items:center;gap:6px;flex-wrap:wrap}" +
			".adc-sortLabel{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px}" +
			".adc-tree{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:6px 8px 14px;display:flex;flex-direction:column;gap:2px}" +
			".adc-rowWrap{display:flex;flex-direction:column;gap:2px;border-radius:var(--dsw-radius-sm,.375rem);padding:2px 0;cursor:pointer}" +
			".adc-rowWrap:hover{background:var(--dsw-static-neutral-100,rgba(0,0,0,.04))}" +
			".adc-row{display:flex;align-items:center;gap:6px;min-height:22px;padding-left:4px}" +
			".adc-folder{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;color:var(--dsw-alias-label-tertiary)}" +
			".adc-nodeName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}" +
			".adc-metaLine{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-left:22px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}" +
			".adc-nodeSize{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap}" +
			".adc-nodeTime{font-variant-numeric:tabular-nums;white-space:nowrap}" +
			".adc-sep{opacity:.65}" +
			".adc-purpose{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;padding-left:22px}" +
			".adc-badge{font-size:10px;line-height:15px;padding:0 6px;border-radius:999px;border:.5px solid transparent;white-space:nowrap;flex:none}" +
			".adc-safe{color:#1a7f37;background:color-mix(in srgb,#2ea043 16%,transparent);border-color:color-mix(in srgb,#2ea043 40%,transparent)}" +
			".adc-mixed{color:#9a6700;background:color-mix(in srgb,#bf8700 18%,transparent);border-color:color-mix(in srgb,#bf8700 42%,transparent)}" +
			".adc-never{color:#b42318;background:color-mix(in srgb,#d1242f 16%,transparent);border-color:color-mix(in srgb,#d1242f 40%,transparent)}" +
			".adc-unknown{color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,currentColor 12%,transparent)}" +
			"body[data-ds-dark-theme] .adc-safe{color:#5ddc7a}body[data-ds-dark-theme] .adc-mixed{color:#e3b341}body[data-ds-dark-theme] .adc-never{color:#ff8b7e}" +
			".adc-nodeMeta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-left:22px}" +
			".adc-chip{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 6px;white-space:nowrap}" +
			".adc-lookup{margin-left:22px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,.375rem);padding:6px 8px;display:flex;flex-direction:column;gap:4px;background:var(--dsw-static-neutral-50,transparent)}" +
			".adc-lookupHead{font-weight:500}" +
			".adc-lookupText{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word}" +
			".adc-sources{display:flex;flex-direction:column;gap:2px;margin:0;padding-left:16px}" +
			".adc-conclusion{display:flex;flex-direction:column;gap:2px;border-left:2px solid var(--dsw-alias-state-business-primary,#3b82f6);padding:2px 0 2px 8px}" +
			".adc-conclusionHead{font-weight:500;color:var(--dsw-alias-label-primary)}" +
			".adc-conclusionText{margin:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;user-select:text;-webkit-user-select:text}" +
			".adc-sourceList{display:flex;flex-direction:column;gap:6px;margin:0;padding:0}" +
			".adc-sourceItem{display:flex;flex-direction:column;gap:1px;min-width:0}" +
			".adc-sourceTitle{font-size:11px;line-height:16px;word-break:break-word;color:var(--dsw-alias-state-business-primary,#3b82f6);text-decoration:none}" +
			".adc-sourceTitle:hover{text-decoration:underline}" +
			".adc-sourceSnippet{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}" +
			".adc-sourceUrl{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:15px;color:var(--dsw-alias-label-tertiary);word-break:break-all;user-select:text;-webkit-user-select:text}" +
			".adc-lookupEmpty{color:var(--dsw-alias-label-tertiary)}" +
			".adc-query{display:block;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word;padding:4px 6px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,.375rem);background:var(--dsw-static-neutral-50,transparent);user-select:text;-webkit-user-select:text;color:var(--dsw-alias-label-primary)}" +
			".adc-copyOk{color:#1a7f37;font-size:11px;line-height:16px}" +
			".adc-copyWarn{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}" +
			"body[data-ds-dark-theme] .adc-copyOk{color:#5ddc7a}" +
			".adc-msg{padding:14px 10px;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:8px;align-items:flex-start}" +
			".adc-note{padding:0 10px 10px;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px}" +
			".adc-reveal{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,.375rem);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;cursor:pointer;flex:none}" +
			".adc-reveal:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-static-neutral-100,rgba(0,0,0,.06))}" +
			".adc-reveal:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b82f6));outline-offset:2px}" +
			".adc-reveal[disabled]{opacity:.55;cursor:progress}" +
			".adc-revealOk{color:#1a7f37;border-color:color-mix(in srgb,#2ea043 40%,transparent)}" +
			"body[data-ds-dark-theme] .adc-revealOk{color:#5ddc7a}" +
			".adc-revealSpinner{box-sizing:border-box;width:9px;height:9px;border:1.5px solid currentColor;border-top-color:transparent;border-radius:50%;animation:adc-spin .7s linear infinite}" +
			"@keyframes adc-spin{to{transform:rotate(360deg)}}" +
			".adc-revealError{color:#b42318;font-size:10px;line-height:15px;word-break:break-word;padding-left:22px}" +
			"body[data-ds-dark-theme] .adc-revealError{color:#ff8b7e}";
		/** 按官方做法注入一次样式表，靠 data-plugin-css 去重。 */
		function ensureStyle() {
			if (typeof document === "undefined") return;
			const tagId = PLUGIN_ID + "/panel.css";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = PLUGIN_ID;
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region 取数与规整
		const h = react.createElement;

		/** 同源 JSON 请求；非 2xx 与空响应都当作失败/空值处理。 */
		async function requestJson(path, init) {
			const response = await fetch(API + path, {
				credentials: "same-origin",
				headers: { accept: "application/json" },
				cache: "no-store",
				...init
			});
			if (!response.ok) {
				// 保留状态码：打开资源管理器失败时要按 400/501 给出可读原因。
				const error = new Error("HTTP " + response.status);
				error.status = response.status;
				throw error;
			}
			const text = await response.text();
			if (text === "") return null;
			return JSON.parse(text);
		}

		function errorText(error) {
			return error instanceof Error ? error.message : String(error);
		}

		function pickNumber(source, keys) {
			for (const key of keys) {
				const value = source[key];
				if (typeof value === "number" && Number.isFinite(value)) return value;
				if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
			}
			return undefined;
		}

		/** 扫描时间可能是毫秒数、秒数或 ISO 串。 */
		function toDate(value) {
			if (typeof value === "number" && Number.isFinite(value)) {
				const ms = value < 1e12 ? value * 1000 : value;
				const date = new Date(ms);
				return Number.isNaN(date.getTime()) ? undefined : date;
			}
			if (typeof value === "string" && value.trim() !== "") {
				const date = new Date(value);
				return Number.isNaN(date.getTime()) ? undefined : date;
			}
			return undefined;
		}

		function pad(value) {
			return String(value).padStart(2, "0");
		}

		function formatTime(date) {
			if (date === undefined) return "未知";
			return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
				" " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
		}

		/** 树里一行能挤下的短格式：当年省掉年，跨年省掉时分；完整时间放 title。 */
		function formatTimeShort(date) {
			if (date === undefined) return "未知";
			const now = new Date();
			const clock = pad(date.getMonth() + 1) + "-" + pad(date.getDate());
			if (date.getFullYear() !== now.getFullYear()) return String(date.getFullYear()) + "-" + clock;
			return clock + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
		}

		function formatBytes(bytes) {
			const value = typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0;
			if (value < 1024) return value + " B";
			const units = ["KB", "MB", "GB", "TB"];
			let size = value / 1024;
			let index = 0;
			while (size >= 1024 && index < units.length - 1) {
				size = size / 1024;
				index += 1;
			}
			return (size >= 100 ? size.toFixed(0) : size.toFixed(1)) + " " + units[index];
		}

		function safetyOf(value) {
			return SAFETY[value] === undefined ? SAFETY.unknown : SAFETY[value];
		}

		/** 判定是否来自知识库；不是就要给用户一个「查一下」的出口。 */
		function isKnowledge(entry) {
			return entry.matchedBy === "knowledge" || entry.matchedBy === "knowledge-child";
		}

		/** 把 AppData 相对路径切成段；两种分隔符都认，空段丢掉。 */
		function pathSegments(relPath) {
			return String(relPath === null || relPath === undefined ? "" : relPath).split(/[\\/]+/).filter((part) => part !== "");
		}

		/** 父路径 = 去掉最后一段；已经在根层时仍是根层（空串）。 */
		function parentPathOf(relPath) {
			const parts = pathSegments(relPath);
			parts.pop();
			return parts.join("\\");
		}

		function lastSegment(relPath) {
			const parts = pathSegments(relPath);
			return parts.length === 0 ? "" : parts[parts.length - 1];
		}

		/** 树接口：path 是相对 AppData 的路径，空串即 AppData 根；排序由 host 做。 */
		function treeUrl(relPath, sort) {
			return "/tree?path=" + encodeURIComponent(relPath) +
				"&sort=" + encodeURIComponent(sort.sort) +
				"&dir=" + encodeURIComponent(sort.dir);
		}

		function sortView(value) {
			const source = value !== null && typeof value === "object" ? value : {};
			const known = SORTS.some((option) => option.id === source.sort);
			return {
				sort: known ? source.sort : DEFAULT_SORT.sort,
				dir: source.dir === "desc" ? "desc" : "asc"
			};
		}

		/** localStorage 可能不存在也可能抛错（隐私模式）；存不下就只在本次会话生效。 */
		function sortStore() {
			try {
				const store = typeof localStorage !== "undefined" ? localStorage : undefined;
				return store !== undefined && store !== null && typeof store.getItem === "function" ? store : undefined;
			} catch (_error) {
				return undefined;
			}
		}

		function readSortPreference() {
			const store = sortStore();
			if (store === undefined) return { sort: DEFAULT_SORT.sort, dir: DEFAULT_SORT.dir };
			try {
				const text = store.getItem(SORT_STORAGE_KEY);
				if (typeof text !== "string" || text === "") return { sort: DEFAULT_SORT.sort, dir: DEFAULT_SORT.dir };
				return sortView(JSON.parse(text));
			} catch (_error) {
				return { sort: DEFAULT_SORT.sort, dir: DEFAULT_SORT.dir };
			}
		}

		function writeSortPreference(value) {
			const store = sortStore();
			if (store === undefined || typeof store.setItem !== "function") return;
			try {
				store.setItem(SORT_STORAGE_KEY, JSON.stringify(sortView(value)));
			} catch (_error) {
				// 存不下不影响本次会话内的排序。
			}
		}

		/** host 已保证只返回目录；这里再挡一次，任何带文件标记的条目一律不显示。 */
		function isDirectoryEntry(raw) {
			if (raw.isDirectory === false || raw.isDir === false) return false;
			if (raw.kind === "file" || raw.type === "file") return false;
			return true;
		}

		/** 把 host 返回的一个目录收敛成树节点的形状。 */
		function treeEntryView(raw) {
			if (raw === null || typeof raw !== "object" || !isDirectoryEntry(raw)) return null;
			const relPath = String(raw.relPath || "").replace(/^[\\/]+/, "");
			// 没有 relPath 就没法展开、也没法请 host 打开：宁可不显示，也不猜一个路径。
			if (relPath === "") return null;
			const name = String(raw.name || "") || lastSegment(relPath);
			return {
				relPath: relPath,
				name: name === "" ? relPath : name,
				absPath: typeof raw.absPath === "string" ? raw.absPath : "",
				bytes: pickNumber(raw, ["bytes", "size", "sizeBytes"]) || 0,
				files: pickNumber(raw, ["files", "fileCount"]) || 0,
				dirs: pickNumber(raw, ["dirs", "dirCount"]) || 0,
				mtime: toDate(pickNumber(raw, ["newestMtime", "mtime", "modifiedAt", "newestModifiedAt"])),
				hasChildren: raw.hasChildren === true,
				truncated: raw.truncated === true,
				safety: typeof raw.safety === "string" ? raw.safety : "unknown",
				owner: typeof raw.owner === "string" ? raw.owner : "",
				purpose: typeof raw.purpose === "string" ? raw.purpose : "",
				matchedBy: typeof raw.matchedBy === "string" ? raw.matchedBy : "",
				confidence: typeof raw.confidence === "string" ? raw.confidence : ""
			};
		}

		/** 一页树的响应。root 是 AppData 绝对根，与 relPath 配对用于 reveal。 */
		function treePageOf(payload) {
			const source = payload !== null && typeof payload === "object" ? payload : {};
			const list = Array.isArray(source.entries) ? source.entries : [];
			const entries = [];
			for (const item of list) {
				const entry = treeEntryView(item);
				if (entry !== null) entries.push(entry);
			}
			return { root: typeof source.root === "string" ? source.root : "", entries: entries };
		}

		/** 汇总条：数字来自 host 的 summary，缺字段退化成 0 而不是 NaN。 */
		function summaryView(raw) {
			const source = raw !== null && typeof raw === "object" ? raw : {};
			const total = pickNumber(source, ["total", "totalEntries", "count"]);
			const reclaimable = pickNumber(source, ["reclaimableBytes", "reclaimable", "safeBytes", "reclaimBytes"]);
			// 多用户机器上「分析的是谁的 AppData」必须可见；老 host 没有这个字段就整体留空。
			const rawEnv = source.environment !== null && typeof source.environment === "object" ? source.environment : null;
			return {
				total: total === undefined ? 0 : total,
				reclaimableBytes: reclaimable === undefined ? 0 : reclaimable,
				scannedAt: toDate(source.scannedAt ?? source.scanTime ?? source.scanned_at ?? source.finishedAt ?? source.generatedAt),
				environment: rawEnv === null ? null : {
					appDataRoot: typeof rawEnv.appDataRoot === "string" ? rawEnv.appDataRoot.trim() : "",
					user: typeof rawEnv.user === "string" ? rawEnv.user.trim() : "",
					source: typeof rawEnv.source === "string" ? rawEnv.source : "",
					conflict: rawEnv.conflict === true
				}
			};
		}

		/** 摘要截断：超长补省略号，避免一条 snippet 撑满整个面板。 */
		function clipText(text, limit) {
			const value = String(text === null || text === undefined ? "" : text);
			if (limit <= 0 || value.length <= limit) return value;
			return value.slice(0, limit) + "…";
		}

		/**
		 * 一条来源：新形状是 { url, title, snippet }，老形状是纯字符串 url。
		 * 三样都没有就返回 null（这条丢掉，别渲染空壳）。
		 */
		function sourceView(raw) {
			if (typeof raw === "string") {
				const url = raw.trim();
				return url === "" ? null : { url: url, title: url, snippet: "" };
			}
			if (raw === null || typeof raw !== "object") return null;
			const url = typeof raw.url === "string" ? raw.url.trim() : (typeof raw.href === "string" ? raw.href.trim() : "");
			const title = typeof raw.title === "string" && raw.title.trim() !== "" ? raw.title.trim() : "";
			const snippet = typeof raw.snippet === "string" ? raw.snippet.trim() : (typeof raw.description === "string" ? raw.description.trim() : "");
			if (url === "" && title === "" && snippet === "") return null;
			return { url: url, title: title === "" ? url : title, snippet: clipText(snippet, 200) };
		}

		/** 联网结果的正文：结论 / facts / 来源分块呈现，缺字段不影响展示。 */
		function lookupView(payload) {
			const source = payload !== null && typeof payload === "object" ? payload : {};
			const result = source.result !== null && typeof source.result === "object" ? source.result : null;
			const facts = result !== null && Array.isArray(result.facts)
				? result.facts.map((fact) => ({ text: String(fact && fact.text || ""), source: String(fact && fact.source || "") })).filter((fact) => fact.text !== "")
				: [];
			const sources = result !== null && Array.isArray(result.sources)
				? result.sources.map(sourceView).filter((item) => item !== null)
				: [];
			return {
				label: typeof source.label === "string" && source.label !== "" ? source.label : NET_LABEL,
				query: typeof source.query === "string" ? source.query : "",
				summary: result !== null && typeof result.summary === "string" ? result.summary : "",
				// host 会带 "model" / "provider" / "none"；这里只用来判断这段结论是谁给的。
				summaryMode: result !== null && typeof result.summaryMode === "string" ? result.summaryMode : "",
				disclaimer: result !== null && typeof result.disclaimer === "string" ? result.disclaimer : "",
				cached: source.cached === true,
				needsConfirm: source.needsConfirm === true,
				// 缺搜索 key 的部署走「复制查询串」降级：这是正常路径，不能当成失败渲染。
				needsCopy: source.needsCopy === true || source.mode === "copy",
				hint: typeof source.hint === "string" && source.hint !== ""
					? source.hint
					: (result !== null && typeof result.hint === "string" ? result.hint : ""),
				reason: typeof source.reason === "string" && source.reason !== "" ? source.reason : "",
				facts: facts,
				sources: sources,
				safety: typeof source.safety === "string" ? source.safety : "unknown"
			};
		}
		//#endregion
		//#region 打开资源管理器
		/** 「在资源管理器中打开」的 tooltip 与无障碍名。 */
		const REVEAL_LABEL = "在资源管理器中打开";
		/** 失败原因的可读解释：只解释状态码，不重试、不碰磁盘。 */
		const REVEAL_HINT = { 400: "root 或 relPath 不被 host 接受", 404: "接口不存在", 501: "host 端未实现该功能" };
		/** reveal 状态按「root|相对路径」归档，不同层级的同名目录互不覆盖。 */
		function revealKeyOf(root, relPath) {
			return root + "|" + relPath;
		}
		/** 把请求失败翻成一句明确的提示；payload 有值表示 host 用 200 + ok:false 拒绝。 */
		function revealFailureText(error, payload) {
			if (payload !== null && typeof payload === "object") {
				const reason = typeof payload.error === "string" && payload.error !== "" ? payload.error : (typeof payload.message === "string" ? payload.message : "");
				return "打开资源管理器失败：" + (reason === "" ? "host 返回 ok:false" : reason);
			}
			const raw = error instanceof Error ? error.message : String(error);
			const status = error !== null && typeof error === "object" && typeof error.status === "number" ? error.status : undefined;
			const hint = status !== undefined && Object.prototype.hasOwnProperty.call(REVEAL_HINT, status) ? "（" + REVEAL_HINT[status] + "）" : "";
			return "打开资源管理器失败：" + raw + hint;
		}
		//#endregion
		//#region 剪贴板
		/** 复制降级时的缺省提示语。 */
		const COPY_HINT = "当前部署无法直接联网，已复制查询串，可到对话里询问";

		/** 兜底用的隐藏 textarea：只建一次、之后复用（复制完不收回，免得反复增删 DOM 节点）。 */
		let copyBuffer;

		/** 老浏览器兜底：隐藏 textarea + execCommand("copy")。 */
		function copyWithTextarea(text) {
			if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
			const body = document.body;
			if (body === undefined || body === null || typeof body.appendChild !== "function") return false;
			try {
				if (copyBuffer === undefined || copyBuffer === null) {
					copyBuffer = document.createElement("textarea");
					copyBuffer.setAttribute("readonly", "true");
					copyBuffer.style.position = "fixed";
					copyBuffer.style.top = "-1000px";
					copyBuffer.style.opacity = "0";
					body.appendChild(copyBuffer);
				}
				copyBuffer.value = text;
				copyBuffer.select();
				if (typeof copyBuffer.setSelectionRange === "function") copyBuffer.setSelectionRange(0, text.length);
				return document.execCommand("copy") === true;
			} catch (_error) {
				return false;
			}
		}

		/**
		 * 写剪贴板：先 navigator.clipboard，失败再走 textarea 兜底。
		 * 两条路都不通时返回 false —— 界面照样把查询串摆出来让人手动复制，不报错。
		 */
		async function copyToClipboard(text) {
			if (typeof text !== "string" || text === "") return false;
			const nav = typeof navigator !== "undefined" ? navigator : undefined;
			const clipboard = nav !== undefined && nav !== null ? nav.clipboard : undefined;
			if (clipboard !== undefined && clipboard !== null && typeof clipboard.writeText === "function") {
				try {
					await clipboard.writeText(text);
					return true;
				} catch (_error) {
					// 权限被拒或非安全上下文：继续走兜底。
				}
			}
			return copyWithTextarea(text);
		}
		//#endregion
		//#region 组件
		function SizeBadge({ safety }) {
			const style = safetyOf(safety);
			return h("span", { className: "adc-badge " + style.className }, style.text);
		}

		/** 「在资源管理器中打开」的内联图标：纯 SVG 路径，不引任何外部资源。 */
		function revealIcon() {
			return h("svg", {
				viewBox: "0 0 16 16",
				width: 12,
				height: 12,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.3",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				focusable: "false"
			},
				h("path", { d: "M2.2 5.2h4l1.3 1.6h6.3v6.4H2.2z" }),
				h("path", { d: "M9.4 8.6l3.2-3.2M10.4 5.4h2.2v2.2" })
			);
		}

		/** 只做一件事的图标按钮：请 host 在资源管理器里打开并选中该目录。 */
		function RevealButton({ state, onOpen, path }) {
			const loading = state !== undefined && state.status === "loading";
			const done = state !== undefined && state.status === "ok";
			return h("button", {
				type: "button",
				className: "adc-reveal" + (done ? " adc-revealOk" : ""),
				title: REVEAL_LABEL,
				"aria-label": REVEAL_LABEL,
				"aria-busy": loading ? "true" : "false",
				"data-reveal": path === undefined ? "" : path,
				disabled: loading,
				onClick: onOpen
			},
				loading ? h("span", { className: "adc-revealSpinner" }) : done ? "✓" : revealIcon()
			);
		}

		/** 排序控件：三个维度按钮 + 一个升降序开关；选择由父级持久化。 */
		function SortControls({ sort, onPickSort, onToggleDir }) {
			const children = [h("span", { className: "adc-sortLabel", key: "label" }, "排序")];
			for (const option of SORTS) {
				const active = option.id === sort.sort;
				children.push(h("button", {
					type: "button",
					key: option.id,
					className: "adc-btn" + (active ? " adc-btnOn" : ""),
					"aria-pressed": active ? "true" : "false",
					"data-sort": option.id,
					onClick: () => onPickSort(option.id)
				}, option.label));
			}
			children.push(h("button", {
				type: "button",
				key: "dir",
				className: "adc-btn",
				title: "切换升序 / 降序",
				"data-dir": sort.dir,
				onClick: onToggleDir
			}, sort.dir === "asc" ? "升序 ↑" : "降序 ↓"));
			return h("div", { className: "adc-sort" }, children);
		}

		/**
		 * 一条来源：标题当链接文字，下面一行灰色摘要。
		 * 没有 url 时退化成纯文本；标题和 url 不同时再补一行小号 url，方便在 Electron 里手动复制。
		 */
		function SourceRow({ item }) {
			const showUrl = item.url !== "" && item.title !== item.url;
			const label = item.url === "" ? item.title : (item.title === "" ? item.url : item.title);
			return h("div", { className: "adc-sourceItem", "data-source-item": item.url },
				item.url === ""
					? h("span", { className: "adc-sourceTitle", "data-source-text": "true" }, label)
					: h("a", {
						className: "adc-sourceTitle",
						href: item.url,
						title: item.url,
						"data-source-url": item.url,
						target: "_blank",
						rel: "noreferrer noopener"
					}, label),
				item.snippet === "" ? null : h("span", { className: "adc-sourceSnippet" }, item.snippet),
				showUrl ? h("span", { className: "adc-sourceUrl" }, item.url) : null
			);
		}

		function LookupBlock({ state, onConfirm }) {
			if (state === undefined) return null;
			if (state.status === "loading") {
				return h("div", { className: "adc-lookup" }, h("span", { className: "adc-lookupHead" }, NET_LABEL + " 查询中…"));
			}
			if (state.status === "error") {
				return h("div", { className: "adc-lookup" },
					h("span", { className: "adc-lookupHead" }, "查询失败"),
					h("span", { className: "adc-lookupText" }, state.message)
				);
			}
			const view = state.view;
			if (state.status === "confirm") {
				return h("div", { className: "adc-lookup" },
					h("span", { className: "adc-lookupHead" }, "发送前确认（只发目录名与扩展名，不含用户名与完整路径）"),
					h("span", { className: "adc-lookupText" }, view.query),
					h("button", { type: "button", className: "adc-btn", onClick: onConfirm }, "确认并联网查询"),
					view.reason === "" ? null : h("span", { className: "adc-lookupText" }, view.reason)
				);
			}
			if (view.needsCopy) {
				// 降级路径：不是错误，配色也不要用红色。
				const copyState = state.copy;
				const stateText = view.query === ""
					? "没有可用的查询串"
					: copyState === "done"
						? "✓ 已复制到剪贴板"
						: copyState === "failed"
							? "复制失败：可手动选中上面的查询串复制"
							: "正在复制…";
				return h("div", { className: "adc-lookup", "data-lookup-copy": "true" },
					h("span", { className: "adc-lookupHead" }, "📋 查询串（本次未联网）"),
					h("span", { className: "adc-lookupText" }, view.hint === "" ? COPY_HINT : view.hint),
					view.query === "" ? null : h("code", { className: "adc-query", "data-query": "true", tabIndex: 0 }, view.query),
					h("span", {
						className: copyState === "done" ? "adc-copyOk" : "adc-copyWarn",
						"data-copy-state": copyState === undefined ? "pending" : copyState
					}, stateText)
				);
			}
			const parts = [h("span", { className: "adc-lookupHead", key: "head" }, view.label + (view.cached ? "（缓存）" : ""))];
			// 结论段：标签下方、来源之前，正文可选中。
			if (view.summary !== "") {
				parts.push(h("div", { className: "adc-conclusion", key: "summary", "data-summary": "true" },
					h("span", { className: "adc-conclusionHead" }, "结论"),
					h("p", { className: "adc-conclusionText" }, view.summary)
				));
			}
			if (view.facts.length > 0) {
				parts.push(h("div", { className: "adc-sources", key: "facts" }, view.facts.map((fact, index) =>
					h("span", { className: "adc-lookupText", key: index }, "· " + fact.text + (fact.source === "" ? "" : "（" + fact.source + "）"))
				)));
			}
			if (view.sources.length > 0) {
				parts.push(h("div", { className: "adc-sourceList", key: "sources", "data-source-list": "true" },
					view.sources.map((item, index) => h(SourceRow, { item: item, key: index }))
				));
			} else {
				parts.push(h("span", { className: "adc-lookupText adc-lookupEmpty", key: "sourcesEmpty", "data-source-empty": "true" }, "没有检索到相关来源"));
			}
			if (view.disclaimer !== "") parts.push(h("span", { className: "adc-lookupText", key: "disclaimer" }, view.disclaimer));
			if (view.reason !== "" && view.summary === "") {
				parts.push(h("span", { className: "adc-lookupText", key: "reason" }, view.reason));
				if (view.query !== "") parts.push(h("span", { className: "adc-lookupText", key: "query" }, "建议查询：" + view.query));
			}
			return h("div", { className: "adc-lookup" }, parts);
		}

		/**
		 * 点在行内控件（打开 / 查一下）或「查一下」的结果块上时，整行不当作「进入目录」：
		 * 这些地方各有自己的动作，或者需要能选中文字。
		 */
		function clickFromControl(event) {
			const target = event !== null && typeof event === "object" ? event.target : undefined;
			if (target === null || target === undefined || typeof target !== "object") return false;
			if (typeof target.closest !== "function") return false;
			return target.closest("button") !== null || target.closest(".adc-lookup") !== null;
		}

		/**
		 * 双击会连发两次 click：只认第一次。否则第一次点进目录、第二次会误点进新列表里的某一行。
		 */
		function repeatedClick(event) {
			return event !== null && typeof event === "object" && typeof event.detail === "number" && event.detail > 1;
		}

		/** 目录图标：纯内联 SVG，不引任何外部资源。 */
		function folderIcon() {
			return h("svg", {
				viewBox: "0 0 16 16",
				width: 13,
				height: 13,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.2",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				focusable: "false"
			}, h("path", { d: "M1.8 4.4h4l1.2 1.5h7.2v6.6H1.8z" }));
		}

		/**
		 * 一层里的一行目录。
		 * 第一行只放 图标 + 名称 + 打开按钮，名称独占剩余宽度（体积/日期/徽章不再跟它抢位置）；
		 * 第二行是 体积 · 修改时间 · 安全级徽章，chips 与「查一下」跟在后面。
		 * 整行点击就是「进入这个目录」；行内控件由 clickFromControl 排掉。
		 * 故意不使用 hook：父级因此可以把这一层当成普通列表渲染。
		 */
		function DirectoryRow({ entry, lookupState, lookupLabel, revealState, onEnter, onReveal, onLookup, onConfirmLookup }) {
			const fullPath = entry.absPath !== "" ? entry.absPath : entry.relPath;
			const tooltip = entry.purpose === "" ? fullPath : fullPath + "\n" + entry.purpose;
			const revealFailed = revealState !== undefined && revealState.status === "error";
			const meta = [];
			if (entry.truncated) meta.push(h("span", { className: "adc-chip", key: "truncated" }, "统计中断"));
			// host 的 dirs 在空目录上可能还没对齐，chip 不能自相矛盾。
			if (entry.dirs > 0 && entry.hasChildren) meta.push(h("span", { className: "adc-chip", key: "dirs" }, entry.dirs + " 个子目录"));
			if (entry.files > 0) meta.push(h("span", { className: "adc-chip", key: "files" }, entry.files + " 个文件"));
			if (entry.owner !== "" && entry.owner !== "未知") meta.push(h("span", { className: "adc-chip", key: "owner" }, entry.owner));
			if (entry.confidence !== "") meta.push(h("span", { className: "adc-chip", key: "confidence" }, "置信度 " + entry.confidence));
			if (!isKnowledge(entry)) {
				meta.push(h("button", {
					type: "button",
					className: "adc-btn",
					key: "lookup",
					"data-lookup": entry.relPath,
					onClick: onLookup
				}, lookupLabel === undefined ? LOOKUP_LABEL : lookupLabel));
			}
			const rowClick = (event) => {
				if (clickFromControl(event) || repeatedClick(event)) return;
				onEnter();
			};
			return h("div", { className: "adc-rowWrap", "data-row": entry.relPath, onClick: rowClick },
				// 第一行：名称拿满剩余宽度，打开按钮固定在右侧。
				h("div", { className: "adc-row", "data-appdata-node": entry.relPath },
					h("span", { className: "adc-folder", "aria-hidden": "true" }, folderIcon()),
					h("span", { className: "adc-nodeName", title: tooltip, "data-name": entry.relPath }, entry.name),
					h(RevealButton, { state: revealState, onOpen: onReveal, path: entry.relPath })
				),
				// 第二行：体积 · 修改时间 · 安全级徽章。
				h("div", { className: "adc-metaLine", "data-meta-line": "true" },
					h("span", { className: "adc-nodeSize", title: formatBytes(entry.bytes), "data-size": entry.relPath }, formatBytes(entry.bytes)),
					h("span", { className: "adc-sep", "aria-hidden": "true" }, "·"),
					h("span", { className: "adc-nodeTime", title: formatTime(entry.mtime), "data-time": entry.relPath }, formatTimeShort(entry.mtime)),
					h("span", { className: "adc-sep", "aria-hidden": "true" }, "·"),
					h(SizeBadge, { safety: entry.safety })
				),
				entry.purpose === "" ? null : h("span", { className: "adc-purpose" }, entry.purpose),
				revealFailed ? h("span", { className: "adc-revealError", role: "alert" }, revealState.message) : null,
				meta.length === 0 ? null : h("div", { className: "adc-nodeMeta" }, meta),
				h(LookupBlock, { state: lookupState, onConfirm: onConfirmLookup })
			);
		}

		/** 面包屑：AppData / Local / Microsoft；每一段都能直接跳回那一级。 */
		function Breadcrumbs({ currentPath, onGo }) {
			const segments = pathSegments(currentPath);
			const parts = [h("button", {
				type: "button",
				key: "root",
				className: "adc-crumb" + (segments.length === 0 ? " adc-crumbNow" : ""),
				"data-crumb": "",
				title: ROOT_LABEL,
				onClick: () => onGo("")
			}, ROOT_LABEL)];
			let built = "";
			for (const segment of segments) {
				// 每一段的路径必须在当次迭代就定下来：onClick 闭包捕获的是这个 const，不是循环外的 built。
				const crumbPath = built === "" ? segment : built + "\\" + segment;
				built = crumbPath;
				const current = crumbPath === currentPath;
				parts.push(h("span", { className: "adc-crumbSep", key: "sep:" + crumbPath, "aria-hidden": "true" }, " / "));
				parts.push(h("button", {
					type: "button",
					key: "crumb:" + crumbPath,
					className: "adc-crumb" + (current ? " adc-crumbNow" : ""),
					"data-crumb": crumbPath,
					"aria-current": current ? "page" : "false",
					title: crumbPath,
					onClick: () => onGo(crumbPath)
				}, segment));
			}
			return h("div", { className: "adc-crumbs", "data-crumbs": currentPath }, parts);
		}

		/** 工具条左侧：返回上一级 + 当前路径。根层的返回按钮不可用。 */
		function NavBar({ currentPath, onBack, onGo }) {
			const atRoot = currentPath === "";
			return h("div", { className: "adc-nav" },
				h("button", {
					type: "button",
					className: "adc-btn",
					"data-back": "true",
					disabled: atRoot,
					title: atRoot ? "已经在 AppData 根目录" : "返回上一级",
					onClick: () => { if (!atRoot) onBack(); }
				}, "← 返回上一级"),
				h(Breadcrumbs, { currentPath: currentPath, onGo: onGo })
			);
		}

		/**
		 * 环境行：这批数据到底在分析哪个 AppData 根、哪个用户。
		 * 老 host 不给 environment 就整行不渲染；环境变量与系统 API 打架时用警告色并补一句说明。
		 */
		function EnvironmentLine({ environment }) {
			if (environment === null || environment === undefined || environment.appDataRoot === "") return null;
			const conflict = environment.conflict === true;
			const text = "正在分析：" + environment.appDataRoot + (environment.user === "" ? "" : "（用户：" + environment.user + "）");
			return h("div", {
				className: "adc-env" + (conflict ? " adc-envWarn" : ""),
				"data-env-line": "true",
				"data-env-conflict": conflict ? "true" : "false",
				title: environment.appDataRoot
			},
				h("span", null, text),
				conflict ? h("span", { className: "adc-envWarnText" }, "环境变量与系统 API 不一致，已采用系统值") : null
			);
		}

		function SummaryBar({ summary, busy, onRescan }) {
			const stat = (label, value, key) => h("div", { className: "adc-stat", key: key },
				h("span", { className: "adc-statLabel" }, label),
				h("span", { className: "adc-statValue" }, value)
			);
			return h("div", { className: "adc-bar" },
				h("div", { className: "adc-stats" },
					stat("总条目", String(summary.total), "total"),
					stat("可回收", formatBytes(summary.reclaimableBytes), "reclaimable"),
					stat("扫描时间", formatTime(summary.scannedAt), "time")
				),
				h("button", {
					type: "button",
					className: "adc-btn",
					disabled: busy,
					onClick: onRescan
				}, busy ? "扫描中…" : "重新扫描")
			);
		}

		/** 面板正文：只读的资源管理器式下钻浏览（一次只显示一层），全程没有写操作入口。 */
		function AppDataScannerPanel({ t }) {
			const translate = typeof t === "function" ? t : undefined;
			const [sort, setSort] = react.useState(readSortPreference);
			// 当前所在目录（相对 AppData；空串即 AppData 根）。
			const [currentPath, setCurrentPath] = react.useState("");
			// 当前这一层：{ status, entries, root, absPath, error }
			const [level, setLevel] = react.useState({ status: "loading", entries: [], root: "", absPath: "", error: "" });
			const [summary, setSummary] = react.useState({ total: 0, reclaimableBytes: 0, scannedAt: undefined, environment: null });
			const [busy, setBusy] = react.useState(false);
			const [message, setMessage] = react.useState("");
			const [lookups, setLookups] = react.useState({});
			const [reveals, setReveals] = react.useState({});
			// 部署能力（"api" / "copy" / "" 未知）：只影响「查一下」按钮的文案。
			const [lookupMode, setLookupMode] = react.useState("");
			// 重试与「重新扫描」都靠这个令牌重取当前层。
			const [reloadToken, setReloadToken] = react.useState(0);
			const alive = react.useRef(true);
			const signatureRef = react.useRef("");
			// 同一目标的请求在飞期间用 ref 挡连点（不依赖 state 渲染时机）。
			const inflightReveal = react.useRef({});

			react.useEffect(() => {
				alive.current = true;
				return () => {
					alive.current = false;
				};
			}, []);

			const fetchSummary = async () => {
				const payload = await requestJson("/summary").catch(() => null);
				if (!alive.current) return;
				setSummary(summaryView(payload));
			};

			/** 取一层目录；排序与方向由 host 处理，客户端只透传。 */
			const loadLevel = async (relPath, nextSort) => {
				setLevel({ status: "loading", entries: [], root: "", absPath: "", error: "" });
				try {
					const payload = await requestJson(treeUrl(relPath, nextSort));
					if (!alive.current) return;
					const page = treePageOf(payload);
					setLevel({ status: "ready", entries: page.entries, root: page.root, absPath: page.absPath, error: "" });
				} catch (error) {
					if (!alive.current) return;
					setLevel({ status: "error", entries: [], root: "", absPath: "", error: errorText(error) });
				}
			};

			// 能力探测：失败就当作未知，按钮保持默认文案，绝不阻塞渲染。
			react.useEffect(() => {
				void (async () => {
					const payload = await requestJson("/capabilities").catch(() => null);
					if (!alive.current || payload === null || typeof payload !== "object") return;
					const mode = typeof payload.lookup === "string" ? payload.lookup : "";
					if (mode === "api" || mode === "copy") setLookupMode(mode);
				})();
			}, []);

			react.useEffect(() => {
				const signature = currentPath + "|" + sort.sort + "|" + sort.dir + "|" + String(reloadToken);
				// 同一层只取一次：StrictMode 下 effect 会跑两遍，不能因此打两次请求。
				if (signatureRef.current === signature) return;
				signatureRef.current = signature;
				void loadLevel(currentPath, sort);
			}, [currentPath, sort.sort, sort.dir, reloadToken]);

			// 汇总条的数据单独取一次；放在上面那个 effect 之后，保证面板首次挂载时先 /tree 再 /summary。
			react.useEffect(() => {
				void fetchSummary();
			}, []);

			/** 进入某个目录：只换当前层，排序沿用当前选择。 */
			const enter = (relPath) => {
				setCurrentPath(typeof relPath === "string" ? relPath.replace(/^[\\/]+/, "") : "");
			};

			/** 返回上一级：父路径由当前 relPath 去掉最后一段算出来，根层的父还是根层。 */
			const goBack = () => {
				setCurrentPath((previous) => parentPathOf(previous));
			};

			const retry = () => {
				setReloadToken((value) => value + 1);
			};

			const changeSort = (nextSort) => {
				const normalized = sortView(nextSort);
				if (normalized.sort === sort.sort && normalized.dir === sort.dir) return;
				writeSortPreference(normalized);
				setSort(normalized);
			};

			const pickSort = (id) => {
				changeSort({ sort: id, dir: sort.dir });
			};

			const toggleDir = () => {
				changeSort({ sort: sort.sort, dir: sort.dir === "asc" ? "desc" : "asc" });
			};

			const rescan = async () => {
				setBusy(true);
				setMessage("");
				try {
					await requestJson("/scan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
				} catch (error) {
					if (alive.current) {
						setMessage("重新扫描失败：" + errorText(error));
						setBusy(false);
					}
					return;
				}
				if (!alive.current) return;
				setReloadToken((value) => value + 1);
				await fetchSummary();
				if (alive.current) setBusy(false);
			};

			const runLookup = async (entry, confirmed) => {
				const key = entry.relPath;
				setLookups((previous) => ({ ...previous, [key]: { status: "loading" } }));
				try {
					const body = { relPath: entry.relPath };
					if (confirmed) body.confirm = true;
					const payload = await requestJson("/lookup", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body)
					});
					if (!alive.current) return;
					const view = lookupView(payload);
					// 复制降级：先把查询串放进剪贴板，再把结果写进状态；复制失败只影响那句提示。
					const copyState = view.needsCopy ? ((await copyToClipboard(view.query)) ? "done" : "failed") : undefined;
					if (!alive.current) return;
					setLookups((previous) => ({
						...previous,
						[key]: { status: view.needsConfirm ? "confirm" : "ready", view: view, copy: copyState }
					}));
				} catch (error) {
					if (!alive.current) return;
					setLookups((previous) => ({
						...previous,
						[key]: { status: "error", message: errorText(error) }
					}));
				}
			};

			const runReveal = async (relPath, rootAbs) => {
				if (relPath === "") return;
				const key = revealKeyOf(rootAbs, relPath);
				// 防连点：同一目标还在请求中时，后续点击一律忽略。
				if (inflightReveal.current[key] === true) return;
				inflightReveal.current[key] = true;
				setReveals((previous) => ({ ...previous, [key]: { status: "loading" } }));
				try {
					const payload = await requestJson("/reveal", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ root: rootAbs, relPath: relPath })
					});
					if (!alive.current) return;
					if (payload !== null && typeof payload === "object" && payload.ok === false) {
						setReveals((previous) => ({ ...previous, [key]: { status: "error", message: revealFailureText(undefined, payload) } }));
						return;
					}
					setReveals((previous) => ({ ...previous, [key]: { status: "ok" } }));
				} catch (error) {
					if (!alive.current) return;
					setReveals((previous) => ({ ...previous, [key]: { status: "error", message: revealFailureText(error, undefined) } }));
				} finally {
					inflightReveal.current[key] = false;
				}
			};

			const rows = level.status === "ready" && level.entries.length > 0
				? h("div", { className: "adc-tree", "data-level": currentPath },
					level.entries.map((entry) => h(DirectoryRow, {
						entry: entry,
						key: entry.relPath,
						lookupState: lookups[entry.relPath],
						lookupLabel: lookupMode === "copy" ? LOOKUP_COPY_LABEL : LOOKUP_LABEL,
						revealState: reveals[revealKeyOf(level.root, entry.relPath)],
						onEnter: () => enter(entry.relPath),
						onReveal: () => { void runReveal(entry.relPath, level.root); },
						onLookup: () => { void runLookup(entry, false); },
						onConfirmLookup: () => { void runLookup(entry, true); }
					})))
				: null;

			const body = rows !== null
				? rows
				: level.status === "loading"
					? h("div", { className: "adc-msg" },
						h("span", null, translate === undefined ? "正在读取目录…" : translate("panel.loading")),
						h("span", { className: "adc-statLabel" }, "只读请求，不会修改磁盘上的任何文件。")
					)
					: level.status === "error"
						? h("div", { className: "adc-msg", "data-level-error": "true" },
							h("span", null, "读取目录失败：" + level.error),
							h("button", { type: "button", className: "adc-btn", "data-retry": "true", onClick: retry }, "重试")
						)
						: h("div", { className: "adc-msg" },
							h("span", null, currentPath === "" ? "AppData 下没有读到任何目录。" : "这个目录下没有子目录。")
						);

			const notice = message === "" || level.status === "error"
				? null
				: h("div", { className: "adc-note" }, message);
			return h("div", { className: "adc-root", "data-appdata-scanner": "panel", "data-path": currentPath },
				h(SummaryBar, { summary: summary, busy: busy, onRescan: () => { void rescan(); } }),
				h(EnvironmentLine, { environment: summary.environment }),
				h("div", { className: "adc-toolbar" },
					h(NavBar, { currentPath: currentPath, onBack: goBack, onGo: enter }),
					h(SortControls, { sort: sort, onPickSort: pickSort, onToggleDir: toggleDir })
				),
				notice,
				body,
				h("div", { className: "adc-note" }, "只读面板：这里只浏览目录，不提供任何删除动作。")
			);
		}

		/**
		 * 左侧栏图标：官方插件给 sidebar.panellist 传 { size }，这里照做。
		 * 纯内联 SVG（文件夹），currentColor 跟随主题，不引任何外部资源。
		 */
		function AppDataScannerIcon({ size }) {
			const dimension = typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 16;
			return h("svg", {
				viewBox: "0 0 16 16",
				width: dimension,
				height: dimension,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.3",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				focusable: "false",
				"data-appdata-scanner": "icon"
			}, h("path", { d: "M1.7 4.3h4.1l1.3 1.6h7.3v6.8H1.7z" }));
		}
		//#endregion
		//#region 插件入口
		/**
		 * 需要的宿主服务：只需要槽位与文案 —— 入口是「左侧栏图标 + 主区面板」，
		 * 不碰右侧栏，也不注册任何自动打开的入口。
		 */
		const inject = ["slots", "locale"];

		/** 中文词典（key 集合的准绳）。 */
		const zh = {
			"panel.title": TITLE,
			"panel.loading": "正在读取目录…（首次打开会先扫描一次）"
		};

		/** 英文词典，与中文 key 集合对齐。 */
		const en = {
			"panel.title": "AppData Cleanup",
			"panel.loading": "Reading the directory… (the first open runs a scan)"
		};

		/**
		 * 注册左侧栏图标入口与主区页面。
		 *
		 * 面板只在用户点图标、主区真正挂载时才首次渲染 —— 所以这里既不预加载数据，
		 * 也不主动打开任何东西：apply 阶段一个网络请求都不发。
		 * @param ctx - client 根上下文。
		 */
		function apply(ctx) {
			ensureStyle();
			ctx.effect(() => {
				try {
					return ctx.locale.register(NS, { zh, en });
				} catch (_error) {
					return () => {};
				}
			}, "appdata-scanner: dictionaries");
			const t = ctx.locale.bind(NS);
			// 左侧栏一个图标条目：id 与主区页面 key 相同，点它才会切到这块面板。
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 30,
				locale: NS,
				label: () => t("panel.title")
			}, AppDataScannerIcon));
			// 主区页面：未打开时组件不会被挂载，因此不会挂载即发请求。
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS
			}, AppDataScannerPanel));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.PANEL_ID = PANEL_ID;
		return module.exports;
	}
});