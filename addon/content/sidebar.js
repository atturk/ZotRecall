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
				if (state && state.onKeyDown) doc.removeEventListener('keydown', state.onKeyDown, true);
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
				editingUnitId: null,
				onKeyDown: (e) => this.handleKeyDown(doc, e),
			};
			doc.addEventListener('keydown', state.onKeyDown, true);
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
			view = this.ui.h(doc, 'div', { id: 'zotrecall-sidebar-view', class: 'viewWrapper preview-popup', role: 'tabpanel' });
			view.addEventListener('pointerdown', e => e.stopPropagation());
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
		let tags = ZotRecallCore.parseTags(this.app.getAnkiConfig().tags);
		let active = ZotRecallCore.activeCards(store);
		let unsent = ZotRecallCore.unsentCards(store, tags);
		let unsentIDs = new Set(unsent.map(c => c.id));
		state.units = units;
		let ids = new Set(units.map(u => u.id));
		for (let id of Array.from(state.selected)) {
			if (!ids.has(id)) state.selected.delete(id);
		}
		if (state.editingUnitId && !ids.has(state.editingUnitId)) {
			state.editingUnitId = null;
		}

		let page = this.app.getCurrentPageIndex(reader);
		state.page = page;
		let counts = { new: 0, done: 0, changed: 0, excluded: 0, discarded: 0 };
		let list = h(doc, 'div', { class: 'zr-sb-list', role: 'listbox', tabindex: '0' });
		let firstOnPage = null;
		let onPage = u => u.sentences.some(s => s.pageIndex === page);
		let shown = state.pageFilter ? units.filter(onPage) : units;
		for (let u of units) counts[this.unitStatus(u, sets).kind]++;
		for (let u of shown) {
			let status = this.unitStatus(u, sets);
			let unitKeySet = new Set(u.keys);
			let unitCards = active.filter(c => c.sentenceKeys.some(k => unitKeySet.has(k)));
			let n = unitCards.length;
			let firstUnsent = unitCards.find(c => unsentIDs.has(c.id));
			let cardID = (firstUnsent || unitCards[0])?.id || null;
			let el = this.unitNode(doc, u, status, n, cardID);
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
		let genPageTitle = `Genera pagina ${page + 1} — Genera le carte dei periodi di questa pagina`;
		let genAllTitle = 'Genera tutto — Genera le carte di tutto il documento';
		let filterTitle = state.pageFilter
			? `Solo pagina ${page + 1} (attivo) — Clicca per mostrare i periodi di tutto il documento`
			: 'Solo questa pagina — Mostra solo i periodi della pagina corrente';
		let previewTitle = unsent.length
			? `Anteprima e invio (${unsent.length} da inviare) — Controlla, modifica e invia ad Anki le carte una alla volta`
			: 'Anteprima e invio (nessuna carta da inviare)';
		let head = h(doc, 'div', { class: 'zr-sb-head' },
			h(doc, 'div', { class: 'zr-sb-summary', text: this.summaryText(units.length, counts) }),
			h(doc, 'div', { class: 'zr-sb-actions' },
				h(doc, 'button', {
					class: 'zr-sb-btn zr-sb-icon-btn',
					disabled: !pageUnits,
					title: genPageTitle,
					'aria-label': genPageTitle,
					onclick: () => this.ui.openGeneration(reader, doc, { pageIndex: this.app.getCurrentPageIndex(reader) }),
				}, this.ui.svg(doc, this.ui.ICONS.genPage, 16)),
				h(doc, 'button', {
					class: 'zr-sb-btn zr-sb-icon-btn zr-sb-primary',
					disabled: !units.length,
					title: genAllTitle,
					'aria-label': genAllTitle,
					onclick: () => this.ui.openGeneration(reader, doc, {}),
				}, this.ui.svg(doc, this.ui.ICONS.genAll, 16)),
				h(doc, 'button', {
					class: 'zr-sb-btn zr-sb-icon-btn zr-sb-filter' + (state.pageFilter ? ' on' : ''),
					title: filterTitle,
					'aria-label': filterTitle,
					'aria-pressed': state.pageFilter ? 'true' : 'false',
					onclick: () => {
						state.pageFilter = !state.pageFilter;
						state.scrolled = false;
						this.render(doc, null, { resetScroll: true });
					},
				}, this.ui.svg(doc, this.ui.ICONS.filterPage, 16)),
				h(doc, 'button', {
					class: 'zr-sb-btn zr-sb-icon-btn',
					disabled: !unsent.length,
					title: previewTitle,
					'aria-label': previewTitle,
					onclick: () => this.ui.open(reader, 'preview', 0),
				}, this.ui.svg(doc, this.ui.ICONS.previewSend, 16))),
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

	unitNode(doc, u, status, cards, cardID) {
		let h = this.ui.h.bind(this.ui);
		let state = this._states.get(doc);
		let pages = [...new Set(u.sentences.map(s => s.pageIndex + 1))];
		let renderList = u.renderSentences || u.sentences;
		let color = ((renderList[0] && renderList[0].spans[0]) || (u.sentences[0] && u.sentences[0].spans[0]) || {}).color || '#ffd400';
		let isEditing = state.editingUnitId === u.id;
		let more = h(doc, 'button', { class: 'zr-sb-more', title: 'Altro', tabindex: '-1' },
			this.ui.svg(doc, ['M5 10h.01', 'M10 10h.01', 'M15 10h.01'], 16));
		let bodyNode;
		if (isEditing) {
			bodyNode = this.unitEditorNode(doc, u, color);
		}
		else {
			let text = h(doc, 'div', { class: 'zr-sb-content' });
			let ctx = t => h(doc, 'span', { class: 'zr-sb-ctx', title: 'Periodo aggiunto come contesto', text: t });
			for (let t of u.before) text.append(ctx(t), doc.createTextNode(' '));
			renderList.forEach((s, i) => {
				if (i) text.append(doc.createTextNode(' '));
				let pos = 0;
				for (let sp of [...s.spans].sort((a, b) => a.start - b.start)) {
					if (sp.start < pos) continue;
					text.append(doc.createTextNode(s.text.slice(pos, sp.start)));
					text.append(h(doc, 'span', {
						class: 'zr-sb-hl',
						style: { backgroundColor: sp.color, color: ZotRecallCore.highlightTextColor(sp.color) },
						text: s.text.slice(sp.start, sp.end),
					}));
					pos = sp.end;
				}
				text.append(doc.createTextNode(s.text.slice(pos)));
			});
			for (let t of u.after) text.append(doc.createTextNode(' '), ctx(t));
			bodyNode = h(doc, 'div', { class: 'zr-sb-text' },
				h(doc, 'div', { class: 'zr-sb-border', style: { backgroundColor: color } }),
				text);
		}
		let el = h(doc, 'div', {
			class: 'zr-sb-unit'
				+ (state.selected.has(u.id) ? ' selected' : '')
				+ (u.excluded ? ' excluded' : '')
				+ (isEditing ? ' editing' : ''),
			tabindex: '-1',
			role: 'option',
			'data-unit': u.id,
		},
		h(doc, 'header', {},
			h(doc, 'div', { class: 'zr-sb-start' },
				h(doc, 'span', { class: 'zr-sb-dot', style: { backgroundColor: color } }),
				h(doc, 'span', { class: 'zr-sb-page', text: (pages.length > 1 ? 'Pagine ' : 'Pagina ') + pages.join('–') })),
			h(doc, 'div', { class: 'zr-sb-end' },
				u.edited ? h(doc, 'span', { class: 'zr-sb-tag zr-sb-edited', title: 'Periodo modificato manualmente', text: 'Modificato' }) : null,
				u.merged ? h(doc, 'span', { class: 'zr-sb-tag zr-sb-merged', text: `Unito · ${u.sentences.length}` }) : null,
				u.before.length || u.after.length
					? h(doc, 'span', { class: 'zr-sb-tag zr-sb-merged', title: 'Periodi non evidenziati aggiunti come contesto', text: `+${u.before.length + u.after.length}` })
					: null,
				cardID
					? h(doc, 'button', {
						class: 'zr-sb-tag zr-sb-' + status.kind + ' zr-sb-cards',
						title: 'Apri le carte di questo periodo nell\'anteprima',
						onclick: (e) => {
							e.stopPropagation();
							this.ui.open(state.reader, 'preview', { sentenceKeys: u.keys, cardID });
						},
					}, status.kind === 'done' && cards ? `${cards} ${cards === 1 ? 'carta' : 'carte'}` : status.label)
					: h(doc, 'span', {
						class: 'zr-sb-tag zr-sb-' + status.kind,
						text: status.label,
					}),
				more)),
		bodyNode);

		el.addEventListener('pointerdown', e => e.stopPropagation());
		el.addEventListener('mousedown', e => e.stopPropagation());
		el.addEventListener('click', (e) => {
			if (isEditing || more.contains(e.target)) return;
			this.select(doc, u.id, e);
		});
		el.addEventListener('dblclick', (e) => {
			if (isEditing) return;
			this.goTo(doc, u);
		});
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

	unitEditorNode(doc, u, defaultColor) {
		let h = this.ui.h.bind(this.ui);
		let state = this._states.get(doc);
		let editor = h(doc, 'div', {
			class: 'zr-sb-editor',
			contenteditable: 'true',
			spellcheck: 'false',
		});
		let populate = (sentenceList) => {
			editor.replaceChildren();
			sentenceList.forEach((s, i) => {
				if (i) editor.append(doc.createTextNode(' '));
				let pos = 0;
				for (let sp of [...(s.spans || [])].sort((a, b) => a.start - b.start)) {
					if (sp.start < pos) continue;
					if (sp.start > pos) editor.append(doc.createTextNode(s.text.slice(pos, sp.start)));
					editor.append(h(doc, 'span', {
						class: 'zr-sb-hl',
						'data-color': sp.color,
						style: {
							backgroundColor: sp.color,
							color: ZotRecallCore.highlightTextColor(sp.color),
						},
						text: s.text.slice(sp.start, sp.end),
					}));
					pos = sp.end;
				}
				if (pos < s.text.length) editor.append(doc.createTextNode(s.text.slice(pos)));
			});
		};
		populate(u.renderSentences || u.sentences);

		let clearHighlightStyle = (sp) => {
			sp.removeAttribute('data-color');
			sp.style.backgroundColor = '';
			sp.style.color = '';
			sp.classList.remove('zr-sb-hl');
		};
		let applyHighlight = (color) => {
			let sel = doc.getSelection();
			if (!sel || !sel.rangeCount) return;
			let r = sel.getRangeAt(0);
			if (r.collapsed || !editor.contains(r.commonAncestorContainer)) return;
			let ancEl = r.commonAncestorContainer.nodeType === 1
				? r.commonAncestorContainer
				: r.commonAncestorContainer.parentElement;
			let ancSpan = ancEl && ancEl.closest && ancEl.closest('span');
			if (!color && ancSpan && editor.contains(ancSpan) && (ancSpan.getAttribute('data-color') || ancSpan.style.backgroundColor)) {
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
				editor.focus();
				return;
			}
			let frag = r.extractContents();
			frag.querySelectorAll('span').forEach(clearHighlightStyle);
			let node = frag;
			if (color) {
				node = h(doc, 'span', {
					class: 'zr-sb-hl',
					'data-color': color,
					style: {
						backgroundColor: color,
						color: ZotRecallCore.highlightTextColor(color),
					},
				});
				node.append(frag);
			}
			let last = node.lastChild;
			r.insertNode(node);
			sel.removeAllRanges();
			let after = doc.createRange();
			if (color) after.selectNodeContents(node);
			else if (last) after.setStartAfter(last);
			sel.addRange(after);
			editor.focus();
		};

		let saveEdit = async () => {
			let norm = this.extractUnitEdit(editor, defaultColor);
			if (!norm.text) return;
			state.editingUnitId = null;
			await this.change(doc, store => ZotRecallCore.setUnitEdit(store, u.keys, {
				text: norm.text,
				spans: norm.spans,
				defaultColor,
			}));
		};
		let cancelEdit = () => {
			state.editingUnitId = null;
			this.render(doc);
		};

		editor.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Escape') {
				e.preventDefault();
				cancelEdit();
			}
			else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
				e.preventDefault();
				saveEdit();
			}
		});

		let bar = h(doc, 'div', { class: 'zr-sb-edit-bar' },
			...ZotRecallCore.ZOTERO_COLORS.map(c => h(doc, 'button', {
				class: 'zr-sb-color-dot',
				type: 'button',
				title: `Evidenzia (${c.name})`,
				style: { backgroundColor: c.hex },
				onmousedown: e => e.preventDefault(),
				onclick: (e) => {
					e.stopPropagation();
					applyHighlight(c.hex);
				},
			})),
			h(doc, 'button', {
				class: 'zr-sb-edit-tool',
				type: 'button',
				title: 'Togli evidenziazione dal testo selezionato',
				onmousedown: e => e.preventDefault(),
				onclick: (e) => {
					e.stopPropagation();
					applyHighlight(null);
				},
			}, '⌀'),
			h(doc, 'button', {
				class: 'zr-sb-edit-tool zr-sb-edit-reset',
				type: 'button',
				title: 'Ripristina il periodo originale del PDF',
				onmousedown: e => e.preventDefault(),
				onclick: (e) => {
					e.stopPropagation();
					populate(u.sentences);
					editor.focus();
				},
			}, '↺'));

		let actions = h(doc, 'div', { class: 'zr-sb-edit-actions' },
			h(doc, 'button', {
				class: 'zr-sb-btn',
				type: 'button',
				onclick: (e) => {
					e.stopPropagation();
					cancelEdit();
				},
			}, 'Annulla'),
			h(doc, 'button', {
				class: 'zr-sb-btn zr-sb-primary',
				type: 'button',
				onclick: (e) => {
					e.stopPropagation();
					saveEdit();
				},
			}, 'Salva'));

		let win = doc.defaultView;
		if (win && win.requestAnimationFrame) {
			win.requestAnimationFrame(() => {
				if (editor.isConnected) editor.focus();
			});
		}

		return h(doc, 'div', { class: 'zr-sb-edit-wrap' }, bar, editor, actions);
	},

	extractUnitEdit(editor, defaultColor) {
		let rawText = '';
		let rawSpans = [];
		let walk = (node, activeColor) => {
			for (let child of Array.from(node.childNodes)) {
				if (child.nodeType === 3) {
					let t = child.textContent || '';
					if (!t) continue;
					let start = rawText.length;
					rawText += t;
					if (activeColor) {
						rawSpans.push({ start, end: rawText.length, color: activeColor });
					}
				}
				else if (child.nodeType === 1) {
					let tag = child.tagName.toUpperCase();
					if (tag === 'BR') {
						rawText += ' ';
						continue;
					}
					let color = activeColor;
					let bg = child.getAttribute('data-color') || (child.style && child.style.backgroundColor) || '';
					if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\s*\)/i.test(bg)) {
						color = ZotRecallCore.normalizeColorHex(bg) || bg;
					}
					walk(child, color);
					if (tag === 'DIV' || tag === 'P') rawText += ' ';
				}
			}
		};
		walk(editor, null);
		return ZotRecallCore.normalizeEditedUnit(rawText, rawSpans, defaultColor);
	},

	startEditUnit(doc, unit) {
		if (!unit) return;
		let state = this._states.get(doc);
		if (!state) return;
		state.selected = new Set([unit.id]);
		state.anchor = unit.id;
		state.editingUnitId = unit.id;
		this.render(doc);
	},

	async resetUnitEdit(doc, unit) {
		if (!unit) return;
		let state = this._states.get(doc);
		if (state && state.editingUnitId === unit.id) state.editingUnitId = null;
		await this.change(doc, store => ZotRecallCore.clearUnitEdit(store, unit.keys));
	},

	// ------------------------------------------------------------------
	// Selection, keyboard navigation and actions
	// ------------------------------------------------------------------

	handleKeyDown(doc, e) {
		let state = this._states.get(doc);
		if (!state || !state.active) return;
		if (doc.getElementById('zotrecall-popup')) return;
		let t = e.target;
		if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;

		if (e.key === 'Escape') {
			let menu = doc.getElementById('zotrecall-menu');
			if (menu) {
				menu.remove();
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (state.editingUnitId) {
				state.editingUnitId = null;
				this.render(doc);
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (state.selected.size) {
				state.selected.clear();
				this.updateSelection(doc);
				e.preventDefault();
				e.stopPropagation();
				return;
			}
		}

		if (state.editingUnitId) return;

		let page = state.page ?? this.app.getCurrentPageIndex(state.reader);
		let onPage = u => u.sentences.some(s => s.pageIndex === page);
		let shown = state.pageFilter ? state.units.filter(onPage) : state.units;
		if (!shown.length) return;

		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			e.stopPropagation();
			let delta = e.key === 'ArrowDown' ? 1 : -1;
			let selArr = Array.from(state.selected);
			let curId = selArr.length ? selArr[selArr.length - 1] : state.anchor;
			let idx = shown.findIndex(u => u.id === curId);
			let nextIdx;
			if (idx === -1) nextIdx = delta > 0 ? 0 : shown.length - 1;
			else nextIdx = Math.max(0, Math.min(shown.length - 1, idx + delta));
			let nextUnit = shown[nextIdx];
			if (!nextUnit) return;
			if (e.shiftKey) {
				if (!state.anchor) state.anchor = curId || nextUnit.id;
				state.selected.add(nextUnit.id);
			}
			else {
				state.selected = new Set([nextUnit.id]);
				state.anchor = nextUnit.id;
			}
			this.goTo(doc, nextUnit);
			this.updateSelection(doc);
			let view = doc.getElementById('zotrecall-sidebar-view');
			let el = view && Array.from(view.querySelectorAll('.zr-sb-unit')).find(node => node.getAttribute('data-unit') === nextUnit.id);
			if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
			return;
		}

		if (e.metaKey || e.ctrlKey || e.altKey) return;
		let units = this.selectedUnits(state);
		if (!units.length) return;
		let shortcuts = (this.app.getSettings && this.app.getSettings().shortcuts) || { exclude: 'e', edit: 'm' };
		let key = String(e.key || '').toLowerCase();
		if (key && key === (shortcuts.exclude || 'e')) {
			e.preventDefault();
			e.stopPropagation();
			let allExcluded = units.every(u => u.excluded);
			this.exclude(doc, units, !allExcluded);
			return;
		}
		if (key && key === (shortcuts.edit || 'm')) {
			e.preventDefault();
			e.stopPropagation();
			this.startEditUnit(doc, units[0]);
		}
	},

	select(doc, id, e) {
		let state = this._states.get(doc);
		let ids = state.units.map(u => u.id);
		let toggle = e.metaKey || e.ctrlKey;
		if (e.shiftKey && state.anchor && ids.includes(state.anchor)) {
			let a = ids.indexOf(state.anchor);
			let b = ids.indexOf(id);
			let range = a <= b
				? ids.slice(a, b + 1)
				: ids.slice(b, a + 1).reverse();
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

	/** Selected units in the exact order they were selected by the user. */
	selectedUnits(state) {
		let byId = new Map(state.units.map(u => [u.id, u]));
		return Array.from(state.selected).map(id => byId.get(id)).filter(Boolean);
	},

	selectionBar(doc, state) {
		let h = this.ui.h.bind(this.ui);
		let units = this.selectedUnits(state);
		let bar = h(doc, 'div', { class: 'zr-sb-selbar', hidden: !units.length });
		if (!units.length) return bar;
		let allExcluded = units.every(u => u.excluded);
		let shortcuts = (this.app.getSettings && this.app.getSettings().shortcuts) || { exclude: 'e', edit: 'm' };
		let editKey = String(shortcuts.edit || 'm').toUpperCase();
		let excludeKey = String(shortcuts.exclude || 'e').toUpperCase();
		bar.append(...[
			h(doc, 'span', { class: 'zr-sb-selcount', text: `${units.length} selezionati` }),
			units.length === 1 ? h(doc, 'button', {
				class: 'zr-sb-btn',
				title: `Modifica manualmente il periodo (${editKey})`,
				onclick: () => this.startEditUnit(doc, units[0]),
			}, 'Modifica') : null,
			h(doc, 'button', {
				class: 'zr-sb-btn',
				disabled: units.length < 2,
				title: 'Unisci i periodi selezionati nell\'ordine di selezione',
				onclick: () => this.merge(doc, units),
			}, 'Unisci'),
			units.some(u => u.merged) ? h(doc, 'button', { class: 'zr-sb-btn', onclick: () => this.split(doc, units) }, 'Separa') : null,
			h(doc, 'button', {
				class: 'zr-sb-btn',
				title: `${allExcluded ? 'Includi' : 'Escludi'} (${excludeKey})`,
				onclick: () => this.exclude(doc, units, !allExcluded),
			}, allExcluded ? 'Includi' : 'Escludi'),
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
		let shortcuts = (this.app.getSettings && this.app.getSettings().shortcuts) || { exclude: 'e', edit: 'm' };
		let editKeyHint = shortcuts.edit ? shortcuts.edit.toUpperCase() : '';
		let excludeKeyHint = shortcuts.exclude ? shortcuts.exclude.toUpperCase() : '';
		let menu = h(doc, 'div', { id: 'zotrecall-menu', class: 'preview-popup', role: 'menu' });
		menu.addEventListener('pointerdown', e => e.stopPropagation());
		menu.addEventListener('mousedown', e => e.stopPropagation());
		let off = null;
		let close = () => {
			menu.remove();
			if (off) off();
		};
		let item = (label, fn, disabled, shortcut) => h(doc, 'button', {
			class: 'zr-menu-item',
			role: 'menuitem',
			disabled: !!disabled,
			onclick: () => {
				close();
				fn();
			},
		}, [
			h(doc, 'span', {}, label),
			shortcut ? h(doc, 'span', { class: 'zr-menu-key' }, shortcut) : null,
		]);
		let sep = () => h(doc, 'div', { class: 'zr-menu-sep' });
		let canBefore = !many && unit.before.length < (unit.sentences[0].before || []).length;
		let canAfter = !many && unit.after.length < (unit.sentences[unit.sentences.length - 1].after || []).length;
		menu.append(...[
			many ? null : item('Modifica periodo', () => this.startEditUnit(doc, unit), false, editKeyHint),
			!many && unit.edited ? item('Ripristina periodo originale', () => this.resetUnitEdit(doc, unit)) : null,
			sep(),
			many ? null : item('Includi periodo precedente', () => this.include(doc, unit, 'before'), !canBefore),
			many ? null : item('Includi periodo successivo', () => this.include(doc, unit, 'after'), !canAfter),
			!many && (unit.before.length || unit.after.length) ? item('Togli i periodi aggiunti', () => this.uninclude(doc, unit)) : null,
			sep(),
			many
				? item(`Unisci i ${units.length} periodi`, () => this.merge(doc, units))
				: item('Unisci con il successivo evidenziato', () => this.merge(doc, [unit, next]), !next),
			units.some(u => u.merged) ? item('Separa', () => this.split(doc, units)) : null,
			sep(),
			item(allExcluded ? 'Includi di nuovo' : 'Escludi dalla generazione', () => this.exclude(doc, units, !allExcluded), false, excludeKeyHint),
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
		let style = doc.getElementById('zotrecall-sidebar-style');
		if (!style) {
			style = doc.createElement('style');
			style.id = 'zotrecall-sidebar-style';
			(doc.head || doc.documentElement).append(style);
		}
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
.zr-sb-btn.zr-sb-primary:hover:not(:disabled) { filter: brightness(1.08); background: var(--accent-blue, #2f6fde); }
.zr-sb-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; }
.zr-sb-icon-btn svg { pointer-events: none; }
.zr-sb-x { margin-left: auto; display: inline-flex; padding: 3px; border: 0; border-radius: 4px; background: none; color: var(--fill-secondary); cursor: pointer; }
.zr-sb-x:hover { background: var(--fill-quinary); }
.zr-sb-list { flex: 1; overflow: auto; padding: 7px 7px 8px; }
.zr-sb-list:focus { outline: none; }
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
.zr-sb-edited { background: rgba(46,168,229,.22); color: #1971a8; }
.zr-sb-cards { border: 0; font: inherit; font-size: 10px; cursor: pointer; }
.zr-sb-cards:hover { text-decoration: underline; }
.zr-sb-more { display: inline-flex; padding: 1px 2px; border: 0; border-radius: 4px; background: none; color: var(--fill-secondary); cursor: pointer; }
.zr-sb-more svg { stroke-width: 2.6; }
.zr-sb-more:hover { background: var(--fill-quinary); }
.zr-sb-text { position: relative; color: var(--fill-secondary); }
.zr-sb-border { position: absolute; left: 8px; top: 5px; bottom: 6px; width: 2px; }
.zr-sb-content { padding: 4px 8px 5px 16px; line-height: 1.4; word-break: break-word; }
.zr-sb-hl { border-radius: 2px; padding: 0 2px; }
.zr-sb-ctx { font-style: italic; opacity: .75; text-decoration: underline dotted; text-underline-offset: 3px; }
.zr-sb-edit-wrap { padding: 6px 8px 8px; display: flex; flex-direction: column; gap: 6px; user-select: text; }
.zr-sb-edit-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; }
.zr-sb-color-dot { width: 16px; height: 16px; padding: 0; border-radius: 4px; border: 1px solid rgba(0,0,0,.25); cursor: pointer; }
.zr-sb-color-dot:hover { transform: scale(1.1); }
.zr-sb-edit-tool { font: inherit; font-size: 10px; padding: 1px 5px; border: 1px solid var(--fill-quinary); border-radius: 4px; background: var(--material-background); color: var(--fill-secondary); cursor: pointer; }
.zr-sb-edit-tool:hover { background: var(--fill-quinary); color: var(--fill-primary); }
.zr-sb-edit-reset { margin-left: auto; }
.zr-sb-editor { min-height: 54px; max-height: 220px; overflow: auto; padding: 6px 8px; border: 1px solid var(--accent-blue50, #2f6fde); border-radius: 5px; background: var(--material-background); color: var(--fill-primary); font: inherit; font-size: 12px; line-height: 1.45; word-break: break-word; outline: none; user-select: text; cursor: text; }
.zr-sb-edit-actions { display: flex; justify-content: flex-end; gap: 5px; }
.zr-sb-filter.on { background: var(--accent-blue10); border-color: var(--accent-blue50); }
.zr-sb-empty, .zr-sb-note { padding: 8px; font-size: 12px; color: var(--fill-secondary); }
.zr-sb-error { margin: 0; font-size: 12px; color: #c7372f; white-space: pre-wrap; }
#zotrecall-menu { position: fixed; z-index: 100000; min-width: 210px; padding: 4px; border: 1px solid var(--fill-quinary); border-radius: 7px; background: var(--material-background); box-shadow: 0 6px 20px rgba(0,0,0,.25); display: flex; flex-direction: column; }
.zr-menu-item { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 5px 10px; border: 0; border-radius: 4px; background: none; color: var(--fill-primary); font: inherit; text-align: left; cursor: default; }
.zr-menu-item:hover:not(:disabled) { background: var(--accent-blue, #2f6fde); color: #fff; }
.zr-menu-item:hover:not(:disabled) .zr-menu-key { color: rgba(255,255,255,.8); }
.zr-menu-item:disabled { opacity: .4; }
.zr-menu-key { font-size: 11px; color: var(--fill-secondary); font-weight: 500; }
.zr-menu-sep { height: 1px; margin: 4px 6px; background: var(--fill-quinary); }
.zr-menu-sep:first-child, .zr-menu-sep + .zr-menu-sep, .zr-menu-sep:last-child { display: none; }
@media (prefers-color-scheme: dark) {
	.zr-sb-done { color: #8fd16a; }
	.zr-sb-changed { background: rgba(241,152,55,.22); color: #f5b46c; }
	.zr-sb-new { color: #7fa9f7; }
	.zr-sb-edited { color: #6ec6f5; }
}
`;
	},
};
