/*
 * ZotRecall UI: floating window (opened from Strumenti → ZotRecall or from
 * the sidebar). Everything is built with DOM APIs inside the reader document.
 */
var ZotRecallUI = {
	app: null,
	_timers: new Set(),

	init(app) {
		this.app = app;
	},

	shutdown() {
		for (let { win, timer, doc } of this._timers) {
			try {
				win.clearInterval(timer);
				doc.getElementById('zotrecall-popup')?.remove();
				doc.getElementById('zotrecall-style')?.remove();
				doc.documentElement.removeAttribute('data-zotrecall');
			}
			catch (e) {}
		}
		this._timers.clear();
		try {
			let main = Zotero.getMainWindow().document;
			main.getElementById('zotrecall-popup')?.remove();
			main.getElementById('zotrecall-style')?.remove();
		}
		catch (e) {}
	},

	// ------------------------------------------------------------------
	// DOM helpers
	// ------------------------------------------------------------------

	h(doc, tag, attrs = {}, ...children) {
		let el = doc.createElement(tag);
		for (let [k, v] of Object.entries(attrs || {})) {
			if (v === null || v === undefined || v === false) continue;
			if (k === 'class') el.className = v;
			else if (k === 'text') el.textContent = v;
			else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
			else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
			else el.setAttribute(k, v === true ? '' : v);
		}
		for (let c of children.flat()) {
			if (c === null || c === undefined || c === false) continue;
			el.append(typeof c === 'string' ? doc.createTextNode(c) : c);
		}
		return el;
	},

	svg(doc, paths, size = 20) {
		let NS = 'http://www.w3.org/2000/svg';
		let svg = doc.createElementNS(NS, 'svg');
		svg.setAttribute('width', size);
		svg.setAttribute('height', size);
		svg.setAttribute('viewBox', '0 0 20 20');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '1.4');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		for (let d of paths) {
			let p = doc.createElementNS(NS, 'path');
			p.setAttribute('d', d);
			svg.append(p);
		}
		return svg;
	},

	ICONS: {
		// Two stacked cards with a question mark
		cards: ['M5.5 4.5h9a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 15V6a1.5 1.5 0 0 1 1.5-1.5z',
			'M7 2.5h7.5A1.5 1.5 0 0 1 16 4', 'M8.4 8.6a1.7 1.7 0 1 1 2.4 1.5c-.5.3-.8.6-.8 1.2', 'M10 13.4v.1'],
		gear: ['M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
			'M16.2 11.9l1.1.9-1.6 2.8-1.4-.5a6 6 0 0 1-1.6.9l-.2 1.5H9.3l-.2-1.5a6 6 0 0 1-1.6-.9l-1.4.5-1.6-2.8 1.1-.9a6 6 0 0 1 0-1.8l-1.1-.9 1.6-2.8 1.4.5a6 6 0 0 1 1.6-.9l.2-1.5h3.2l.2 1.5a6 6 0 0 1 1.6.9l1.4-.5 1.6 2.8-1.1.9a6 6 0 0 1 0 1.8z'],
		trash: ['M4 6h12', 'M8 6V4.5h4V6', 'M5.5 6l.8 10h7.4l.8-10', 'M8.5 9v4.5M11.5 9v4.5'],
		back: ['M12 5l-5 5 5 5'],
		close: ['M5 5l10 10M15 5L5 15'],
		genPage: ['M5 2.5h6.5L15 6v11a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 5 17V3a.5.5 0 0 1 .5-.5z',
			'M11.5 2.5V6H15', 'M10 8.5v5', 'M7.5 11h5'],
		genAll: ['M7 2.5h6.5L17 6v9.5a.5.5 0 0 1-.5.5H15',
			'M4.5 5h6.5L14.5 8.5V17a.5.5 0 0 1-.5.5H4.5A.5.5 0 0 1 4 17V5.5a.5.5 0 0 1 .5-.5z',
			'M9.2 9.5l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6z'],
		filterPage: ['M3 4.5h14l-5.5 6.3v4.7l-3 1.5v-6.2L3 4.5z'],
		previewSend: ['M3.5 5.5h10a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 2 14V7a1.5 1.5 0 0 1 1.5-1.5z',
			'M5.5 3.5h10A1.5 1.5 0 0 1 17 5v7', 'M6 10.5h5', 'M9 8.5l2 2-2 2'],
	},

	injectStyle(doc) {
		let style = doc.getElementById('zotrecall-style');
		if (!style) {
			style = doc.createElement('style');
			style.id = 'zotrecall-style';
			(doc.head || doc.documentElement).append(style);
		}
		style.textContent = `
#zotrecall-popup {
	--zr-bg: #ffffff; --zr-fg: #1f1f1f; --zr-muted: #6b6b6b; --zr-border: rgba(0,0,0,.12);
	--zr-hover: rgba(0,0,0,.05); --zr-accent: #2f6fde; --zr-accent-fg: #fff; --zr-danger: #c7372f;
	--zr-field: #fff;
	position: fixed; z-index: 100000; min-width: 340px; min-height: 220px; max-width: calc(100vw - 8px);
	max-height: calc(100vh - 8px); overflow: hidden; resize: both; box-sizing: border-box;
	display: flex; flex-direction: column; user-select: text; -moz-user-select: text;
	background: var(--zr-bg); color: var(--zr-fg); border: 1px solid var(--zr-border); border-radius: 10px;
	box-shadow: 0 8px 28px rgba(0,0,0,.18); font: 13px/1.4 system-ui, -apple-system, sans-serif;
}
@media (prefers-color-scheme: dark) {
	#zotrecall-popup {
		--zr-bg: #2b2b2d; --zr-fg: #ececec; --zr-muted: #a3a3a3; --zr-border: rgba(255,255,255,.14);
		--zr-hover: rgba(255,255,255,.07); --zr-accent: #5b93f5; --zr-field: #1f1f21;
	}
}
#zotrecall-popup * { box-sizing: border-box; }
.zr-header { display: flex; align-items: center; gap: 4px; padding: 8px 8px 8px 14px; border-bottom: 1px solid var(--zr-border); background: var(--zr-bg); z-index: 1; cursor: move; user-select: none; flex: none; }
#zotrecall-popup.zr-dragging { opacity: .92; user-select: none; }
.zr-header button { cursor: pointer; }
.zr-title { flex: 1; font-weight: 600; font-size: 13px; }
.zr-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--zr-fg); cursor: pointer; position: relative; }
.zr-icon-btn:hover { background: var(--zr-hover); }
.zr-icon-btn .zr-count { position: absolute; top: 0; right: 0; font-size: 9px; font-weight: 600; color: var(--zr-muted); }
.zr-body { padding: 12px 14px 14px; flex: 1 1 auto; min-height: 0; overflow: auto; }
.zr-action { display: flex; width: 100%; align-items: center; gap: 10px; padding: 10px 12px; margin-bottom: 6px; border: 1px solid var(--zr-border); border-radius: 8px; background: transparent; color: var(--zr-fg); cursor: pointer; text-align: left; font: inherit; }
.zr-action:hover:not(:disabled) { background: var(--zr-hover); }
.zr-action:disabled { opacity: .5; cursor: default; }
.zr-action .zr-label { flex: 1; }
.zr-action .zr-sub { display: block; font-size: 11px; color: var(--zr-muted); }
.zr-pill { min-width: 22px; padding: 1px 7px; border-radius: 10px; background: var(--zr-hover); font-size: 12px; font-weight: 600; text-align: center; }
.zr-note { font-size: 12px; color: var(--zr-muted); margin: 8px 0 0; }
.zr-error { font-size: 12px; color: var(--zr-danger); margin: 8px 0 0; white-space: pre-wrap; }
.zr-ok { font-size: 12px; color: #2e8b3e; margin: 8px 0 0; }
.zr-field { display: block; margin-bottom: 12px; }
.zr-field > span { display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.zr-field input[type=text], .zr-field input[type=password], .zr-field input[type=number], .zr-field textarea {
	width: 100%; padding: 6px 8px; border: 1px solid var(--zr-border); border-radius: 6px; background: var(--zr-field); color: var(--zr-fg); font: inherit;
}
.zr-field textarea { min-height: 160px; font: 11px/1.4 ui-monospace, Menlo, monospace; resize: vertical; }
.zr-row { display: flex; gap: 6px; align-items: center; }
.zr-row input { flex: 1; }
.zr-btn { padding: 6px 12px; border: 1px solid var(--zr-border); border-radius: 6px; background: transparent; color: var(--zr-fg); cursor: pointer; font: inherit; white-space: nowrap; }
.zr-btn:hover:not(:disabled) { background: var(--zr-hover); }
.zr-btn.zr-primary { background: var(--zr-accent); border-color: var(--zr-accent); color: var(--zr-accent-fg); }
.zr-btn:disabled { opacity: .5; cursor: default; }
.zr-section { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--zr-muted); margin: 16px 0 8px; }
.zr-color-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.zr-swatch { width: 14px; height: 14px; border-radius: 3px; flex: none; }
.zr-color-row input[type=text] { flex: 1; padding: 4px 6px; border: 1px solid var(--zr-border); border-radius: 6px; background: var(--zr-field); color: var(--zr-fg); font: inherit; font-size: 12px; }
.zr-sentence { padding: 10px 0; border-bottom: 1px solid var(--zr-border); }
.zr-sentence:last-child { border-bottom: 0; }
.zr-sentence .zr-meta { font-size: 11px; color: var(--zr-muted); margin-bottom: 4px; }
.zr-sentence .zr-text span { border-radius: 2px; padding: 0 2px; }
.zr-bar { height: 6px; border-radius: 3px; background: var(--zr-hover); overflow: hidden; }
.zr-bar-fill { height: 100%; width: 0; background: var(--zr-accent); transition: width .3s; }
.zr-meta-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--zr-muted); margin-bottom: 8px; }
.zr-link { border: 0; background: none; color: var(--zr-accent); cursor: pointer; font: inherit; padding: 0; }
.zr-card { border: 1px solid var(--zr-border); border-radius: 10px; padding: 18px 16px; min-height: 140px; cursor: pointer; outline: none; }
.zr-card:focus-visible { box-shadow: 0 0 0 2px var(--zr-accent); }
.zr-card-q { font-size: 15px; font-weight: 600; text-align: center; }
.zr-card-back { margin-top: 14px; padding-top: 10px; border-top: 1px dashed var(--zr-border); }
.zr-btn.zr-danger { color: var(--zr-danger); }
.zr-tag { display: inline-block; margin-left: 4px; padding: 0 6px; border-radius: 8px; background: var(--zr-hover); font-size: 10px; }
.zr-tag-warn { background: #fde8c8; color: #8a5300; }
.zr-edit { display: block; width: 100%; min-width: 100%; max-width: 100%; min-height: 56px; padding: 8px 10px; border: 1px solid var(--zr-border); border-radius: 6px; background: var(--zr-field); color: var(--zr-fg); font: 600 14px/1.45 system-ui, -apple-system, sans-serif; resize: vertical; overflow-y: hidden; }
.zr-card.zr-editing { cursor: default; padding: 12px; }
.zr-trash-q { font-weight: 600; }
#zotrecall-popup [hidden] { display: none !important; }
.zr-select { width: 100%; padding: 5px 6px; border: 1px solid var(--zr-border); border-radius: 6px; background: var(--zr-field); color: var(--zr-fg); font: inherit; }
.zr-field input[type=text] + * , .zr-field select + input { margin-top: 6px; }
.zr-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.zr-footer.zr-session { justify-content: space-between; align-items: center; }
.zr-wrap { flex-wrap: wrap; justify-content: center; }
.zr-center { text-align: center; }
.zr-deck-link { font-size: 12px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 4px; }
.zr-tag-ok { background: rgba(95,178,54,.2); color: #3f8a1f; }
.zr-edit-label { font-size: 11px; font-weight: 600; color: var(--zr-muted); margin: 0 0 4px; }
.zr-edit-label:not(:first-child) { margin-top: 12px; }
.zr-card.zr-editing .zr-edit { font: 600 14px/1.45 system-ui, -apple-system, sans-serif; min-height: 56px; }
.zr-rich span[style*="background"] { border-radius: 2px; padding: 0 2px; }
.zr-rich-wrap { border: 1px solid var(--zr-border); border-radius: 6px; background: var(--zr-field); }
.zr-toolbar { display: flex; align-items: center; gap: 2px; padding: 3px 4px; border-bottom: 1px solid var(--zr-border); flex-wrap: wrap; }
.zr-tool { min-width: 24px; height: 24px; padding: 0 5px; border: 0; border-radius: 4px; background: none; color: var(--zr-fg); font: 13px/24px Georgia, serif; cursor: pointer; }
.zr-tool:hover { background: var(--zr-hover); }
.zr-tool-reset { margin-left: auto; font-family: system-ui, sans-serif; }
.zr-hl-icon { padding: 0 3px; background: #ffd400; color: #000; border-radius: 2px; font-family: system-ui, sans-serif; font-weight: 600; }
.zr-colors { display: inline-flex; gap: 3px; padding: 0 4px; align-items: center; }
.zr-colors[hidden] { display: none !important; }
.zr-color-dot { min-width: 16px; width: 16px; height: 16px; padding: 0; border-radius: 50%; border: 1px solid rgba(0,0,0,.2); }
.zr-color-none { font-family: system-ui, sans-serif; font-size: 12px; }
.zr-rich-edit { min-height: 110px; max-height: 50vh; overflow: auto; padding: 8px; outline: none; font: 13px/1.5 system-ui, sans-serif; color: var(--zr-fg); text-align: left; }
.zr-card-back.zr-rich { line-height: 1.5; }
.zr-input { width: 100%; padding: 6px 8px; border: 1px solid var(--zr-border); border-radius: 6px; background: var(--zr-field); color: var(--zr-fg); font: inherit; }
.zr-combo { position: relative; }
.zr-combo-list { position: absolute; left: 0; right: 0; top: calc(100% + 2px); z-index: 5; max-height: 220px; overflow: auto; padding: 4px; border: 1px solid var(--zr-border); border-radius: 6px; background: var(--zr-bg); box-shadow: 0 6px 18px rgba(0,0,0,.2); }
.zr-combo-list[hidden] { display: none !important; }
.zr-combo-item { padding: 4px 8px; border-radius: 4px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.zr-combo-item:hover, .zr-combo-item.active { background: var(--zr-accent); color: var(--zr-accent-fg); }
.zr-combo-item:hover .zr-combo-parent, .zr-combo-item.active .zr-combo-parent { color: inherit; opacity: .8; }
.zr-combo-item.current { font-weight: 600; }
.zr-combo-parent { color: var(--zr-muted); }
.zr-combo-empty { padding: 4px 8px; font-size: 12px; color: var(--zr-muted); }
.zr-deck-hint { margin-top: 4px; }
.zr-sent-row { display: block; width: 100%; text-align: left; padding: 8px 10px; margin-bottom: 6px; border: 1px solid var(--zr-border); border-radius: 8px; background: transparent; color: var(--zr-fg); font: inherit; cursor: pointer; }
.zr-sent-row:hover { background: var(--zr-hover); }
.zr-sent-q { font-weight: 600; margin-bottom: 3px; }
.zr-sent-row .zr-meta { font-size: 11px; color: var(--zr-muted); }
.zr-sent-row .zr-tag { margin-left: 0; }
`;
	},

	// ------------------------------------------------------------------
	// Reader hook: no toolbar button anymore (everything is in the sidebar
	// and in Strumenti → ZotRecall). The hook keeps the sidebar tab alive.
	// ------------------------------------------------------------------

	onRenderToolbar({ reader, doc }) {
		let root = doc.documentElement;
		if (root.hasAttribute('data-zotrecall')) return;
		root.setAttribute('data-zotrecall', '');
		this.injectStyle(doc);
		let win = doc.defaultView;
		let entry = { win, timer: null, doc };
		let stop = () => {
			try {
				win.clearInterval(entry.timer);
			}
			catch (e) {}
			this._timers.delete(entry);
		};
		let update = () => {
			if (win.closed || !doc.documentElement || !doc.documentElement.hasAttribute('data-zotrecall')) {
				stop();
				return;
			}
			try {
				ZotRecallSidebar.ensure(reader, doc);
				let popup = doc.getElementById('zotrecall-popup');
				if (popup && popup._zrRefresh) {
					let page = this.app.getCurrentPageIndex(reader);
					if (popup._zrPage !== page) popup._zrRefresh();
				}
			}
			catch (e) {}
		};
		win.addEventListener('unload', stop);
		entry.timer = win.setInterval(update, 1000);
		this._timers.add(entry);
		update();
	},

	openSidebar(reader) {
		if (!reader) return;
		let doc = reader._iframeWindow && reader._iframeWindow.document;
		if (doc && ZotRecallSidebar.ensure(reader, doc)) ZotRecallSidebar.activate(doc);
	},

	// ------------------------------------------------------------------
	// Floating window: centered, draggable by its header, resizable.
	// Lives in the reader document when a PDF is open, otherwise in the
	// main Zotero window.
	// ------------------------------------------------------------------

	_geometry: null,

	hostDocument(reader) {
		let doc = reader && reader._iframeWindow && reader._iframeWindow.document;
		if (doc && doc.documentElement) return doc;
		return Zotero.getMainWindow().document;
	},

	/**
	 * Open the window on a view.
	 * @param {string} view main | preview | generate | sent | export | trash | anki | settings
	 */
	open(reader, view = 'main', arg) {
		let doc = this.hostDocument(reader);
		this.injectStyle(doc);
		let popup = doc.getElementById('zotrecall-popup') || this.createWindow(doc);
		let views = {
			main: () => this.showMain(reader, doc, popup),
			preview: () => this.showPreview(reader, doc, popup, arg || 0),
			generate: () => this.startGeneration(reader, doc, popup, arg || {}),
			sent: () => this.showSent(reader, doc, popup),
			export: () => this.showExport(reader, doc, popup),
			trash: () => this.showTrash(reader, doc, popup),
			anki: () => this.showAnkiConfig(reader, doc, popup),
			settings: () => this.showSettings(reader, doc, popup),
		};
		let needsPDF = !['anki', 'settings'].includes(view);
		let attachment = reader && this.app.getAttachment(reader);
		if (needsPDF && (!attachment || !attachment.isPDFAttachment())) {
			this.setView(popup, this.header(doc, popup, 'ZotRecall'),
				this.h(doc, 'div', { class: 'zr-body' }, this.h(doc, 'p', { class: 'zr-note', text: 'Apri un PDF per usare questa funzione.' })));
			return popup;
		}
		(views[view] || views.main)();
		return popup;
	},

	createWindow(doc) {
		let popup = this.h(doc, 'div', { id: 'zotrecall-popup', class: 'preview-popup', role: 'dialog', tabindex: '-1' });
		let win = doc.defaultView;
		let onKey = (e) => {
			if (!popup.isConnected) return;
			if (e.key === 'Escape' && !popup._zrEditing) {
				close();
				return;
			}
			if (popup._zrKeys && popup.contains(e.target) && popup._zrKeys(e)) {
				e.preventDefault();
				e.stopPropagation();
			}
		};
		let offOutside = null;
		let close = () => {
			this.rememberGeometry(popup);
			popup.remove();
			if (offOutside) offOutside();
			doc.removeEventListener('keydown', onKey, true);
		};
		popup._zrClose = close;
		doc.addEventListener('keydown', onKey, true);
		if (this.app.getPref('closeOnOutsideClick')) offOutside = this.onOutsideClick(doc, popup, close);
		(doc.body || doc.documentElement).append(popup);

		// Geometry: last size and position, or centered
		let g = this._geometry;
		let W = win.innerWidth;
		let H = win.innerHeight;
		let width = Math.min(g ? g.width : 540, W - 16);
		let height = Math.min(g ? g.height : Math.round(H * 0.75), H - 16);
		popup.style.width = width + 'px';
		popup.style.height = height + 'px';
		let left = g ? Math.min(Math.max(8, g.left), W - width - 8) : Math.round((W - width) / 2);
		let top = g ? Math.min(Math.max(8, g.top), H - height - 8) : Math.round((H - height) / 2);
		popup.style.left = Math.max(8, left) + 'px';
		popup.style.top = Math.max(8, top) + 'px';

		// Keep Zotero's reader FocusManager from calling preventDefault() on pointerdown
		// inside our window (which otherwise blocks mousedown, drag and resize).
		popup.addEventListener('pointerdown', (e) => {
			e.stopPropagation();
			if (e.button !== 0) return;
			let r = popup.getBoundingClientRect();
			let inResizeCorner = (r.right - e.clientX <= 20) && (r.bottom - e.clientY <= 20)
				&& !(e.target.closest && e.target.closest('button, input, select, textarea, a, [contenteditable]'));
			let header = !inResizeCorner && e.target.closest && e.target.closest('.zr-header');
			if (header && e.target.closest('button, input, select, textarea, a')) header = null;
			if (!inResizeCorner && !header) return;

			e.preventDefault();
			try {
				popup.setPointerCapture(e.pointerId);
			}
			catch (err) {}
			let startX = e.clientX;
			let startY = e.clientY;
			let startLeft = r.left;
			let startTop = r.top;
			let startW = r.width;
			let startH = r.height;
			let move = (ev) => {
				if (inResizeCorner) {
					let w = Math.min(Math.max(340, startW + (ev.clientX - startX)), win.innerWidth - startLeft - 8);
					let h = Math.min(Math.max(220, startH + (ev.clientY - startY)), win.innerHeight - startTop - 8);
					popup.style.width = Math.round(w) + 'px';
					popup.style.height = Math.round(h) + 'px';
					if (popup._zrOnResize) popup._zrOnResize();
				}
				else {
					let nextLeft = Math.min(Math.max(0, startLeft + (ev.clientX - startX)), win.innerWidth - 60);
					let nextTop = Math.min(Math.max(0, startTop + (ev.clientY - startY)), win.innerHeight - 40);
					popup.style.left = Math.round(nextLeft) + 'px';
					popup.style.top = Math.round(nextTop) + 'px';
				}
			};
			let up = (ev) => {
				popup.removeEventListener('pointermove', move, true);
				popup.removeEventListener('pointerup', up, true);
				popup.removeEventListener('pointercancel', up, true);
				try {
					popup.releasePointerCapture(ev.pointerId);
				}
				catch (err) {}
				popup.classList.remove('zr-dragging');
				this.rememberGeometry(popup);
			};
			popup.classList.add('zr-dragging');
			popup.addEventListener('pointermove', move, true);
			popup.addEventListener('pointerup', up, true);
			popup.addEventListener('pointercancel', up, true);
		});
		popup.addEventListener('pointerup', () => this.rememberGeometry(popup));
		return popup;
	},

	rememberGeometry(popup) {
		if (!popup.isConnected) return;
		let r = popup.getBoundingClientRect();
		if (r.width && r.height) this._geometry = { left: r.left, top: r.top, width: r.width, height: r.height };
	},

	/**
	 * Call fn on a pointerdown outside el (and outside `except`). The PDF pages
	 * live in nested iframes, whose events never reach the reader document,
	 * so every iframe document and the main window are watched too.
	 * @returns {function} remove the listeners
	 */
	onOutsideClick(doc, el, fn, except = []) {
		let docs = new Set([doc]);
		let addFrames = (d, depth) => {
			if (depth > 3) return;
			for (let f of d.querySelectorAll('iframe, browser')) {
				try {
					let cd = f.contentDocument;
					if (cd && !docs.has(cd)) {
						docs.add(cd);
						addFrames(cd, depth + 1);
					}
				}
				catch (e) {}
			}
		};
		addFrames(doc, 0);
		try {
			let top = doc.defaultView.top.document;
			if (top) docs.add(top);
		}
		catch (e) {}
		let handler = (e) => {
			let t = e.target;
			if (t && (el.contains(t) || except.some(x => x && x.contains(t)))) return;
			fn();
		};
		for (let d of docs) d.addEventListener('pointerdown', handler, true);
		return () => {
			for (let d of docs) {
				try {
					d.removeEventListener('pointerdown', handler, true);
				}
				catch (e) {}
			}
		};
	},

	header(doc, popup, title, { onBack, actions = [] } = {}) {
		return this.h(doc, 'div', { class: 'zr-header' },
			onBack ? this.h(doc, 'button', { class: 'zr-icon-btn', title: 'Indietro', onclick: onBack }, this.svg(doc, this.ICONS.back, 18)) : null,
			this.h(doc, 'div', { class: 'zr-title', text: title }),
			...actions,
			this.h(doc, 'button', { class: 'zr-icon-btn', title: 'Chiudi', onclick: () => popup._zrClose() }, this.svg(doc, this.ICONS.close, 16)));
	},

	setView(popup, ...nodes) {
		popup._zrRefresh = null;
		popup._zrKeys = null;
		popup._zrOnResize = null;
		popup.replaceChildren(...nodes);
	},

	showMain(reader, doc, popup) {
		let attachment = this.app.getAttachment(reader);
		let gear = this.h(doc, 'button', { class: 'zr-icon-btn', title: 'Impostazioni', onclick: () => this.showSettings(reader, doc, popup) },
			this.svg(doc, this.ICONS.gear, 18));
		let discardedCount = 0;
		try {
			discardedCount = attachment && attachment.isPDFAttachment()
				? ZotRecallCore.discardedCards(this.app.loadStore(attachment)).length : 0;
		}
		catch (e) {}
		let trash = this.h(doc, 'button', {
			class: 'zr-icon-btn',
			title: 'Carte scartate',
			onclick: () => this.showTrash(reader, doc, popup),
		}, this.svg(doc, this.ICONS.trash, 18), discardedCount ? this.h(doc, 'span', { class: 'zr-count', text: String(discardedCount) }) : null);
		let body = this.h(doc, 'div', { class: 'zr-body' });
		this.setView(popup, this.header(doc, popup, 'ZotRecall', { actions: [trash, gear] }), body);

		if (!attachment || !attachment.isPDFAttachment()) {
			body.append(this.h(doc, 'p', { class: 'zr-note', text: 'ZotRecall funziona solo con i PDF.' }));
			return;
		}

		let render = () => {
			let page = this.app.getCurrentPageIndex(reader);
			popup._zrPage = page;
			let all = this.app.getAnnotations(attachment);
			let onPage = this.app.countPageHighlights(attachment, page);
			let store = this.app.loadStore(attachment);
			let active = ZotRecallCore.activeCards(store).length;
			let tags = ZotRecallCore.parseTags(this.app.getAnkiConfig().tags);
			let unsent = ZotRecallCore.unsentCards(store, tags).length;
			let sent = ZotRecallCore.sentCards(store).length;
			let notes = [];
			if (!this.app.getParent(attachment)) {
				notes.push(this.h(doc, 'p', { class: 'zr-error', text: this.app.NO_PARENT_MESSAGE }));
			}
			body.replaceChildren(
				this.action(doc, {
					label: 'Genera carte di questa pagina',
					sub: `Pagina ${page + 1} · evidenziazioni`,
					count: onPage,
					disabled: !onPage,
					onclick: () => this.startGeneration(reader, doc, popup, { pageIndex: page }),
				}),
				this.action(doc, {
					label: 'Genera carte di tutto il documento',
					sub: 'Solo i periodi senza carta, salvo tua scelta',
					count: all.length,
					disabled: !all.length,
					onclick: () => this.startGeneration(reader, doc, popup, {}),
				}),
				this.action(doc, {
					label: 'Anteprima e invio carte',
					sub: unsent ? 'Controlla, modifica e invia ad Anki una carta alla volta' : (active ? 'Tutte le carte sono già state inviate ad Anki' : 'Nessuna carta ancora'),
					count: unsent,
					disabled: !unsent,
					onclick: () => this.showPreview(reader, doc, popup),
				}),
				this.action(doc, {
					label: 'Esporta o invia in blocco',
					sub: active ? 'CSV, oppure tutte le carte nuove o modificate ad Anki' : 'Nessuna carta da esportare',
					disabled: !active,
					onclick: () => this.showExport(reader, doc, popup),
				}),
				this.action(doc, {
					label: 'Rivedi i periodi nella barra laterale',
					sub: 'Unisci, separa, aggiungi contesto o escludi prima di generare',
					onclick: () => {
						popup._zrClose();
						this.openSidebar(reader);
					},
				}),
				this.action(doc, {
					label: 'Carte inviate ad Anki',
					sub: 'Cosa è già in Anki e cosa è cambiato da allora',
					count: sent || undefined,
					disabled: !active,
					onclick: () => this.showSent(reader, doc, popup),
				}),
				this.action(doc, {
					label: 'Mazzo Anki',
					sub: 'Mazzo predefinito, tipo di nota, campi e tag',
					onclick: () => this.showAnkiConfig(reader, doc, popup),
				}),
				...notes,
			);
		};
		popup._zrRefresh = render;
		render();
	},

	action(doc, { label, sub, count, disabled, onclick }) {
		return this.h(doc, 'button', { class: 'zr-action', disabled: !!disabled, onclick },
			this.h(doc, 'span', { class: 'zr-label' }, label, sub ? this.h(doc, 'span', { class: 'zr-sub', text: sub }) : null),
			count !== undefined ? this.h(doc, 'span', { class: 'zr-pill', text: String(count) }) : null);
	},

	sentenceNode(doc, sentence) {
		let text = this.h(doc, 'div', { class: 'zr-text' });
		let pos = 0;
		for (let s of [...sentence.spans].sort((a, b) => a.start - b.start)) {
			if (s.start < pos) continue;
			text.append(doc.createTextNode(sentence.text.slice(pos, s.start)));
			text.append(this.h(doc, 'span', {
				style: {
					backgroundColor: s.color,
					color: ZotRecallCore.highlightTextColor(s.color),
					borderRadius: '2px',
					padding: '0 2px',
				},
				text: sentence.text.slice(s.start, s.end),
			}));
			pos = s.end;
		}
		text.append(doc.createTextNode(sentence.text.slice(pos)));
		return text;
	},

	// ------------------------------------------------------------------
	// Generation
	// ------------------------------------------------------------------

	/**
	 * Confirmation step before sending anything to the model.
	 * @param {Object} scope {pageIndex} for one page, {keys, label} for a selection, {} for the whole document
	 */
	async startGeneration(reader, doc, popup, scope = {}) {
		let h = this.h.bind(this);
		let label = scope.label
			|| (scope.pageIndex !== undefined && scope.pageIndex !== null ? `pagina ${scope.pageIndex + 1}` : 'tutto il documento');
		let body = h(doc, 'div', { class: 'zr-body' }, h(doc, 'p', { class: 'zr-note', text: 'Analisi delle evidenziazioni…' }));
		let back = () => this.showMain(reader, doc, popup);
		this.setView(popup, this.header(doc, popup, 'Genera carte · ' + label, { onBack: back }), body);
		let attachment = this.app.getAttachment(reader);
		let base;
		try {
			base = await this.app.plan(attachment, scope);
		}
		catch (e) {
			Zotero.logError(e);
			body.replaceChildren(h(doc, 'p', { class: 'zr-error', text: e.message || String(e) }));
			return;
		}
		let inScope = scope.keys ? new Set(scope.keys)
			: (scope.pageIndex !== undefined && scope.pageIndex !== null)
				? new Set(base.sentences.filter(s => s.pageIndex === scope.pageIndex).map(s => s.key))
				: null;
		let sentences = inScope ? base.sentences.filter(s => inScope.has(s.key)) : base.sentences;
		let cls = ZotRecallCore.classify(sentences, base.store);
		let excluded = new Set(ZotRecallCore.ensureReview(base.store).excluded);
		let notExcluded = list => list.filter(s => !excluded.has(s.key)).length;
		let changed = notExcluded(cls.changed);
		let discarded = notExcluded(cls.discarded);
		let excludedCount = sentences.filter(s => excluded.has(s.key)).length;

		let changedBox = h(doc, 'input', { type: 'checkbox' });
		let discardedBox = h(doc, 'input', { type: 'checkbox' });
		let summary = h(doc, 'p', { class: 'zr-confirm' });
		let go = h(doc, 'button', { class: 'zr-btn zr-primary', text: 'Genera' });
		let choice = () => ({ ...scope, includeChanged: changedBox.checked, includeDiscarded: discardedBox.checked });
		let token = 0;
		let update = async () => {
			let my = ++token;
			go.disabled = true;
			let p = await this.app.plan(attachment, choice());
			if (my !== token) return;
			let n = p.units;
			go.disabled = !n;
			let merged = p.groups.reduce((m, g) => m + g.units.filter(u => u.keys.length > 1).length, 0);
			summary.textContent = n
				? `Verranno inviati al modello ${n} ${n === 1 ? 'periodo' : 'periodi'} in ${p.groups.length} ${p.groups.length === 1 ? 'richiesta' : 'richieste'}`
					+ (merged ? ` (ogni gruppo di periodi uniti conta come uno). ` : '. ')
					+ `Il modello scrive da 1 a 4 domande per periodo, quindi avrai tra ${n} e ${n * 4} carte.`
				: 'Non c\'è niente da generare: tutti i periodi evidenziati hanno già una carta o sono esclusi.';
		};
		changedBox.addEventListener('change', update);
		discardedBox.addEventListener('change', update);

		let rows = [
			h(doc, 'p', { style: { margin: '0 0 10px' } },
				`${notExcluded(cls.fresh)} periodi nuovi · ${cls.unchanged.length} già con carta`
				+ (excludedCount ? ` · ${excludedCount} esclusi` : '')),
		];
		if (changed) {
			rows.push(h(doc, 'label', { class: 'zr-color-row' }, changedBox,
				`Rigenera anche i ${changed} periodi con evidenziazione cambiata`));
		}
		if (discarded) {
			rows.push(h(doc, 'label', { class: 'zr-color-row' }, discardedBox,
				`Rigenera anche i ${discarded} periodi delle carte scartate`));
		}
		if (base.unmatchedCount) {
			rows.push(h(doc, 'p', { class: 'zr-error', text: `${base.unmatchedCount} evidenziazioni non sono collegate al testo e verranno ignorate.` }));
		}
		go.addEventListener('click', () => this.runGeneration(reader, doc, popup, choice()));
		body.replaceChildren(...rows, summary,
			h(doc, 'div', { class: 'zr-footer' }, h(doc, 'button', { class: 'zr-btn', text: 'Annulla', onclick: back }), go));
		update();
	},

	/** Open the window straight on the confirmation step. */
	openGeneration(reader, doc, scope) {
		this.open(reader, 'generate', scope);
	},

	async runGeneration(reader, doc, popup, choice) {
		let h = this.h.bind(this);
		let cancelled = false;
		let bar = h(doc, 'div', { class: 'zr-bar' }, h(doc, 'div', { class: 'zr-bar-fill' }));
		let status = h(doc, 'p', { class: 'zr-note', text: 'Invio al modello…' });
		let cancel = h(doc, 'button', { class: 'zr-btn', text: 'Interrompi' });
		cancel.addEventListener('click', () => {
			cancelled = true;
			cancel.disabled = true;
			status.textContent = 'Interruzione dopo le richieste in corso…';
		});
		let body = h(doc, 'div', { class: 'zr-body' }, bar, status, h(doc, 'div', { class: 'zr-footer' }, cancel));
		this.setView(popup, this.header(doc, popup, 'Generazione in corso'), body);
		let attachment = this.app.getAttachment(reader);
		try {
			let res = await this.app.generate(attachment, {
				...choice,
				isCancelled: () => cancelled,
				onProgress: (done, total) => {
					bar.firstChild.style.width = (total ? Math.round(done / total * 100) : 100) + '%';
					if (!cancelled) status.textContent = `Paragrafi elaborati: ${done} di ${total}`;
				},
			});
			let lines = [h(doc, 'p', { class: res.created ? 'zr-ok' : 'zr-note', text: `${res.created} carte create.` })];
			if (res.skipped) lines.push(h(doc, 'p', { class: 'zr-note', text: `${res.skipped} periodi saltati dal modello perché troppo frammentari.` }));
			if (res.cancelled) lines.push(h(doc, 'p', { class: 'zr-note', text: 'Generazione interrotta.' }));
			if (res.failed.length) {
				lines.push(h(doc, 'p', { class: 'zr-error', text: `${res.failed.length} paragrafi non elaborati: ${res.failed[0].error}` }));
			}
			let actions = [h(doc, 'button', { class: 'zr-btn', text: 'Indietro', onclick: () => this.showMain(reader, doc, popup) })];
			if (res.created) {
				actions.push(h(doc, 'button', { class: 'zr-btn zr-primary', text: 'Anteprima', onclick: () => this.showPreview(reader, doc, popup) }));
			}
			body.replaceChildren(...lines, h(doc, 'div', { class: 'zr-footer' }, ...actions));
		}
		catch (e) {
			Zotero.logError(e);
			body.replaceChildren(h(doc, 'p', { class: 'zr-error', text: e.message || String(e) }),
				h(doc, 'div', { class: 'zr-footer' }, h(doc, 'button', { class: 'zr-btn', text: 'Indietro', onclick: () => this.showMain(reader, doc, popup) })));
		}
	},

	// ------------------------------------------------------------------
	// Preview (flashcards)
	// ------------------------------------------------------------------

	/**
	 * Review session: go through the cards, flip, edit front and back, discard,
	 * send each one to Anki.
	 * @param {number|{cardID, fromSent}} start index or card to start from
	 */
	showPreview(reader, doc, popup, start = 0) {
		let h = this.h.bind(this);
		let attachment = this.app.getAttachment(reader);
		let store = this.app.loadStore(attachment);
		let cfg = this.app.getAnkiConfig();
		let tags = ZotRecallCore.parseTags(cfg.tags);
		let fromSent = Boolean(start && typeof start === 'object' && start.fromSent);
		let allActive = ZotRecallCore.activeCards(store);
		let initialCards = fromSent
			? ZotRecallCore.sentCards(store)
			: ZotRecallCore.unsentCards(store, tags);
		if (start && typeof start === 'object' && start.cardID && !initialCards.some(c => c.id === start.cardID)) {
			let target = allActive.find(c => c.id === start.cardID);
			if (target) initialCards = [target, ...initialCards];
		}
		let sessionIDs = new Set(initialCards.map(c => c.id));
		let cards = initialCards;
		let index = typeof start === 'object' && start
			? Math.max(0, cards.findIndex(c => c.id === start.cardID))
			: Math.max(0, Math.min(start || 0, cards.length - 1));
		let flipped = false;
		let editing = false;
		let sending = false;
		let orphans = new Set();
		let message = h(doc, 'p', { class: 'zr-note', hidden: true });
		let body = h(doc, 'div', { class: 'zr-body' });
		let deckLink = h(doc, 'button', {
			class: 'zr-link zr-deck-link',
			title: 'Mazzo, tipo di nota e tag usati da "Invia"',
			onclick: () => this.showAnkiConfig(reader, doc, popup, () => this.showPreview(reader, doc, popup, { cardID: cards[index] && cards[index].id, fromSent })),
		}, cfg.deck ? '→ ' + cfg.deck : 'Scegli il mazzo');
		let onBack = fromSent ? () => this.showSent(reader, doc, popup) : () => this.showMain(reader, doc, popup);
		this.setView(popup, this.header(doc, popup, 'Anteprima e invio', { onBack, actions: [deckLink] }), body);

		this.app.extract(attachment).then(({ sentences }) => {
			orphans = new Set(ZotRecallCore.orphanKeys(store, sentences));
			if (orphans.size && popup.isConnected && !editing) render();
		}).catch(e => Zotero.logError(e));

		let say = (text, kind = 'note') => {
			message.className = 'zr-' + kind;
			message.textContent = text;
			message.hidden = !text;
		};
		let save = async () => {
			try {
				await this.app.saveStore(attachment, store);
			}
			catch (e) {
				Zotero.logError(e);
				say(e.message || String(e), 'error');
			}
		};
		let reload = (cardID) => {
			store = this.app.loadStore(attachment);
			allActive = ZotRecallCore.activeCards(store);
			cards = allActive.filter(c => sessionIDs.has(c.id));
			let i = cards.findIndex(c => c.id === cardID);
			index = i >= 0 ? i : Math.min(index, cards.length - 1);
		};
		let move = (delta) => {
			index = Math.max(0, Math.min(cards.length - 1, index + delta));
			flipped = false;
			say('');
			render();
		};
		let send = async (card) => {
			let err = this.app.ankiConfigError(cfg);
			if (err) {
				say(err, 'error');
				return;
			}
			sending = true;
			render();
			try {
				let res = await this.app.sendToAnki(attachment, { cardIDs: [card.id], cfg });
				reload(card.id);
				if (res.failed.length) say(res.failed[0], 'error');
				else say(res.added ? `Inviata a ${cfg.deck}.` : res.updated ? 'Aggiornata in Anki.' : 'Già in Anki, identica.', 'ok');
			}
			catch (e) {
				Zotero.logError(e);
				say(e.message || String(e), 'error');
			}
			sending = false;
			render();
		};

		let render = () => {
			popup._zrEditing = editing;
			if (!cards.length) {
				popup._zrOnResize = null;
				if (allActive.length) {
					body.replaceChildren(
						h(doc, 'p', { class: 'zr-note', text: 'Tutte le carte attive sono già state inviate ad Anki.' }),
						h(doc, 'div', { class: 'zr-footer' },
							h(doc, 'button', { class: 'zr-btn', text: 'Carte inviate ad Anki…', onclick: () => this.showSent(reader, doc, popup) })),
						message);
				}
				else {
					body.replaceChildren(h(doc, 'p', { class: 'zr-note', text: 'Nessuna carta attiva.' }), message);
				}
				return;
			}
			let card = cards[index];
			let isOrphan = card.sentenceKeys.some(k => orphans.has(k));
			let state = ZotRecallCore.ankiState(store, card, tags);
			let face;
			let editor = null;
			let questionBox = null;
			let fitQuestion = null;
			if (editing) {
				questionBox = h(doc, 'textarea', { class: 'zr-edit', rows: '1' });
				questionBox.value = card.question;
				fitQuestion = () => {
					if (!questionBox || !questionBox.isConnected) return;
					questionBox.style.height = 'auto';
					let sh = questionBox.scrollHeight;
					if (sh > 0) questionBox.style.height = Math.max(56, sh + 4) + 'px';
				};
				questionBox.addEventListener('input', fitQuestion);
				editor = this.richEditor(doc, ZotRecallCore.backHTML(store, card), {
					onReset: () => ZotRecallCore.backHTML(store, Object.assign({}, card, { back: undefined })),
				});
				face = h(doc, 'div', { class: 'zr-card zr-editing' },
					h(doc, 'div', { class: 'zr-edit-label', text: 'Domanda' }), questionBox,
					h(doc, 'div', { class: 'zr-edit-label', text: 'Risposta' }), editor.node);
			}
			else {
				face = h(doc, 'div', { class: 'zr-card', tabindex: '0', title: 'Clic o spazio per girare' },
					h(doc, 'div', { class: 'zr-card-q', text: card.question }));
				if (flipped) {
					let back = h(doc, 'div', { class: 'zr-card-back zr-rich' });
					back.innerHTML = this.sanitizeHTML(doc, ZotRecallCore.backHTML(store, card));
					face.append(back);
				}
				face.addEventListener('click', () => {
					flipped = !flipped;
					render();
				});
			}
			let pageLink = h(doc, 'button', { class: 'zr-link', text: `pag. ${(card.pageIndex ?? 0) + 1}`, title: 'Vai alla pagina' });
			pageLink.addEventListener('click', () => {
				try {
					reader.navigate({ pageIndex: card.pageIndex });
				}
				catch (e) {
					Zotero.logError(e);
				}
			});
			let badges = [];
			if (state === 'sent') badges.push(h(doc, 'span', { class: 'zr-tag zr-tag-ok', text: 'in Anki', title: card.ankiDeck ? 'Mazzo: ' + card.ankiDeck : null }));
			if (state === 'changed') badges.push(h(doc, 'span', { class: 'zr-tag zr-tag-warn', text: 'cambiata dopo l\'invio' }));
			if (card.edited) badges.push(h(doc, 'span', { class: 'zr-tag', text: 'modificata' }));
			if (isOrphan) badges.push(h(doc, 'span', { class: 'zr-tag zr-tag-warn', text: 'orfana', title: 'Il periodo non è più evidenziato' }));

			let actions;
			if (editing) {
				let cancel = h(doc, 'button', { class: 'zr-btn', text: 'Annulla', onclick: () => {
					editing = false;
					render();
				} });
				let ok = h(doc, 'button', { class: 'zr-btn zr-primary', text: 'Salva' });
				ok.addEventListener('click', async () => {
					let text = questionBox.value.trim();
					if (!text) return;
					let original = ZotRecallCore.backHTML(store, Object.assign({}, card, { back: undefined }));
					let back = this.sanitizeHTML(doc, editor.getHTML());
					ZotRecallCore.editCard(store, card.id, text, back === this.sanitizeHTML(doc, original) ? null : back);
					editing = false;
					render();
					await save();
				});
				actions = h(doc, 'div', { class: 'zr-footer' }, cancel, ok);
			}
			else {
				let sendLabel = sending ? 'Invio…' : state === 'sent' ? 'Inviata ✓' : state === 'changed' ? 'Aggiorna' : 'Invia';
				let sendBtn = h(doc, 'button', {
					class: 'zr-btn zr-primary',
					text: sendLabel,
					disabled: sending || state === 'sent',
					title: state === 'sent' ? 'Questa carta è già in Anki, identica' : state === 'changed' ? 'Aggiorna la nota già in Anki' : 'Invia questa carta ad Anki',
					onclick: () => send(card),
				});
				actions = h(doc, 'div', { class: 'zr-footer zr-session' },
					h(doc, 'button', { class: 'zr-btn', text: '←', title: 'Precedente (←)', disabled: index === 0, onclick: () => move(-1) }),
					h(doc, 'div', { class: 'zr-row zr-wrap' },
						h(doc, 'button', { class: 'zr-btn', text: 'Modifica', onclick: () => {
							editing = true;
							say('');
							render();
						} }),
						h(doc, 'button', { class: 'zr-btn zr-danger', text: 'Scarta', onclick: async () => {
							ZotRecallCore.setCardStatus(store, card.id, 'discarded');
							sessionIDs.delete(card.id);
							cards.splice(index, 1);
							allActive = ZotRecallCore.activeCards(store);
							index = Math.min(index, cards.length - 1);
							flipped = false;
							say(card.ankiNoteId ? 'Scartata. La nota già in Anki non viene toccata.' : '');
							render();
							await save();
						} }),
						h(doc, 'button', { class: 'zr-btn', text: flipped ? 'Domanda' : 'Gira', onclick: () => {
							flipped = !flipped;
							render();
						} }),
						sendBtn),
					h(doc, 'button', { class: 'zr-btn', text: '→', title: 'Successiva (→)', disabled: index === cards.length - 1, onclick: () => move(1) }));
			}
			let sentCount = cards.filter(c => ZotRecallCore.ankiState(store, c, tags) === 'sent').length;
			body.replaceChildren(
				h(doc, 'div', { class: 'zr-meta-row' },
					h(doc, 'span', {}, `${index + 1} di ${cards.length} `, ...badges),
					pageLink),
				face,
				actions,
				message,
				h(doc, 'p', { class: 'zr-note zr-center', text: `${sentCount} di ${cards.length} già in Anki · spazio gira, ← → per scorrere` }));
			popup._zrOnResize = fitQuestion;
			if (editing) {
				fitQuestion();
				try {
					doc.defaultView.requestAnimationFrame(fitQuestion);
				}
				catch (e) {}
				questionBox.focus();
			}
			else {
				face.focus();
			}
		};
		popup._zrKeys = (e) => {
			if (!cards.length || editing || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable) return false;
			if (e.key === ' ') {
				flipped = !flipped;
				render();
			}
			else if (e.key === 'ArrowRight') move(1);
			else if (e.key === 'ArrowLeft') move(-1);
			else return false;
			return true;
		};
		render();
	},

	/**
	 * Minimal rich text editor: bold, italic, underline, highlight colors
	 * (hidden until needed), reset to the original back.
	 * @returns {{node, getHTML}}
	 */
	richEditor(doc, html, { onReset } = {}) {
		let h = this.h.bind(this);
		let area = h(doc, 'div', { class: 'zr-rich zr-rich-edit', contenteditable: 'true', spellcheck: 'false' });
		area.innerHTML = this.sanitizeHTML(doc, html);
		let exec = (cmd, value = null, css = false) => {
			area.focus();
			try {
				doc.execCommand('styleWithCSS', false, css);
			}
			catch (e) {}
			doc.execCommand(cmd, false, value);
		};
		// Keep the selection when clicking toolbar buttons
		let tool = (label, title, fn, cls = '') => h(doc, 'button', {
			class: 'zr-tool ' + cls,
			title,
			type: 'button',
			onmousedown: e => e.preventDefault(),
			onclick: fn,
		}, label);
		// Highlight by wrapping the selection: same result in every engine
		let clearHighlightStyle = (sp) => {
			sp.style.backgroundColor = '';
			sp.style.color = '';
			sp.style.borderRadius = '';
			sp.style.padding = '';
		};
		let highlight = (color) => {
			let sel = doc.getSelection();
			if (!sel || !sel.rangeCount) return;
			let r = sel.getRangeAt(0);
			if (r.collapsed || !area.contains(r.commonAncestorContainer)) return;
			let ancEl = r.commonAncestorContainer.nodeType === 1
				? r.commonAncestorContainer
				: r.commonAncestorContainer.parentElement;
			let ancSpan = ancEl && ancEl.closest && ancEl.closest('span');
			if (!color && ancSpan && area.contains(ancSpan) && ancSpan.style.backgroundColor) {
				let afterRange = doc.createRange();
				afterRange.setStart(r.endContainer, r.endOffset);
				afterRange.setEndAfter(ancSpan.lastChild || ancSpan);
				let tailFrag = afterRange.extractContents();
				let midFrag = r.extractContents();
				midFrag.querySelectorAll('span').forEach(clearHighlightStyle);
				if (tailFrag.textContent) {
					let tailSpan = ancSpan.cloneNode(false);
					tailSpan.append(tailFrag);
					ancSpan.after(tailSpan);
				}
				ancSpan.after(midFrag);
				if (!ancSpan.textContent) ancSpan.remove();
				area.focus();
				return;
			}
			let frag = r.extractContents();
			frag.querySelectorAll('span').forEach(clearHighlightStyle);
			let node = frag;
			if (color) {
				node = doc.createElement('span');
				node.style.backgroundColor = color;
				node.style.color = ZotRecallCore.highlightTextColor(color);
				node.style.borderRadius = '2px';
				node.style.padding = '0 2px';
				node.append(frag);
			}
			let last = node.lastChild;
			r.insertNode(node);
			sel.removeAllRanges();
			let after = doc.createRange();
			if (color) after.selectNodeContents(node);
			else if (last) after.setStartAfter(last);
			sel.addRange(after);
			area.focus();
		};
		let colors = h(doc, 'div', { class: 'zr-colors', hidden: true },
			...ZotRecallCore.ZOTERO_COLORS.map(c => tool('', c.name, () => {
				highlight(c.hex);
				colors.hidden = true;
			}, 'zr-color-dot')),
			tool('⌀', 'Togli evidenziazione', () => {
				highlight(null);
				colors.hidden = true;
			}, 'zr-color-none'));
		ZotRecallCore.ZOTERO_COLORS.forEach((c, i) => {
			colors.children[i].style.backgroundColor = c.hex;
		});
		let bar = h(doc, 'div', { class: 'zr-toolbar' },
			tool(h(doc, 'b', { text: 'B' }), 'Grassetto (⌘B)', () => exec('bold')),
			tool(h(doc, 'i', { text: 'I' }), 'Corsivo (⌘I)', () => exec('italic')),
			tool(h(doc, 'u', { text: 'U' }), 'Sottolineato (⌘U)', () => exec('underline')),
			tool(h(doc, 'span', { class: 'zr-hl-icon', text: 'A' }), 'Evidenzia', () => {
				colors.hidden = !colors.hidden;
			}),
			colors,
			onReset ? tool('↺', 'Ripristina il periodo originale', () => {
				area.innerHTML = this.sanitizeHTML(doc, onReset());
			}, 'zr-tool-reset') : null);
		return {
			node: h(doc, 'div', { class: 'zr-rich-wrap' }, bar, area),
			getHTML: () => ZotRecallCore.ensureHighlightContrast(area.innerHTML),
		};
	},

	/**
	 * Keep only simple formatting: b, i, u, br, div and spans with a
	 * background color or basic font styles. Everything else is unwrapped.
	 */
	sanitizeHTML(doc, html) {
		let tpl = doc.createElement('template');
		tpl.innerHTML = String(html || '');
		let out = doc.createElement('div');
		let ALLOWED = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', BR: 'br', DIV: 'div', P: 'div', SPAN: 'span' };
		let walk = (src, dst) => {
			for (let n of Array.from(src.childNodes)) {
				if (n.nodeType === 3) {
					dst.append(doc.createTextNode(n.textContent));
					continue;
				}
				if (n.nodeType !== 1) continue;
				let tag = ALLOWED[n.tagName.toUpperCase()];
				if (!tag) {
					walk(n, dst);
					continue;
				}
				let el = doc.createElement(tag);
				if (tag === 'span') {
					let st = n.style;
					let bg = st.backgroundColor;
					if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)/.test(bg)) {
						el.style.backgroundColor = bg;
						el.style.color = ZotRecallCore.highlightTextColor(bg);
						el.style.borderRadius = '2px';
						el.style.padding = '0 2px';
					}
					if (/bold|[6-9]00/.test(st.fontWeight)) el.style.fontWeight = 'bold';
					if (st.fontStyle === 'italic') el.style.fontStyle = 'italic';
					if (/underline/.test(st.textDecoration || st.textDecorationLine || '')) el.style.textDecoration = 'underline';
					if (!el.getAttribute('style')) {
						walk(n, dst);
						continue;
					}
				}
				walk(n, el);
				dst.append(el);
			}
		};
		walk(tpl.content, out);
		return out.innerHTML;
	},

	// ------------------------------------------------------------------
	// Trash
	// ------------------------------------------------------------------

	showTrash(reader, doc, popup) {
		let h = this.h.bind(this);
		let attachment = this.app.getAttachment(reader);
		let store = this.app.loadStore(attachment);
		let error = h(doc, 'p', { class: 'zr-error', hidden: true });
		let body = h(doc, 'div', { class: 'zr-body' });
		this.setView(popup, this.header(doc, popup, 'Carte scartate', { onBack: () => this.showMain(reader, doc, popup) }), body);

		let save = async () => {
			try {
				await this.app.saveStore(attachment, store);
				error.hidden = true;
			}
			catch (e) {
				Zotero.logError(e);
				error.textContent = e.message || String(e);
				error.hidden = false;
			}
		};

		let render = () => {
			let cards = ZotRecallCore.discardedCards(store);
			if (!cards.length) {
				body.replaceChildren(h(doc, 'p', { class: 'zr-note', text: 'Il cestino è vuoto.' }), error);
				return;
			}
			let rows = cards.map((card) => {
				let restore = h(doc, 'button', { class: 'zr-btn', text: 'Ripristina' });
				restore.addEventListener('click', async () => {
					ZotRecallCore.setCardStatus(store, card.id, 'active');
					render();
					await save();
				});
				let del = h(doc, 'button', { class: 'zr-btn zr-danger', text: 'Elimina' });
				del.addEventListener('click', async () => {
					ZotRecallCore.deleteCard(store, card.id);
					render();
					await save();
				});
				return h(doc, 'div', { class: 'zr-sentence' },
					h(doc, 'div', { class: 'zr-meta', text: `pag. ${(card.pageIndex ?? 0) + 1}` }),
					h(doc, 'div', { class: 'zr-trash-q', text: card.question }),
					h(doc, 'div', { class: 'zr-row', style: { justifyContent: 'flex-end', marginTop: '6px' } }, restore, del));
			});
			let empty = h(doc, 'button', { class: 'zr-btn zr-danger', text: `Svuota cestino (${cards.length})` });
			let confirming = false;
			empty.addEventListener('click', async () => {
				if (!confirming) {
					confirming = true;
					empty.textContent = 'Conferma: elimina definitivamente';
					return;
				}
				ZotRecallCore.emptyTrash(store);
				render();
				await save();
			});
			body.replaceChildren(
				h(doc, 'p', { class: 'zr-note', style: { marginTop: '0' }, text: 'Le carte scartate non vengono esportate. Le evidenziazioni nel PDF restano come sono.' }),
				...rows,
				h(doc, 'div', { class: 'zr-footer' }, empty),
				error);
		};
		render();
	},

	// ------------------------------------------------------------------
	// Anki: deck form, export / batch send, sent cards
	// ------------------------------------------------------------------

	/**
	 * Deck (pick from the list or type a new "Parent::Child" path), note type,
	 * fields and tags. Starts from the saved default.
	 * @returns {Promise<{node, getCfg, isNewDeck, onChange}>}
	 */
	async ankiForm(doc) {
		let h = this.h.bind(this);
		let cfg = this.app.getAnkiConfig();
		let options = await this.app.ankiOptions();
		let listeners = [];
		let changed = () => listeners.forEach(fn => fn());

		// Deck autocomplete input (no toggle arrow; dropdown appears automatically as user types)
		let deckInput = h(doc, 'input', {
			type: 'text',
			class: 'zr-input',
			placeholder: 'Inizia a digitare il nome di un mazzo (es. Mazzo::Sottomazzo)…',
			autocomplete: 'off',
			spellcheck: 'false',
		});
		deckInput.value = cfg.deck || '';
		let list = h(doc, 'div', { class: 'zr-combo-list', hidden: true, role: 'listbox' });
		let matches = [];
		let activeIndex = -1;
		let selectDeck = (d) => {
			deckInput.value = d;
			list.hidden = true;
			matches = [];
			activeIndex = -1;
			deckInput.focus();
			try {
				deckInput.setSelectionRange(d.length, d.length);
			}
			catch (e) {}
			changed();
		};
		let setActive = (idx, scroll = true) => {
			if (!matches.length) {
				activeIndex = -1;
				return;
			}
			activeIndex = ((idx % matches.length) + matches.length) % matches.length;
			let children = Array.from(list.children);
			children.forEach((el, i) => {
				el.classList.toggle('active', i === activeIndex);
				if (i === activeIndex && scroll && el.scrollIntoView) {
					el.scrollIntoView({ block: 'nearest' });
				}
			});
		};
		let fill = (filter) => {
			let q = String(filter || '').trim().toLowerCase();
			if (!q) {
				matches = [];
				activeIndex = -1;
				list.replaceChildren();
				list.hidden = true;
				return;
			}
			let prefix = [];
			let contains = [];
			for (let d of options.decks) {
				let dl = d.toLowerCase();
				if (dl.startsWith(q)) prefix.push(d);
				else if (dl.includes(q)) contains.push(d);
			}
			matches = prefix.concat(contains).slice(0, 200);
			if (!matches.length) {
				activeIndex = -1;
				list.replaceChildren();
				list.hidden = true;
				return;
			}
			activeIndex = 0;
			list.replaceChildren(...matches.map((d, idx) => h(doc, 'div', {
				class: 'zr-combo-item' + (idx === activeIndex ? ' active' : '') + (d === deckInput.value.trim() ? ' current' : ''),
				role: 'option',
				onpointerenter: () => setActive(idx, false),
				onpointerdown: (e) => {
					e.preventDefault();
					e.stopPropagation();
					selectDeck(d);
				},
				onclick: (e) => {
					e.preventDefault();
					e.stopPropagation();
					selectDeck(d);
				},
			}, ...d.split('::').flatMap((part, i, all) => i < all.length - 1
				? [h(doc, 'span', { class: 'zr-combo-parent', text: part + '::' })]
				: [part]))));
			list.hidden = false;
		};
		deckInput.addEventListener('input', () => {
			fill(deckInput.value);
			changed();
		});
		deckInput.addEventListener('blur', () => {
			list.hidden = true;
		});
		deckInput.addEventListener('keydown', (e) => {
			if (!list.hidden && matches.length) {
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					e.stopPropagation();
					setActive(activeIndex + 1);
					return;
				}
				if (e.key === 'ArrowUp') {
					e.preventDefault();
					e.stopPropagation();
					setActive(activeIndex - 1);
					return;
				}
				if (e.key === 'Enter' && activeIndex >= 0 && activeIndex < matches.length) {
					e.preventDefault();
					e.stopPropagation();
					selectDeck(matches[activeIndex]);
					return;
				}
			}
			if (e.key === 'Escape' && !list.hidden) {
				e.preventDefault();
				e.stopPropagation();
				list.hidden = true;
			}
		});
		let deckHint = h(doc, 'p', { class: 'zr-note zr-deck-hint', hidden: true });

		// Note type and fields
		let defaultModel = options.models.includes(cfg.model) ? cfg.model
			: (options.models.find(m => /^(basic|base)$/i.test(m)) || options.models[0]);
		let modelSel = h(doc, 'select', { class: 'zr-select' },
			...options.models.map(m => h(doc, 'option', { value: m, text: m, selected: m === defaultModel })));
		let frontSel = h(doc, 'select', { class: 'zr-select' });
		let backSel = h(doc, 'select', { class: 'zr-select' });
		let loadFields = async () => {
			let fields = [];
			try {
				fields = await this.app.ankiFields(modelSel.value);
			}
			catch (e) {
				Zotero.logError(e);
			}
			let pick = (sel, preferred, fallbackIndex) => {
				let value = fields.includes(preferred) ? preferred : fields[Math.min(fallbackIndex, fields.length - 1)];
				sel.replaceChildren(...fields.map(f => h(doc, 'option', { value: f, text: f, selected: f === value })));
			};
			pick(frontSel, cfg.front, 0);
			pick(backSel, cfg.back, 1);
			changed();
		};
		modelSel.addEventListener('change', loadFields);
		frontSel.addEventListener('change', changed);
		backSel.addEventListener('change', changed);
		await loadFields();

		let tagsInput = h(doc, 'input', { type: 'text', class: 'zr-input', placeholder: 'Nessun tag (es. patologia::emostasi zotrecall)', spellcheck: 'false' });
		tagsInput.value = cfg.tags || '';
		tagsInput.addEventListener('input', changed);

		let isNewDeck = () => {
			let d = deckInput.value.trim();
			return !!d && !options.decks.includes(d);
		};
		listeners.push(() => {
			let d = deckInput.value.trim();
			deckHint.hidden = !isNewDeck();
			if (isNewDeck()) {
				let parts = d.split('::');
				let parent = parts.slice(0, -1).join('::');
				deckHint.textContent = parts.some(p => !p.trim())
					? 'Nome non valido: usa "Mazzo genitore::Mazzo figlio".'
					: `Nuovo mazzo "${parts[parts.length - 1]}"` + (parent ? ` dentro "${parent}"` : '') + '.';
			}
		});
		changed();

		let field = (label, ...input) => h(doc, 'label', { class: 'zr-field' }, h(doc, 'span', { text: label }), ...input);
		let node = h(doc, 'div', {},
			h(doc, 'div', { class: 'zr-field' }, h(doc, 'span', { text: 'Mazzo' }),
				h(doc, 'div', { class: 'zr-combo' }, deckInput, list),
				deckHint),
			field('Tipo di nota', modelSel),
			h(doc, 'div', { class: 'zr-row', style: { alignItems: 'flex-start' } },
				h(doc, 'div', { style: { flex: '1' } }, field('Campo fronte', frontSel)),
				h(doc, 'div', { style: { flex: '1' } }, field('Campo retro', backSel))),
			field('Tag', tagsInput),
			h(doc, 'p', { class: 'zr-note', style: { marginTop: '-6px' }, text: 'Separati da spazi, "::" per i tag figli. Vuoto per nessun tag.' }));
		return {
			node,
			getCfg: () => ({
				deck: deckInput.value.trim(),
				model: modelSel.value,
				front: frontSel.value,
				back: backSel.value,
				tags: tagsInput.value,
			}),
			isNewDeck,
			onChange: fn => listeners.push(fn),
			addDeck: (d) => {
				if (!options.decks.includes(d)) options.decks.push(d);
				changed();
			},
		};
	},

	ankiUnavailable(doc, e) {
		return this.h(doc, 'p', { class: 'zr-error', text: (e.message || String(e)) + '\nControlla che Anki sia aperto e l\'indirizzo di AnkiConnect nelle impostazioni.' });
	},

	/** Default deck, note type, fields and tags (Strumenti → ZotRecall → Mazzo Anki). */
	async showAnkiConfig(reader, doc, popup, onDone = null) {
		let h = this.h.bind(this);
		let back = onDone || (() => (reader ? this.showMain(reader, doc, popup) : popup._zrClose()));
		let body = h(doc, 'div', { class: 'zr-body' }, h(doc, 'p', { class: 'zr-note', text: 'Connessione ad Anki…' }));
		this.setView(popup, this.header(doc, popup, 'Mazzo Anki', { onBack: back }), body);
		let form;
		try {
			form = await this.ankiForm(doc);
		}
		catch (e) {
			body.replaceChildren(this.ankiUnavailable(doc, e));
			return;
		}
		let status = h(doc, 'p', { class: 'zr-note', hidden: true });
		let saveBtn = h(doc, 'button', { class: 'zr-btn zr-primary' });
		let update = () => {
			saveBtn.textContent = form.isNewDeck() ? 'Crea mazzo e salva' : 'Salva come predefinito';
		};
		form.onChange(update);
		update();
		saveBtn.addEventListener('click', async () => {
			let cfg = form.getCfg();
			let err = this.app.ankiConfigError(cfg);
			if (err) {
				status.className = 'zr-error';
				status.textContent = err;
				status.hidden = false;
				return;
			}
			try {
				if (form.isNewDeck()) {
					await this.app.createDeck(cfg.deck);
					form.addDeck(cfg.deck);
				}
				this.app.saveAnkiConfig(cfg);
				status.className = 'zr-ok';
				status.textContent = `Salvato. "Invia" userà il mazzo "${cfg.deck}".`;
				status.hidden = false;
				if (onDone) onDone();
			}
			catch (e) {
				Zotero.logError(e);
				status.className = 'zr-error';
				status.textContent = e.message || String(e);
				status.hidden = false;
			}
		});
		body.replaceChildren(
			h(doc, 'p', { class: 'zr-note', style: { margin: '0 0 12px' }, text: 'Usato dal bottone "Invia" dell\'anteprima e dall\'invio in blocco.' }),
			form.node,
			h(doc, 'div', { class: 'zr-footer' }, saveBtn),
			status);
	},

	/** CSV export and batch send to Anki (only new or changed cards). */
	async showExport(reader, doc, popup) {
		let h = this.h.bind(this);
		let attachment = this.app.getAttachment(reader);
		let store = this.app.loadStore(attachment);
		let count = ZotRecallCore.activeCards(store).length;
		let back = () => this.showMain(reader, doc, popup);
		let csvStatus = h(doc, 'p', { class: 'zr-note' });
		let csvBtn = h(doc, 'button', { class: 'zr-btn', text: 'Salva CSV…' });
		csvBtn.addEventListener('click', async () => {
			try {
				let res = await this.app.exportCSV(reader, attachment);
				if (res) {
					csvStatus.className = 'zr-ok';
					csvStatus.textContent = `${res.count} carte salvate. In Anki, durante l'importazione, attiva "Consenti HTML".`;
				}
			}
			catch (e) {
				Zotero.logError(e);
				csvStatus.className = 'zr-error';
				csvStatus.textContent = e.message || String(e);
			}
		});

		let ankiBox = h(doc, 'div', {}, h(doc, 'p', { class: 'zr-note', text: 'Connessione ad Anki…' }));
		let body = h(doc, 'div', { class: 'zr-body' },
			h(doc, 'p', { style: { margin: '0 0 4px' }, text: `${count} carte attive.` }),
			h(doc, 'div', { class: 'zr-section', text: 'CSV' }),
			h(doc, 'p', { class: 'zr-note', style: { marginTop: '0' }, text: 'Due colonne (fronte, retro), senza intestazione, in HTML.' }),
			h(doc, 'div', { class: 'zr-row', style: { marginTop: '8px' } }, csvBtn),
			csvStatus,
			h(doc, 'div', { class: 'zr-section', text: 'Anki (AnkiConnect)' }),
			ankiBox);
		this.setView(popup, this.header(doc, popup, 'Esporta o invia in blocco', { onBack: back }), body);

		let form;
		try {
			form = await this.ankiForm(doc);
		}
		catch (e) {
			ankiBox.replaceChildren(this.ankiUnavailable(doc, e));
			return;
		}
		let summary = h(doc, 'p', { class: 'zr-note', style: { marginTop: '0' } });
		let status = h(doc, 'p', { class: 'zr-note' });
		let bar = h(doc, 'div', { class: 'zr-bar', hidden: true }, h(doc, 'div', { class: 'zr-bar-fill' }));
		let sendBtn = h(doc, 'button', { class: 'zr-btn zr-primary' });
		let saveBtn = h(doc, 'button', { class: 'zr-btn' });
		let pending = 0;
		let update = () => {
			let cfg = form.getCfg();
			let tags = ZotRecallCore.parseTags(cfg.tags);
			let cards = ZotRecallCore.activeCards(store);
			let n = { new: 0, changed: 0, sent: 0 };
			cards.forEach(c => n[ZotRecallCore.ankiState(store, c, tags)]++);
			pending = n.new + n.changed;
			summary.textContent = `${n.new} nuove · ${n.changed} cambiate dopo l'invio · ${n.sent} già in Anki, identiche (saltate).`;
			let isNew = form.isNewDeck();
			sendBtn.textContent = (isNew ? 'Crea mazzo e invia' : 'Invia') + (pending ? ` ${pending} carte` : '');
			sendBtn.disabled = !pending;
			saveBtn.textContent = isNew ? 'Crea mazzo e salva' : 'Salva come predefinito';
		};
		form.onChange(update);
		update();
		let fail = (e) => {
			Zotero.logError(e);
			status.className = 'zr-error';
			status.textContent = e.message || String(e);
		};
		saveBtn.addEventListener('click', async () => {
			let cfg = form.getCfg();
			let err = this.app.ankiConfigError(cfg);
			if (err) return fail(new Error(err));
			try {
				if (form.isNewDeck()) {
					await this.app.createDeck(cfg.deck);
					form.addDeck(cfg.deck);
				}
				this.app.saveAnkiConfig(cfg);
				status.className = 'zr-ok';
				status.textContent = `"${cfg.deck}" è ora il mazzo predefinito.`;
			}
			catch (e) {
				fail(e);
			}
		});
		sendBtn.addEventListener('click', async () => {
			let cfg = form.getCfg();
			let err = this.app.ankiConfigError(cfg);
			if (err) return fail(new Error(err));
			sendBtn.disabled = true;
			bar.hidden = false;
			status.className = 'zr-note';
			status.textContent = 'Invio in corso…';
			try {
				let res = await this.app.sendToAnki(attachment, {
					cfg,
					onProgress: (done, total) => {
						bar.firstChild.style.width = Math.round(done / total * 100) + '%';
					},
				});
				form.addDeck(cfg.deck);
				store = this.app.loadStore(attachment);
				status.className = res.failed.length ? 'zr-error' : 'zr-ok';
				status.textContent = `${res.added} carte aggiunte e ${res.updated} aggiornate nel mazzo "${cfg.deck}", ${res.skipped} già identiche.`
					+ (res.failed.length ? `\n${res.failed.length} non inviate. Prima: ${res.failed[0]}` : '');
			}
			catch (e) {
				fail(e);
			}
			update();
		});
		ankiBox.replaceChildren(form.node, summary, bar,
			h(doc, 'div', { class: 'zr-footer' }, saveBtn, sendBtn), status);
	},

	/** Cards already in Anki, and the ones changed since. */
	showSent(reader, doc, popup) {
		let h = this.h.bind(this);
		let attachment = this.app.getAttachment(reader);
		let store = this.app.loadStore(attachment);
		let tags = ZotRecallCore.parseTags(this.app.getAnkiConfig().tags);
		let cards = ZotRecallCore.activeCards(store);
		let sent = cards.filter(c => c.ankiNoteId);
		let changed = sent.filter(c => ZotRecallCore.ankiState(store, c, tags) === 'changed');
		let body = h(doc, 'div', { class: 'zr-body' });
		this.setView(popup, this.header(doc, popup, 'Carte inviate ad Anki', { onBack: () => this.showMain(reader, doc, popup) }), body);
		let status = h(doc, 'p', { class: 'zr-note', hidden: true });
		let rows = sent.map((c) => {
			let state = ZotRecallCore.ankiState(store, c, tags);
			let when = c.sentAt ? new Date(c.sentAt).toLocaleString() : '';
			return h(doc, 'button', {
				class: 'zr-sent-row',
				title: 'Apri nell\'anteprima',
				onclick: () => this.showPreview(reader, doc, popup, { cardID: c.id, fromSent: true }),
			},
			h(doc, 'div', { class: 'zr-sent-q', text: c.question }),
			h(doc, 'div', { class: 'zr-meta' },
				state === 'changed' ? h(doc, 'span', { class: 'zr-tag zr-tag-warn', text: 'cambiata dopo l\'invio' }) : h(doc, 'span', { class: 'zr-tag zr-tag-ok', text: 'in Anki' }),
				` ${c.ankiDeck || ''} · ${when} · pag. ${(c.pageIndex ?? 0) + 1}`));
		});
		let actions = [];
		if (changed.length) {
			let btn = h(doc, 'button', { class: 'zr-btn zr-primary', text: `Aggiorna le ${changed.length} cambiate` });
			btn.addEventListener('click', async () => {
				btn.disabled = true;
				try {
					let res = await this.app.sendToAnki(attachment, { cardIDs: changed.map(c => c.id) });
					status.className = res.failed.length ? 'zr-error' : 'zr-ok';
					status.textContent = `${res.updated + res.added} carte aggiornate.` + (res.failed.length ? ` Errore: ${res.failed[0]}` : '');
					status.hidden = false;
					this.showSent(reader, doc, popup);
				}
				catch (e) {
					Zotero.logError(e);
					status.className = 'zr-error';
					status.textContent = e.message || String(e);
					status.hidden = false;
					btn.disabled = false;
				}
			});
			actions.push(btn);
		}
		actions.push(h(doc, 'button', { class: 'zr-btn', text: 'Esporta o invia in blocco…', onclick: () => this.showExport(reader, doc, popup) }));
		body.append(
			h(doc, 'p', { style: { margin: '0 0 10px' }, text: sent.length
				? `${sent.length} di ${cards.length} carte sono in Anki` + (changed.length ? `, ${changed.length} cambiate da allora.` : ', tutte aggiornate.')
				: 'Nessuna carta di questo PDF è ancora in Anki.' }),
			...rows,
			h(doc, 'div', { class: 'zr-footer' }, ...actions),
			status);
	},

	// ------------------------------------------------------------------
	// Settings
	// ------------------------------------------------------------------

	async showSettings(reader, doc, popup) {
		let s = this.app.getSettings();
		let apiKey = await this.app.getAPIKey();
		let h = this.h.bind(this);
		let field = (label, input, extra) => h(doc, 'label', { class: 'zr-field' }, h(doc, 'span', { text: label }), input, extra);

		let keyInput = h(doc, 'input', { type: 'password', value: apiKey, placeholder: 'sk-or-v1-…', autocomplete: 'off' });
		let modelInput = h(doc, 'input', { type: 'text', value: s.model });
		let langInput = h(doc, 'input', { type: 'text', value: s.language, list: 'zotrecall-langs' });
		let langs = h(doc, 'datalist', { id: 'zotrecall-langs' },
			['Italiano', 'English', 'Español', 'Français', 'Deutsch', 'Português'].map(l => h(doc, 'option', { value: l })));
		let orStatus = h(doc, 'p', { class: 'zr-note' });
		let orTest = h(doc, 'button', { class: 'zr-btn', text: 'Prova' });
		orTest.addEventListener('click', async (e) => {
			e.preventDefault();
			orTest.disabled = true;
			orStatus.className = 'zr-note';
			orStatus.textContent = 'Verifica in corso…';
			try {
				orStatus.textContent = await this.app.testOpenRouter(keyInput.value.trim(), modelInput.value.trim());
				orStatus.className = 'zr-ok';
			}
			catch (err) {
				orStatus.textContent = err.message || String(err);
				orStatus.className = 'zr-error';
			}
			orTest.disabled = false;
		});

		let colorRows = ZotRecallCore.ZOTERO_COLORS.map((c) => {
			let enabled = h(doc, 'input', { type: 'checkbox', title: 'Usa questo colore', checked: !s.disabledColors.includes(c.name) });
			let meaning = h(doc, 'input', { type: 'text', value: s.colorMeanings[c.name] || '', placeholder: 'Significato (facoltativo)' });
			return { c, enabled, meaning, row: h(doc, 'div', { class: 'zr-color-row' }, enabled, h(doc, 'span', { class: 'zr-swatch', style: { background: c.hex } }), meaning) };
		});

		let promptInput = h(doc, 'textarea', {});
		promptInput.value = s.systemPrompt || ZotRecallCore.DEFAULT_SYSTEM_PROMPT;
		let resetPrompt = h(doc, 'button', { class: 'zr-btn', text: 'Ripristina default' });
		resetPrompt.addEventListener('click', (e) => {
			e.preventDefault();
			promptInput.value = ZotRecallCore.DEFAULT_SYSTEM_PROMPT;
		});
		let concurrency = h(doc, 'input', { type: 'number', min: '1', max: '8', value: String(s.concurrency) });

		let ankiURL = h(doc, 'input', { type: 'text', value: s.ankiURL });
		let ankiKey = h(doc, 'input', { type: 'password', value: s.ankiKey, placeholder: 'Facoltativa', autocomplete: 'off' });
		let ankiStatus = h(doc, 'p', { class: 'zr-note' });
		let ankiTest = h(doc, 'button', { class: 'zr-btn', text: 'Prova connessione' });
		let outside = h(doc, 'input', { type: 'checkbox' });
		outside.checked = !!s.closeOnOutsideClick;

		let makeShortcutInput = (val, def) => {
			let inp = h(doc, 'input', {
				type: 'text',
				value: String(val || def).toUpperCase(),
				maxlength: '1',
				style: { width: '56px', textAlign: 'center', fontWeight: '600', textTransform: 'uppercase' },
			});
			inp.addEventListener('keydown', (e) => {
				if (e.metaKey || e.ctrlKey || e.altKey) return;
				if (e.key && e.key.length === 1 && !/\s/.test(e.key)) {
					e.preventDefault();
					e.stopPropagation();
					inp.value = e.key.toUpperCase();
				}
			});
			return inp;
		};
		let scExcludeInput = makeShortcutInput(s.shortcuts && s.shortcuts.exclude, 'E');
		let scEditInput = makeShortcutInput(s.shortcuts && s.shortcuts.edit, 'M');

		let collect = () => ({
			model: modelInput.value,
			language: langInput.value,
			systemPrompt: promptInput.value,
			colorMeanings: Object.fromEntries(colorRows.filter(r => r.meaning.value.trim()).map(r => [r.c.name, r.meaning.value.trim()])),
			disabledColors: colorRows.filter(r => !r.enabled.checked).map(r => r.c.name),
			concurrency: concurrency.value,
			ankiURL: ankiURL.value,
			ankiKey: ankiKey.value,
			closeOnOutsideClick: outside.checked,
			shortcuts: {
				exclude: (scExcludeInput.value || 'e').trim().toLowerCase(),
				edit: (scEditInput.value || 'm').trim().toLowerCase(),
			},
		});

		ankiTest.addEventListener('click', async (e) => {
			e.preventDefault();
			ankiTest.disabled = true;
			ankiStatus.className = 'zr-note';
			ankiStatus.textContent = 'Verifica in corso…';
			let previous = this.app.getSettings();
			try {
				// Test with the values in the form, then restore if not saved
				this.app.saveSettings({ ...previous, ankiURL: ankiURL.value, ankiKey: ankiKey.value });
				ankiStatus.textContent = await this.app.testAnki();
				ankiStatus.className = 'zr-ok';
			}
			catch (err) {
				ankiStatus.textContent = err.message || String(err);
				ankiStatus.className = 'zr-error';
			}
			finally {
				this.app.saveSettings(previous);
			}
			ankiTest.disabled = false;
		});

		let saveStatus = h(doc, 'p', { class: 'zr-note' });
		let save = h(doc, 'button', { class: 'zr-btn zr-primary', text: 'Salva' });
		save.addEventListener('click', async (e) => {
			e.preventDefault();
			try {
				this.app.saveSettings(collect());
				await this.app.setAPIKey(keyInput.value);
				saveStatus.className = 'zr-ok';
				saveStatus.textContent = 'Impostazioni salvate.';
			}
			catch (err) {
				Zotero.logError(err);
				saveStatus.className = 'zr-error';
				saveStatus.textContent = err.message || String(err);
			}
		});

		let body = h(doc, 'div', { class: 'zr-body' },
			h(doc, 'div', { class: 'zr-section', text: 'Modello (OpenRouter)' }),
			field('Chiave API', h(doc, 'div', { class: 'zr-row' }, keyInput, orTest), orStatus),
			field('Modello', modelInput),
			field('Lingua delle domande', langInput),
			langs,
			h(doc, 'div', { class: 'zr-section', text: 'Colori' }),
			h(doc, 'p', { class: 'zr-note', style: { marginTop: '0', marginBottom: '8px' }, text: 'Togli la spunta per ignorare un colore. Il significato, se c\'è, viene passato al modello.' }),
			...colorRows.map(r => r.row),
			h(doc, 'div', { class: 'zr-section', text: 'Prompt' }),
			field('Prompt di sistema ({{language}} = lingua scelta)', promptInput),
			h(doc, 'div', { class: 'zr-row', style: { justifyContent: 'flex-end', marginTop: '-6px', marginBottom: '12px' } }, resetPrompt),
			field('Chiamate in parallelo', concurrency),
			h(doc, 'div', { class: 'zr-section', text: 'Anki' }),
			field('Indirizzo AnkiConnect', h(doc, 'div', { class: 'zr-row' }, ankiURL, ankiTest), ankiStatus),
			field('Chiave AnkiConnect', ankiKey),
			h(doc, 'button', { class: 'zr-link', text: 'Mazzo, tipo di nota e tag predefiniti…', onclick: (e) => {
				e.preventDefault();
				this.showAnkiConfig(reader, doc, popup, () => this.showSettings(reader, doc, popup));
			} }),
			h(doc, 'div', { class: 'zr-section', text: 'Scorciatoie da tastiera (barra laterale)' }),
			h(doc, 'p', { class: 'zr-note', style: { marginTop: '0', marginBottom: '8px' }, text: 'Usa le frecce ↑ e ↓ per scorrere i periodi nella barra laterale.' }),
			h(doc, 'div', { class: 'zr-row', style: { alignItems: 'flex-start' } },
				h(doc, 'div', { style: { flex: '1' } }, field('Escludi / includi periodo', scExcludeInput)),
				h(doc, 'div', { style: { flex: '1' } }, field('Modifica periodo', scEditInput))),
			h(doc, 'div', { class: 'zr-section', text: 'Finestra' }),
			h(doc, 'label', { class: 'zr-color-row' }, outside, 'Chiudi la finestra cliccando fuori'),
			h(doc, 'div', { class: 'zr-footer' }, save),
			saveStatus);

		this.setView(popup, this.header(doc, popup, 'Impostazioni', { onBack: () => (reader ? this.showMain(reader, doc, popup) : popup._zrClose()) }), body);
	},
};
