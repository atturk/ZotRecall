/*
 * ZotRecall UI: reader toolbar button and floating popup.
 * Everything is built with DOM APIs inside the reader document.
 */
var ZotRecallUI = {
	app: null,
	_buttons: new Set(),
	_timers: new Set(),

	init(app) {
		this.app = app;
	},

	shutdown() {
		for (let { win, timer } of this._timers) {
			try {
				win.clearInterval(timer);
			}
			catch (e) {}
		}
		this._timers.clear();
		for (let btn of this._buttons) {
			try {
				let doc = btn.ownerDocument;
				doc.getElementById('zotrecall-popup')?.remove();
				doc.getElementById('zotrecall-style')?.remove();
				btn.remove();
			}
			catch (e) {}
		}
		this._buttons.clear();
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
	},

	injectStyle(doc) {
		if (doc.getElementById('zotrecall-style')) return;
		let style = doc.createElement('style');
		style.id = 'zotrecall-style';
		style.textContent = `
.zotrecall-button { position: relative; }
.zotrecall-badge {
	position: absolute; top: 1px; right: 0; min-width: 14px; height: 14px; padding: 0 3px;
	border-radius: 7px; background: #ffd400; color: #000; font: 600 9px/14px system-ui, sans-serif;
	text-align: center; pointer-events: none; box-sizing: border-box;
}
.zotrecall-badge[hidden] { display: none; }
#zotrecall-popup {
	--zr-bg: #ffffff; --zr-fg: #1f1f1f; --zr-muted: #6b6b6b; --zr-border: rgba(0,0,0,.12);
	--zr-hover: rgba(0,0,0,.05); --zr-accent: #2f6fde; --zr-accent-fg: #fff; --zr-danger: #c7372f;
	--zr-field: #fff;
	position: fixed; top: 44px; right: 8px; z-index: 100000; width: 380px; max-width: calc(100vw - 16px);
	max-height: calc(100vh - 60px); overflow: auto; box-sizing: border-box;
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
.zr-header { display: flex; align-items: center; gap: 4px; padding: 8px 8px 8px 14px; border-bottom: 1px solid var(--zr-border); position: sticky; top: 0; background: var(--zr-bg); z-index: 1; }
.zr-title { flex: 1; font-weight: 600; font-size: 13px; }
.zr-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--zr-fg); cursor: pointer; position: relative; }
.zr-icon-btn:hover { background: var(--zr-hover); }
.zr-icon-btn .zr-count { position: absolute; top: 0; right: 0; font-size: 9px; font-weight: 600; color: var(--zr-muted); }
.zr-body { padding: 12px 14px 14px; }
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
.zr-sentence .zr-text span { color: #000; border-radius: 2px; }
.zr-bar { height: 6px; border-radius: 3px; background: var(--zr-hover); overflow: hidden; }
.zr-bar-fill { height: 100%; width: 0; background: var(--zr-accent); transition: width .3s; }
.zr-meta-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--zr-muted); margin-bottom: 8px; }
.zr-link { border: 0; background: none; color: var(--zr-accent); cursor: pointer; font: inherit; padding: 0; }
.zr-card { border: 1px solid var(--zr-border); border-radius: 10px; padding: 18px 16px; min-height: 140px; cursor: pointer; outline: none; }
.zr-card:focus-visible { box-shadow: 0 0 0 2px var(--zr-accent); }
.zr-card-q { font-size: 15px; font-weight: 600; text-align: center; }
.zr-card-back { margin-top: 14px; padding-top: 10px; border-top: 1px dashed var(--zr-border); }
.zr-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
`;
		(doc.head || doc.documentElement).append(style);
	},

	// ------------------------------------------------------------------
	// Toolbar button
	// ------------------------------------------------------------------

	onRenderToolbar({ reader, doc, append }) {
		this.injectStyle(doc);
		let badge = this.h(doc, 'span', { class: 'zotrecall-badge', hidden: true });
		let btn = this.h(doc, 'button', {
			class: 'toolbar-button zotrecall-button',
			title: 'ZotRecall: carte di recall dalle evidenziazioni',
			tabindex: '-1',
		}, this.svg(doc, this.ICONS.cards), badge);
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.togglePopup(reader, doc, btn);
		});
		append(btn);
		this._buttons.add(btn);

		let win = doc.defaultView;
		let entry = { win, timer: null };
		let update = () => {
			if (!btn.isConnected) {
				win.clearInterval(entry.timer);
				this._timers.delete(entry);
				this._buttons.delete(btn);
				return;
			}
			try {
				let attachment = this.app.getAttachment(reader);
				if (!attachment || !attachment.isPDFAttachment()) {
					badge.hidden = true;
					return;
				}
				let page = this.app.getCurrentPageIndex(reader);
				let n = this.app.countPageHighlights(attachment, page);
				badge.textContent = n > 99 ? '99+' : String(n);
				badge.hidden = n === 0;
				let popup = doc.getElementById('zotrecall-popup');
				if (popup && popup._zrRefresh && popup._zrPage !== page) popup._zrRefresh();
			}
			catch (e) {
				badge.hidden = true;
			}
		};
		entry.timer = win.setInterval(update, 1000);
		this._timers.add(entry);
		update();
	},

	// ------------------------------------------------------------------
	// Popup
	// ------------------------------------------------------------------

	togglePopup(reader, doc, btn) {
		let existing = doc.getElementById('zotrecall-popup');
		if (existing) {
			existing._zrClose();
			return;
		}
		let popup = this.h(doc, 'div', { id: 'zotrecall-popup', role: 'dialog' });
		let onDocClick = (e) => {
			if (!popup.contains(e.target) && !btn.contains(e.target)) close();
		};
		let onKey = (e) => {
			if (e.key === 'Escape') {
				close();
				return;
			}
			if (popup._zrKeys && popup.contains(e.target) && popup._zrKeys(e)) {
				e.preventDefault();
				e.stopPropagation();
			}
		};
		let close = () => {
			popup.remove();
			doc.removeEventListener('mousedown', onDocClick, true);
			doc.removeEventListener('keydown', onKey, true);
		};
		popup._zrClose = close;
		doc.addEventListener('mousedown', onDocClick, true);
		doc.addEventListener('keydown', onKey, true);
		doc.body.append(popup);
		this.showMain(reader, doc, popup);
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
		popup.replaceChildren(...nodes);
	},

	showMain(reader, doc, popup) {
		let attachment = this.app.getAttachment(reader);
		let gear = this.h(doc, 'button', { class: 'zr-icon-btn', title: 'Impostazioni', onclick: () => this.showSettings(reader, doc, popup) },
			this.svg(doc, this.ICONS.gear, 18));
		let trash = this.h(doc, 'button', { class: 'zr-icon-btn', title: 'Carte scartate (prossima versione)', disabled: true },
			this.svg(doc, this.ICONS.trash, 18));
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
					onclick: () => this.startGeneration(reader, doc, popup, page),
				}),
				this.action(doc, {
					label: 'Genera carte di tutto il documento',
					sub: 'Solo i periodi senza carta, salvo tua scelta',
					count: all.length,
					disabled: !all.length,
					onclick: () => this.startGeneration(reader, doc, popup, null),
				}),
				this.action(doc, {
					label: 'Anteprima carte',
					sub: active ? 'Sfoglia le carte come flashcard' : 'Nessuna carta ancora',
					count: active,
					disabled: !active,
					onclick: () => this.showPreview(reader, doc, popup),
				}),
				this.action(doc, { label: 'Esporta (CSV o Anki)', sub: 'Disponibile nella prossima versione', disabled: true }),
				this.action(doc, {
					label: 'Mostra i periodi estratti di questa pagina',
					sub: 'Verifica cosa riceverà il modello',
					onclick: () => this.showExtracted(reader, doc, popup, page),
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
			text.append(this.h(doc, 'span', { style: { backgroundColor: s.color }, text: sentence.text.slice(s.start, s.end) }));
			pos = s.end;
		}
		text.append(doc.createTextNode(sentence.text.slice(pos)));
		return text;
	},

	async showExtracted(reader, doc, popup, page) {
		let body = this.h(doc, 'div', { class: 'zr-body' }, this.h(doc, 'p', { class: 'zr-note', text: 'Estrazione del testo in corso…' }));
		this.setView(popup, this.header(doc, popup, `Periodi estratti · pagina ${page + 1}`, {
			onBack: () => this.showMain(reader, doc, popup),
		}), body);
		try {
			let attachment = this.app.getAttachment(reader);
			let { sentences, unmatched } = await this.app.extract(attachment, page);
			body.replaceChildren();
			if (!sentences.length && !unmatched.length) {
				body.append(this.h(doc, 'p', { class: 'zr-note', text: 'Nessuna evidenziazione su questa pagina.' }));
			}
			for (let s of sentences) {
				body.append(this.h(doc, 'div', { class: 'zr-sentence' },
					this.h(doc, 'div', { class: 'zr-meta', text: [s.section && `Sezione: ${s.section}`, `pag. ${s.pageIndex + 1}`].filter(Boolean).join(' · ') }),
					this.sentenceNode(doc, s)));
			}
			if (unmatched.length) {
				body.append(this.h(doc, 'p', {
					class: 'zr-error',
					text: `${unmatched.length} evidenziazioni non sono state collegate al testo (per esempio dentro immagini o tabelle).`,
				}));
			}
		}
		catch (e) {
			Zotero.logError(e);
			body.replaceChildren(this.h(doc, 'p', { class: 'zr-error', text: e.message || String(e) }));
		}
	},

	// ------------------------------------------------------------------
	// Generation
	// ------------------------------------------------------------------

	async startGeneration(reader, doc, popup, pageIndex) {
		let h = this.h.bind(this);
		let scope = pageIndex === null ? 'tutto il documento' : `pagina ${pageIndex + 1}`;
		let body = h(doc, 'div', { class: 'zr-body' }, h(doc, 'p', { class: 'zr-note', text: 'Analisi delle evidenziazioni…' }));
		let back = () => this.showMain(reader, doc, popup);
		this.setView(popup, this.header(doc, popup, 'Genera carte · ' + scope, { onBack: back }), body);
		let attachment = this.app.getAttachment(reader);
		let analysis;
		try {
			analysis = await this.app.analyze(attachment, pageIndex);
		}
		catch (e) {
			Zotero.logError(e);
			body.replaceChildren(h(doc, 'p', { class: 'zr-error', text: e.message || String(e) }));
			return;
		}
		let { cls, unmatched } = analysis;
		let fresh = cls.fresh.length;
		let changed = cls.changed.length;
		let discarded = cls.discarded.length;

		let changedBox = h(doc, 'input', { type: 'checkbox' });
		let discardedBox = h(doc, 'input', { type: 'checkbox' });
		let summary = h(doc, 'p', { class: 'zr-note', style: { marginTop: '0' } });
		let go = h(doc, 'button', { class: 'zr-btn zr-primary', text: 'Genera' });
		let update = () => {
			let n = fresh + (changedBox.checked ? changed : 0) + (discardedBox.checked ? discarded : 0);
			go.disabled = !n;
			summary.textContent = n
				? `Verranno inviati al modello ${n} periodi.`
				: 'Non c\'è niente da generare: tutti i periodi evidenziati hanno già una carta.';
		};
		changedBox.addEventListener('change', update);
		discardedBox.addEventListener('change', update);

		let rows = [
			h(doc, 'p', { style: { margin: '0 0 10px' } },
				`${fresh} periodi nuovi · ${cls.unchanged.length} già con carta`),
		];
		if (changed) {
			rows.push(h(doc, 'label', { class: 'zr-color-row' }, changedBox,
				`Rigenera anche i ${changed} periodi con evidenziazione cambiata`));
		}
		if (discarded) {
			rows.push(h(doc, 'label', { class: 'zr-color-row' }, discardedBox,
				`Rigenera anche i ${discarded} periodi delle carte scartate`));
		}
		if (unmatched.length) {
			rows.push(h(doc, 'p', { class: 'zr-error', text: `${unmatched.length} evidenziazioni non sono collegate al testo e verranno ignorate.` }));
		}
		go.addEventListener('click', () => this.runGeneration(reader, doc, popup, pageIndex, {
			includeChanged: changedBox.checked,
			includeDiscarded: discardedBox.checked,
		}));
		body.replaceChildren(...rows, summary,
			h(doc, 'div', { class: 'zr-footer' }, h(doc, 'button', { class: 'zr-btn', text: 'Annulla', onclick: back }), go));
		update();
		// Nothing to decide: start right away
		if (fresh && !changed && !discarded) go.click();
	},

	async runGeneration(reader, doc, popup, pageIndex, choice) {
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
				pageIndex,
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

	showPreview(reader, doc, popup, startIndex = 0) {
		let h = this.h.bind(this);
		let attachment = this.app.getAttachment(reader);
		let store = this.app.loadStore(attachment);
		let cards = ZotRecallCore.activeCards(store);
		let index = Math.max(0, Math.min(startIndex, cards.length - 1));
		let flipped = false;
		let body = h(doc, 'div', { class: 'zr-body' });
		this.setView(popup, this.header(doc, popup, 'Anteprima carte', { onBack: () => this.showMain(reader, doc, popup) }), body);

		let render = () => {
			if (!cards.length) {
				body.replaceChildren(h(doc, 'p', { class: 'zr-note', text: 'Nessuna carta.' }));
				return;
			}
			let card = cards[index];
			let face = h(doc, 'div', { class: 'zr-card', tabindex: '0', title: 'Clic o spazio per girare' },
				h(doc, 'div', { class: 'zr-card-q', text: card.question }));
			if (flipped) {
				let backNode = h(doc, 'div', { class: 'zr-card-back' });
				for (let key of card.sentenceKeys) {
					let s = store.sentences[key];
					if (s) backNode.append(h(doc, 'div', { class: 'zr-sentence' }, this.sentenceNode(doc, s)));
				}
				face.append(backNode);
			}
			face.addEventListener('click', () => {
				flipped = !flipped;
				render();
			});
			let pageLink = h(doc, 'button', { class: 'zr-link', text: `pag. ${(card.pageIndex ?? 0) + 1}`, title: 'Vai alla pagina' });
			pageLink.addEventListener('click', () => {
				try {
					reader.navigate({ pageIndex: card.pageIndex });
				}
				catch (e) {
					Zotero.logError(e);
				}
			});
			let prev = h(doc, 'button', { class: 'zr-btn', text: '←', disabled: index === 0 });
			let next = h(doc, 'button', { class: 'zr-btn', text: '→', disabled: index === cards.length - 1 });
			prev.addEventListener('click', () => {
				index--;
				flipped = false;
				render();
			});
			next.addEventListener('click', () => {
				index++;
				flipped = false;
				render();
			});
			body.replaceChildren(
				h(doc, 'div', { class: 'zr-meta-row' }, h(doc, 'span', { text: `${index + 1} di ${cards.length}` }), pageLink),
				face,
				h(doc, 'div', { class: 'zr-footer', style: { justifyContent: 'space-between' } }, prev,
					h(doc, 'button', { class: 'zr-btn', text: flipped ? 'Mostra domanda' : 'Gira', onclick: () => {
						flipped = !flipped;
						render();
					} }), next));
			face.focus();
		};
		popup._zrKeys = (e) => {
			if (!cards.length || ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return false;
			if (e.key === ' ') {
				flipped = !flipped;
			}
			else if (e.key === 'ArrowRight' && index < cards.length - 1) {
				index++;
				flipped = false;
			}
			else if (e.key === 'ArrowLeft' && index > 0) {
				index--;
				flipped = false;
			}
			else {
				return false;
			}
			render();
			return true;
		};
		render();
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

		let collect = () => ({
			model: modelInput.value,
			language: langInput.value,
			systemPrompt: promptInput.value,
			colorMeanings: Object.fromEntries(colorRows.filter(r => r.meaning.value.trim()).map(r => [r.c.name, r.meaning.value.trim()])),
			disabledColors: colorRows.filter(r => !r.enabled.checked).map(r => r.c.name),
			concurrency: concurrency.value,
			ankiURL: ankiURL.value,
			ankiKey: ankiKey.value,
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
			h(doc, 'div', { class: 'zr-footer' }, save),
			saveStatus);

		this.setView(popup, this.header(doc, popup, 'Impostazioni', { onBack: () => this.showMain(reader, doc, popup) }), body);
	},
};
