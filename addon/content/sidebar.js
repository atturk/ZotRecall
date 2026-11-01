/*
 * ZotRecall sidebar mode: a fourth view in the reader's left sidebar, next to
 * thumbnails, annotations and outline, where the user reviews the highlighted
 * sentences before generating: select (click, Cmd/Ctrl+click, Shift+click),
 * merge, split, exclude, then generate.
 *
 * The reader has no API for sidebar views, so the tab and the panel are added
 * to its DOM and re-added if the reader re-renders. If the sidebar markup is
 * not found, nothing is added and the popup keeps working.
 */
var ZotRecallSidebar = {
	app: null,
	ui: null,
	_states: new WeakMap(),
	_docs: new Set(),

	init(app, ui) {
		this.app = app;
		this.ui = ui;
	},

	shutdown() {
		for (let doc of this._docs) {
			try {
				let state = this._states.get(doc);
				if (state && state.active) this.deactivate(doc);
				doc.getElementById('zotrecall-sidebar-tab')?.remove();
				doc.getElementById('zotrecall-sidebar-view')?.remove();
				doc.getElementById('zotrecall-sidebar-style')?.remove();
				doc.getElementById('zotrecall-menu')?.remove();
			}
			catch (e) {}
		}
		this._docs.clear();
	},

	// ------------------------------------------------------------------
	// Injection
	// ------------------------------------------------------------------

	/** Called on toolbar render and then every second. Cheap when nothing changed. */
	ensure(reader, doc) {
		let container = doc.getElementById('sidebarContainer');
		let start = container && container.querySelector('.sidebar-toolbar .start');
		let content = doc.getElementById('sidebarContent');
		if (!start || !content) return false;
		let state = this._states.get(doc);
		if (!state) {
			state = {
				reader,
				active: false,
				selected: new Set(),
				anchor: null,
				units: [],
				signature: null,
				restore: null,
				observer: null,
				error: '',
				scrolled: false,
				busy: false,
				pageFilter: false,
				page: null,
			};
			this._states.set(doc, state);
			this._docs.add(doc);
		}
		this.injectStyle(doc);

		let tab = doc.getElementById('zotrecall-sidebar-tab');
		if (!tab) {
			tab = this.ui.h(doc, 'button', {
				id: 'zotrecall-sidebar-tab',
				class: 'toolbar-button' + (state.active ? ' active' : ''),
				tabindex: '-1',
				role: 'tab',
				title: 'ZotRecall: rivedi i periodi evidenziati',
			}, this.ui.svg(doc, this.ui.ICONS.cards));
			tab.addEventListener('click', (e) => {
				e.stopPropagation();
				if (!state.active) this.activate(doc);
			});
			start.append(tab);
		}
		if (!start._zrListening) {
			start._zrListening = true;
			// Leaving our mode when a native view button is clicked
			start.addEventListener('click', (e) => {
				let b = e.target.closest && e.target.closest('button');
				if (b && b.id !== 'zotrecall-sidebar-tab' && state.active) this.deactivate(doc);
			}, true);
		}
		let view = doc.getElementById('zotrecall-sidebar-view');
		if (!view) {
			view = this.ui.h(doc, 'div', { id: 'zotrecall-sidebar-view', class: 'viewWrapper', role: 'tabpanel' });
			content.append(view);
			if (state.active) this.render(doc);
		}
		if (state.active) {
			container.classList.add('zr-mode');
			this.refreshIfChanged(doc);
		}
		return true;
	},

	activate(doc) {
		let state = this._states.get(doc);
		let container = doc.getElementById('sidebarContainer');
		if (!state || !container) return;
		let reader = state.reader;
		try {
			if (reader._internalReader && !reader._internalReader._state.sidebarOpen) {
				reader._internalReader.toggleSidebar(true);
			}
		}
		catch (e) {}
		state.active = true;
		container.classList.add('zr-mode');
		let start = container.querySelector('.sidebar-toolbar .start');
		let strip = () => {
			for (let b of start.querySelectorAll('.toolbar-button.active')) {
				if (b.id === 'zotrecall-sidebar-tab') continue;
				state.restore = b;
				b.classList.remove('active');
			}
		};
		strip();
		doc.getElementById('zotrecall-sidebar-tab')?.classList.add('active');
		// The reader may re-render its buttons while our view is shown
		let MO = doc.defaultView.MutationObserver;
		state.observer = new MO(() => {
			if (state.active) strip();
		});
		state.observer.observe(start, { subtree: true, attributes: true, attributeFilter: ['class'] });
		state.scrolled = false;
		state.signature = null;
		this.render(doc);
	},

	deactivate(doc) {
		let state = this._states.get(doc);
		if (!state) return;
		state.active = false;
		if (state.observer) {
			state.observer.disconnect();
			state.observer = null;
		}
		doc.getElementById('sidebarContainer')?.classList.remove('zr-mode');
		doc.getElementById('zotrecall-sidebar-tab')?.classList.remove('active');
		if (state.restore && state.restore.isConnected) state.restore.classList.add('active');
		state.restore = null;
		doc.getElementById('zotrecall-menu')?.remove();
	},

	/** Re-render when the highlights change (added, removed, recolored). */
	refreshIfChanged(doc) {
		let state = this._states.get(doc);
		if (!state || state.busy) return;
		try {
			let attachment = this.app.getAttachment(state.reader);
			if (!attachment) return;
			let sig = this.app.getAnnotations(attachment)
				.map(a => a.key + ':' + a.color + ':' + a.dateModified)
				.join('|');
			if (sig !== state.signature) this.render(doc, sig);
			else if (state.pageFilter && this.app.getCurrentPageIndex(state.reader) !== state.page) this.render(doc, sig);
		}
		catch (e) {}
	},

	// ------------------------------------------------------------------
	// Rendering
	// ------------------------------------------------------------------

	async render(doc, signature = null, { resetScroll = false } = {}) {
		let state = this._states.get(doc);
		let view = doc.getElementById('zotrecall-sidebar-view');
		if (!state || !view) return;
		let h = this.ui.h.bind(this.ui);
		let reader = state.reader;
		let attachment = this.app.getAttachment(reader);
		if (!attachment || !attachment.isPDFAttachment()) {
			view.replaceChildren(h(doc, 'p', { class: 'zr-sb-empty', text: 'ZotRecall funziona solo con i PDF.' }));
			return;
		}
		state.busy = true;
		if (!state.units.length && !view.querySelector('.zr-sb-list')) {
			view.replaceChildren(h(doc, 'p', { class: 'zr-sb-empty', text: 'Estrazione del testo in corso…' }));
		}
		let sentences;
		let unmatched;
		try {
			({ sentences, unmatched } = await this.app.extract(attachment));
			state.signature = signature || this.app.getAnnotations(attachment)
				.map(a => a.key + ':' + a.color + ':' + a.dateModified).join('|');
		}
		catch (e) {
			Zotero.logError(e);
			view.replaceChildren(h(doc, 'p', { class: 'zr-sb-error', text: e.message || String(e) }));
			state.busy = false;
			return;
		}
		finally {
			state.busy = false;
		}
		let store = this.app.loadStore(attachment);
		let units = ZotRecallCore.buildUnits(sentences, store);
		let cls = ZotRecallCore.classify(sentences, store);
		let sets = {};
		for (let k of Object.keys(cls)) sets[k] = new Set(cls[k].map(s => s.key));
		let cardCount = new Map();
		for (let c of store.cards) {
			if (c.status !== 'active') continue;
			for (let k of c.sentenceKeys) cardCount.set(k, (cardCount.get(k) || 0) + 1);
		}
		state.units = units;
		let ids = new Set(units.map(u => u.id));
		for (let id of Array.from(state.selected)) {
			if (!ids.has(id)) state.selected.delete(id);
		}

		let page = this.app.getCurrentPageIndex(reader);
		state.page = page;
		let counts = { new: 0, done: 0, changed: 0, excluded: 0, discarded: 0 };
		let list = h(doc, 'div', { class: 'zr-sb-list', role: 'listbox' });
		let firstOnPage = null;
		let onPage = u => u.sentences.some(s => s.pageIndex === page);
		let shown = state.pageFilter ? units.filter(onPage) : units;
		for (let u of units) counts[this.unitStatus(u, sets).kind]++;
		for (let u of shown) {
			let status = this.unitStatus(u, sets);
			let n = Math.max(0, ...u.keys.map(k => cardCount.get(k) || 0));
			let el = this.unitNode(doc, u, status, n);
			if (firstOnPage === null && u.sentences.some(s => s.pageIndex >= page)) firstOnPage = el;
			list.append(el);
		}
		if (!units.length) {
			list.append(h(doc, 'p', { class: 'zr-sb-empty', text: 'Nessuna evidenziazione nel documento. Evidenzia del testo e torna qui.' }));
		}
		else if (!shown.length) {
			list.append(h(doc, 'p', { class: 'zr-sb-empty', text: `Nessun periodo evidenziato a pagina ${page + 1}.` }));
		}
		if (unmatched.length) {
			list.append(h(doc, 'p', {
				class: 'zr-sb-note',
				text: `${unmatched.length} evidenziazioni non sono collegate al testo (per esempio dentro immagini o tabelle) e non compaiono qui.`,
			}));
		}

		let pageUnits = units.filter(onPage).length;
		let head = h(doc, 'div', { class: 'zr-sb-head' },
			h(doc, 'div', { class: 'zr-sb-summary', text: this.summaryText(units.length, counts) }),
			h(doc, 'div', { class: 'zr-sb-actions' },
				h(doc, 'button', {
					class: 'zr-sb-btn',
					disabled: !pageUnits,
					title: 'Genera le carte dei periodi di questa pagina',
					onclick: () => this.ui.openGeneration(reader, doc, { pageIndex: this.app.getCurrentPageIndex(reader) }),
				}, `Genera pagina ${page + 1}`),
				h(doc, 'button', {
					class: 'zr-sb-btn zr-sb-primary',
					disabled: !units.length,
					title: 'Genera le carte di tutto il documento',
					onclick: () => this.ui.openGeneration(reader, doc, {}),
				}, 'Genera tutto'),
				h(doc, 'button', {
					class: 'zr-sb-btn zr-sb-filter' + (state.pageFilter ? ' on' : ''),
					title: state.pageFilter ? 'Mostra i periodi di tutto il documento' : 'Mostra solo i periodi della pagina corrente',
					'aria-pressed': state.pageFilter ? 'true' : 'false',
					onclick: () => {
						state.pageFilter = !state.pageFilter;
						state.scrolled = false;
						this.render(doc, null, { resetScroll: true });
					},
				}, state.pageFilter ? `Solo pagina ${page + 1} ✕` : 'Solo questa pagina')),
			this.selectionBar(doc, state),
			state.error ? h(doc, 'p', { class: 'zr-sb-error', text: state.error }) : null);
		state.error = '';

		let scrollTop = resetScroll ? undefined : view.querySelector('.zr-sb-list')?.scrollTop;
		view.replaceChildren(head, list);
		if (scrollTop !== undefined) {
			list.scrollTop = scrollTop;
		}
		else if (!state.scrolled && firstOnPage && !state.pageFilter) {
			state.scrolled = true;
			list.scrollTop = Math.max(0, firstOnPage.offsetTop - list.offsetTop - 4);
		}
		list.addEventListener('keydown', (e) => {
			if (e.key === 'Escape' && state.selected.size) {
				state.selected.clear();
				this.render(doc);
				e.stopPropagation();
			}
		});
	},

	summaryText(total, counts) {
		if (!total) return 'Nessun periodo evidenziato';
		let parts = [`${total} ${total === 1 ? 'periodo' : 'periodi'}`];
		if (counts.new) parts.push(`${counts.new} da generare`);
		if (counts.done) parts.push(`${counts.done} con carta`);
		if (counts.changed) parts.push(`${counts.changed} cambiati`);
		if (counts.excluded) parts.push(`${counts.excluded} esclusi`);
		return parts.join(' · ');
	},

	unitStatus(u, sets) {
		if (u.excluded) return { kind: 'excluded', label: 'Escluso' };
		if (u.keys.some(k => sets.changed.has(k))) return { kind: 'changed', label: 'Cambiato' };
		if (u.keys.every(k => sets.unchanged.has(k))) return { kind: 'done', label: 'Con carta' };
		if (u.keys.every(k => sets.discarded.has(k) || sets.unchanged.has(k))) return { kind: 'discarded', label: 'Scartato' };
		return { kind: 'new', label: 'Da generare' };
	},

	unitNode(doc, u, status, cards) {
		let h = this.ui.h.bind(this.ui);
		let state = this._states.get(doc);
		let pages = [...new Set(u.sentences.map(s => s.pageIndex + 1))];
		let color = (u.sentences[0].spans[0] || {}).color || '#ffd400';
		let more = h(doc, 'button', { class: 'zr-sb-more', title: 'Altro', tabindex: '-1' },
			this.ui.svg(doc, ['M5 10h.01', 'M10 10h.01', 'M15 10h.01'], 16));
		let text = h(doc, 'div', { class: 'zr-sb-content' });
		let ctx = t => h(doc, 'span', { class: 'zr-sb-ctx', title: 'Periodo aggiunto come contesto', text: t });
		for (let t of u.before) text.append(ctx(t), doc.createTextNode(' '));
		u.sentences.forEach((s, i) => {
			if (i) text.append(doc.createTextNode(' '));
			let pos = 0;
			for (let sp of [...s.spans].sort((a, b) => a.start - b.start)) {
				if (sp.start < pos) continue;
				text.append(doc.createTextNode(s.text.slice(pos, sp.start)));
				text.append(h(doc, 'span', { class: 'zr-sb-hl', style: { backgroundColor: sp.color }, text: s.text.slice(sp.start, sp.end) }));
				pos = sp.end;
			}
			text.append(doc.createTextNode(s.text.slice(pos)));
		});
		for (let t of u.after) text.append(doc.createTextNode(' '), ctx(t));
		let el = h(doc, 'div', {
			class: 'zr-sb-unit' + (state.selected.has(u.id) ? ' selected' : '') + (u.excluded ? ' excluded' : ''),
			tabindex: '-1',
			role: 'option',
			'data-unit': u.id,
		},
		h(doc, 'header', {},
			h(doc, 'div', { class: 'zr-sb-start' },
				h(doc, 'span', { class: 'zr-sb-dot', style: { backgroundColor: color } }),
				h(doc, 'span', { class: 'zr-sb-page', text: (pages.length > 1 ? 'Pagine ' : 'Pagina ') + pages.join('–') })),
			h(doc, 'div', { class: 'zr-sb-end' },
				u.merged ? h(doc, 'span', { class: 'zr-sb-tag zr-sb-merged', text: `Unito · ${u.sentences.length}` }) : null,
				u.before.length || u.after.length
					? h(doc, 'span', { class: 'zr-sb-tag zr-sb-merged', title: 'Periodi non evidenziati aggiunti come contesto', text: `+${u.before.length + u.after.length}` })
					: null,
				h(doc, 'span', {
					class: 'zr-sb-tag zr-sb-' + status.kind,
					text: status.kind === 'done' && cards ? `${cards} ${cards === 1 ? 'carta' : 'carte'}` : status.label,
				}),
				more)),
		h(doc, 'div', { class: 'zr-sb-text' },
			h(doc, 'div', { class: 'zr-sb-border', style: { backgroundColor: color } }),
			text));

		el.addEventListener('mousedown', e => e.stopPropagation());
		el.addEventListener('click', (e) => {
			if (more.contains(e.target)) return;
			this.select(doc, u.id, e);
		});
		el.addEventListener('dblclick', () => this.goTo(doc, u));
		more.addEventListener('click', (e) => {
			e.stopPropagation();
			if (!state.selected.has(u.id)) {
				state.selected = new Set([u.id]);
				state.anchor = u.id;
				this.render(doc);
			}
			let r = more.getBoundingClientRect();
			let side = doc.getElementById('sidebarContainer')?.getBoundingClientRect();
			this.openMenu(doc, u, side ? side.right + 6 : r.right, r.top - 4);
		});
		return el;
	},

	// ------------------------------------------------------------------
	// Selection and actions
	// ------------------------------------------------------------------

	select(doc, id, e) {
		let state = this._states.get(doc);
		let ids = state.units.map(u => u.id);
		let toggle = e.metaKey || e.ctrlKey;
		if (e.shiftKey && state.anchor && ids.includes(state.anchor)) {
			let a = ids.indexOf(state.anchor);
			let b = ids.indexOf(id);
			let range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
			state.selected = new Set(toggle ? [...state.selected, ...range] : range);
		}
		else if (toggle) {
			if (state.selected.has(id)) state.selected.delete(id);
			else state.selected.add(id);
			state.anchor = id;
		}
		else {
			state.selected = new Set([id]);
			state.anchor = id;
			let unit = state.units.find(u => u.id === id);
			if (unit) this.goTo(doc, unit);
		}
		this.updateSelection(doc);
	},

	/** Update classes and the selection bar without rebuilding the list. */
	updateSelection(doc) {
		let state = this._states.get(doc);
		let view = doc.getElementById('zotrecall-sidebar-view');
		if (!view) return;
		for (let el of view.querySelectorAll('.zr-sb-unit')) {
			el.classList.toggle('selected', state.selected.has(el.getAttribute('data-unit')));
		}
		let bar = view.querySelector('.zr-sb-selbar');
		let next = this.selectionBar(doc, state);
		if (bar) bar.replaceWith(next);
		else view.querySelector('.zr-sb-head')?.append(next);
	},

	selectedUnits(state) {
		return state.units.filter(u => state.selected.has(u.id));
	},

	selectionBar(doc, state) {
		let h = this.ui.h.bind(this.ui);
		let units = this.selectedUnits(state);
		let bar = h(doc, 'div', { class: 'zr-sb-selbar', hidden: !units.length });
		if (!units.length) return bar;
		let allExcluded = units.every(u => u.excluded);
		bar.append(...[
			h(doc, 'span', { class: 'zr-sb-selcount', text: `${units.length} selezionati` }),
			h(doc, 'button', {
				class: 'zr-sb-btn',
				disabled: units.length < 2,
				title: 'Unisci i periodi selezionati: il modello li riceverà come un unico periodo',
				onclick: () => this.merge(doc, units),
			}, 'Unisci'),
			units.some(u => u.merged) ? h(doc, 'button', { class: 'zr-sb-btn', onclick: () => this.split(doc, units) }, 'Separa') : null,
			h(doc, 'button', { class: 'zr-sb-btn', onclick: () => this.exclude(doc, units, !allExcluded) }, allExcluded ? 'Includi' : 'Escludi'),
			h(doc, 'button', {
				class: 'zr-sb-btn zr-sb-primary',
				disabled: allExcluded,
				onclick: () => this.generateUnits(doc, units),
			}, 'Genera'),
			h(doc, 'button', {
				class: 'zr-sb-x',
				title: 'Deseleziona (Esc)',
				onclick: () => {
					state.selected.clear();
					this.updateSelection(doc);
				},
			}, this.ui.svg(doc, this.ui.ICONS.close, 14)),
		].filter(Boolean));
		return bar;
	},

	async change(doc, fn) {
		let state = this._states.get(doc);
		try {
			await this.app.updateReview(this.app.getAttachment(state.reader), fn);
		}
		catch (e) {
			Zotero.logError(e);
			state.error = e.message || String(e);
		}
		await this.render(doc);
	},

	async merge(doc, units) {
		let state = this._states.get(doc);
		let keys = units.flatMap(u => u.keys);
		await this.change(doc, store => ZotRecallCore.mergeKeys(store, keys));
		let merged = state.units.find(u => u.keys.includes(keys[0]));
		if (merged) {
			state.selected = new Set([merged.id]);
			state.anchor = merged.id;
			this.updateSelection(doc);
		}
	},

	async split(doc, units) {
		let state = this._states.get(doc);
		let keys = units.flatMap(u => u.keys);
		await this.change(doc, store => ZotRecallCore.splitKeys(store, keys));
		state.selected = new Set(state.units.filter(u => u.keys.some(k => keys.includes(k))).map(u => u.id));
		this.updateSelection(doc);
	},

	async exclude(doc, units, excluded) {
		let keys = units.flatMap(u => u.keys);
		await this.change(doc, store => ZotRecallCore.setExcluded(store, keys, excluded));
	},

	/**
	 * Add the sentence before/after a unit. If that sentence is itself
	 * highlighted, merge with its unit instead.
	 */
	async include(doc, unit, side) {
		let state = this._states.get(doc);
		let idx = state.units.findIndex(u => u.id === unit.id);
		let list = side === 'before' ? unit.sentences[0].before : unit.sentences[unit.sentences.length - 1].after;
		let have = side === 'before' ? unit.before.length : unit.after.length;
		let nextText = side === 'before' ? list[list.length - 1 - have] : list[have];
		let neighbor = state.units[side === 'before' ? idx - 1 : idx + 1];
		let neighborEdge = neighbor && (side === 'before'
			? neighbor.sentences[neighbor.sentences.length - 1]
			: neighbor.sentences[0]);
		if (neighborEdge && nextText && neighborEdge.text === nextText) {
			await this.merge(doc, [unit, neighbor]);
			return;
		}
		let key = side === 'before' ? unit.keys[0] : unit.keys[unit.keys.length - 1];
		await this.change(doc, store => ZotRecallCore.extendKey(store, key, side, 1));
	},

	async uninclude(doc, unit) {
		await this.change(doc, store => ZotRecallCore.clearExtend(store, unit.keys));
	},

	generateUnits(doc, units) {
		let state = this._states.get(doc);
		let keys = units.filter(u => !u.excluded).flatMap(u => u.keys);
		let n = units.filter(u => !u.excluded).length;
		this.ui.openGeneration(state.reader, doc, { keys, label: `${n} ${n === 1 ? 'periodo selezionato' : 'periodi selezionati'}` });
	},

	goTo(doc, unit) {
		let state = this._states.get(doc);
		let key = unit.sentences[0].spans.map(s => s.key).find(Boolean);
		try {
			if (key) state.reader.navigate({ annotationID: key });
			else state.reader.navigate({ pageIndex: unit.sentences[0].pageIndex });
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	openMenu(doc, unit, x, y) {
		let h = this.ui.h.bind(this.ui);
		let state = this._states.get(doc);
		doc.getElementById('zotrecall-menu')?.remove();
		let units = this.selectedUnits(state);
		if (!units.length) units = [unit];
		let many = units.length > 1;
		let idx = state.units.findIndex(u => u.id === unit.id);
		let next = !many && state.units[idx + 1];
		let allExcluded = units.every(u => u.excluded);
		let menu = h(doc, 'div', { id: 'zotrecall-menu', role: 'menu' });
		let off = null;
		let close = () => {
			menu.remove();
			if (off) off();
		};
		let item = (label, fn, disabled) => h(doc, 'button', {
			class: 'zr-menu-item',
			role: 'menuitem',
			disabled: !!disabled,
			onclick: () => {
				close();
				fn();
			},
		}, label);
		let sep = () => h(doc, 'div', { class: 'zr-menu-sep' });
		let canBefore = !many && unit.before.length < (unit.sentences[0].before || []).length;
		let canAfter = !many && unit.after.length < (unit.sentences[unit.sentences.length - 1].after || []).length;
		menu.append(...[
			many ? null : item('Includi periodo precedente', () => this.include(doc, unit, 'before'), !canBefore),
			many ? null : item('Includi periodo successivo', () => this.include(doc, unit, 'after'), !canAfter),
			!many && (unit.before.length || unit.after.length) ? item('Togli i periodi aggiunti', () => this.uninclude(doc, unit)) : null,
			sep(),
			many
				? item(`Unisci i ${units.length} periodi`, () => this.merge(doc, units))
				: item('Unisci con il successivo evidenziato', () => this.merge(doc, [unit, next]), !next),
			units.some(u => u.merged) ? item('Separa', () => this.split(doc, units)) : null,
			sep(),
			item(allExcluded ? 'Includi di nuovo' : 'Escludi dalla generazione', () => this.exclude(doc, units, !allExcluded)),
			item(many ? 'Genera carte per questi periodi' : 'Genera carte solo per questo', () => this.generateUnits(doc, units), allExcluded),
			sep(),
			item('Vai all\'evidenziazione', () => this.goTo(doc, unit), many),
		].filter(Boolean));
		doc.body.append(menu);
		let win = doc.defaultView;
		let w = menu.offsetWidth;
		let hgt = menu.offsetHeight;
		menu.style.left = Math.max(4, Math.min(x, win.innerWidth - w - 4)) + 'px';
		menu.style.top = Math.max(4, Math.min(y, win.innerHeight - hgt - 4)) + 'px';
		off = this.ui.onOutsideClick(doc, menu, close);
	},

	// ------------------------------------------------------------------
	// Style: mirrors the reader's annotation cards (_annotations-view.scss,
	// _preview.scss), using the reader's own color variables
	// ------------------------------------------------------------------

	injectStyle(doc) {
		if (doc.getElementById('zotrecall-sidebar-style')) return;
		let style = doc.createElement('style');
		style.id = 'zotrecall-sidebar-style';
		style.textContent = `
#sidebarContainer.zr-mode #sidebarContent > .viewWrapper:not(#zotrecall-sidebar-view) { display: none !important; }
#sidebarContainer.zr-mode .sidebar-toolbar .end > * { display: none !important; }
#zotrecall-sidebar-view { display: none; width: 100%; height: 100%; flex-direction: column; user-select: none; }
#sidebarContainer.zr-mode #zotrecall-sidebar-view { display: flex; }
#zotrecall-sidebar-tab svg { pointer-events: none; }
.zr-sb-head { padding: 4px 8px 8px; border-bottom: var(--material-panedivider, 1px solid var(--fill-quinary)); display: flex; flex-direction: column; gap: 6px; }
.zr-sb-summary { font-size: 11px; color: var(--fill-secondary); }
.zr-sb-actions, .zr-sb-selbar { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.zr-sb-selbar[hidden] { display: none; }
.zr-sb-selcount { font-size: 11px; font-weight: 590; margin-right: 2px; }
.zr-sb-btn { padding: 3px 8px; border: 1px solid var(--fill-quinary); border-radius: 5px; background: var(--material-background); color: var(--fill-primary); font: inherit; font-size: 12px; cursor: pointer; }
.zr-sb-btn:hover:not(:disabled) { background: var(--fill-quinary); }
.zr-sb-btn:disabled { opacity: .45; cursor: default; }
.zr-sb-btn.zr-sb-primary { background: var(--accent-blue, #2f6fde); border-color: transparent; color: #fff; }
.zr-sb-x { margin-left: auto; display: inline-flex; padding: 3px; border: 0; border-radius: 4px; background: none; color: var(--fill-secondary); cursor: pointer; }
.zr-sb-x:hover { background: var(--fill-quinary); }
.zr-sb-list { flex: 1; overflow: auto; padding: 7px 7px 8px; }
.zr-sb-unit { background: var(--material-background); outline: 1px solid var(--fill-quinary); border-radius: 5px; overflow: hidden; cursor: default; }
.zr-sb-unit + .zr-sb-unit { margin-top: 7px; }
.zr-sb-unit:active { outline: 1px solid var(--fill-tertiary); }
.zr-sb-unit.selected { background: var(--accent-blue10); outline: 3px solid var(--accent-blue50); }
.zr-sb-unit:focus { outline-offset: 0; }
.zr-sb-unit.excluded .zr-sb-text { opacity: .45; }
.zr-sb-unit header { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; border-bottom: 1px solid var(--fill-quinary); white-space: nowrap; gap: 4px; }
.zr-sb-start, .zr-sb-end { display: flex; align-items: center; gap: 5px; min-width: 0; }
.zr-sb-dot { width: 10px; height: 10px; border-radius: 2px; flex: none; }
.zr-sb-page { font-weight: 590; }
.zr-sb-tag { font-size: 10px; padding: 0 6px; border-radius: 8px; background: var(--fill-quinary); color: var(--fill-secondary); }
.zr-sb-new { background: rgba(47,111,222,.16); color: var(--accent-blue, #2f6fde); }
.zr-sb-done { background: rgba(95,178,54,.18); color: #3f8a1f; }
.zr-sb-changed { background: #fde8c8; color: #8a5300; }
.zr-sb-merged { background: rgba(162,138,229,.32); color: var(--fill-primary); }
.zr-sb-more { display: inline-flex; padding: 1px 2px; border: 0; border-radius: 4px; background: none; color: var(--fill-secondary); cursor: pointer; }
.zr-sb-more svg { stroke-width: 2.6; }
.zr-sb-more:hover { background: var(--fill-quinary); }
.zr-sb-text { position: relative; color: var(--fill-secondary); }
.zr-sb-border { position: absolute; left: 8px; top: 5px; bottom: 6px; width: 2px; }
.zr-sb-content { padding: 4px 8px 5px 16px; line-height: 1.4; word-break: break-word; }
.zr-sb-hl { color: #000; border-radius: 2px; }
.zr-sb-ctx { font-style: italic; opacity: .75; text-decoration: underline dotted; text-underline-offset: 3px; }
.zr-sb-filter.on { background: var(--accent-blue10); border-color: var(--accent-blue50); }
.zr-sb-empty, .zr-sb-note { padding: 8px; font-size: 12px; color: var(--fill-secondary); }
.zr-sb-error { margin: 0; font-size: 12px; color: #c7372f; white-space: pre-wrap; }
#zotrecall-menu { position: fixed; z-index: 100000; min-width: 200px; padding: 4px; border: 1px solid var(--fill-quinary); border-radius: 7px; background: var(--material-background); box-shadow: 0 6px 20px rgba(0,0,0,.25); display: flex; flex-direction: column; }
.zr-menu-item { padding: 5px 10px; border: 0; border-radius: 4px; background: none; color: var(--fill-primary); font: inherit; text-align: left; cursor: default; }
.zr-menu-item:hover:not(:disabled) { background: var(--accent-blue, #2f6fde); color: #fff; }
.zr-menu-item:disabled { opacity: .4; }
.zr-menu-sep { height: 1px; margin: 4px 6px; background: var(--fill-quinary); }
.zr-menu-sep:first-child, .zr-menu-sep + .zr-menu-sep, .zr-menu-sep:last-child { display: none; }
@media (prefers-color-scheme: dark) {
	.zr-sb-done { color: #8fd16a; }
	.zr-sb-changed { background: rgba(241,152,55,.22); color: #f5b46c; }
	.zr-sb-new { color: #7fa9f7; }
}
`;
		(doc.head || doc.documentElement).append(style);
	},
};
