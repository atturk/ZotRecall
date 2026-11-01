'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../addon/content/core.js');

// Minimal DOM implementation sufficient to exercise ZotRecallSidebar and ZotRecallUI
function createMockDOM() {
	let listenersByTarget = new WeakMap();
	let addListener = (target, type, fn, capture = false) => {
		if (!listenersByTarget.has(target)) listenersByTarget.set(target, []);
		listenersByTarget.get(target).push({ type, fn, capture: Boolean(capture) });
	};
	let removeListener = (target, type, fn, capture = false) => {
		let list = listenersByTarget.get(target);
		if (!list) return;
		listenersByTarget.set(
			target,
			list.filter(l => !(l.type === type && l.fn === fn && l.capture === Boolean(capture)))
		);
	};

	class MockNode {
		constructor(nodeType) {
			this.nodeType = nodeType;
			this.parentNode = null;
			this.childNodes = [];
		}
		get parentElement() {
			return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
		}
		get firstChild() {
			return this.childNodes[0] || null;
		}
		get lastChild() {
			return this.childNodes[this.childNodes.length - 1] || null;
		}
		get isConnected() {
			let cur = this;
			while (cur.parentNode) cur = cur.parentNode;
			return cur === doc || cur === doc.documentElement || cur === doc.body || cur === doc.head;
		}
		append(...nodes) {
			for (let n of nodes) {
				if (n === null || n === undefined) continue;
				let child = typeof n === 'string' ? doc.createTextNode(n) : n;
				if (child.parentNode) child.remove();
				child.parentNode = this;
				this.childNodes.push(child);
			}
		}
		replaceChildren(...nodes) {
			for (let c of this.childNodes) c.parentNode = null;
			this.childNodes = [];
			this.append(...nodes);
		}
		replaceWith(next) {
			if (!this.parentNode) return;
			let idx = this.parentNode.childNodes.indexOf(this);
			if (idx >= 0) {
				if (next.parentNode) next.remove();
				next.parentNode = this.parentNode;
				this.parentNode.childNodes[idx] = next;
				this.parentNode = null;
			}
		}
		remove() {
			if (!this.parentNode) return;
			let idx = this.parentNode.childNodes.indexOf(this);
			if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
			this.parentNode = null;
		}
		contains(other) {
			let cur = other;
			while (cur) {
				if (cur === this) return true;
				cur = cur.parentNode;
			}
			return false;
		}
		addEventListener(type, fn, capture = false) {
			addListener(this, type, fn, capture);
		}
		removeEventListener(type, fn, capture = false) {
			removeListener(this, type, fn, capture);
		}
		dispatchEvent(event) {
			event.target = event.target || this;
			let pathNodes = [];
			let cur = this;
			while (cur) {
				pathNodes.push(cur);
				cur = cur.parentNode;
			}
			pathNodes.push(doc);
			// Capture phase
			for (let i = pathNodes.length - 1; i >= 0; i--) {
				let node = pathNodes[i];
				let list = (listenersByTarget.get(node) || []).slice();
				for (let l of list) {
					if (l.type === event.type && l.capture) {
						l.fn.call(node, event);
						if (event._stopped) return !event.defaultPrevented;
					}
				}
			}
			// Bubble phase
			for (let i = 0; i < pathNodes.length; i++) {
				let node = pathNodes[i];
				let list = (listenersByTarget.get(node) || []).slice();
				for (let l of list) {
					if (l.type === event.type && !l.capture) {
						l.fn.call(node, event);
						if (event._stopped) return !event.defaultPrevented;
					}
				}
			}
			return !event.defaultPrevented;
		}
	}

	class MockText extends MockNode {
		constructor(text) {
			super(3);
			this.textContent = String(text || '');
		}
	}

	class MockElement extends MockNode {
		constructor(tagName) {
			super(1);
			this.tagName = String(tagName || 'div').toUpperCase();
			this.attributes = new Map();
			this.style = {};
			this.value = '';
			this.checked = false;
			this.disabled = false;
			this.hidden = false;
			this.offsetWidth = 220;
			this.offsetHeight = 180;
			this.scrollHeight = 64;
			this.scrollTop = 0;
			let self = this;
			this.classList = {
				_set() {
					return new Set(String(self.className || '').split(/\s+/).filter(Boolean));
				},
				_sync(s) {
					self.className = Array.from(s).join(' ');
				},
				add(...names) {
					let s = this._set();
					names.forEach(n => s.add(n));
					this._sync(s);
				},
				remove(...names) {
					let s = this._set();
					names.forEach(n => s.delete(n));
					this._sync(s);
				},
				toggle(name, force) {
					let s = this._set();
					let shouldAdd = force === undefined ? !s.has(name) : Boolean(force);
					if (shouldAdd) s.add(name);
					else s.delete(name);
					this._sync(s);
					return shouldAdd;
				},
				contains(name) {
					return this._set().has(name);
				},
			};
		}
		get id() {
			return this.attributes.get('id') || '';
		}
		set id(v) {
			if (v) this.attributes.set('id', String(v));
			else this.attributes.delete('id');
		}
		get className() {
			return this.attributes.get('class') || '';
		}
		set className(v) {
			if (v) this.attributes.set('class', String(v));
			else this.attributes.delete('class');
		}
		get isContentEditable() {
			return this.getAttribute('contenteditable') === 'true';
		}
		get children() {
			return this.childNodes.filter(c => c.nodeType === 1);
		}
		get textContent() {
			return this.childNodes.map(c => c.textContent).join('');
		}
		set textContent(v) {
			this.replaceChildren();
			if (v !== '' && v !== null && v !== undefined) {
				this.append(doc.createTextNode(String(v)));
			}
		}
		setAttribute(k, v) {
			if (k === 'disabled') this.disabled = true;
			if (k === 'hidden') this.hidden = true;
			this.attributes.set(k, String(v));
		}
		getAttribute(k) {
			return this.attributes.has(k) ? this.attributes.get(k) : null;
		}
		hasAttribute(k) {
			return this.attributes.has(k);
		}
		removeAttribute(k) {
			if (k === 'disabled') this.disabled = false;
			if (k === 'hidden') this.hidden = false;
			this.attributes.delete(k);
		}
		matches(selector) {
			return selector.split(',').some((part) => {
				let s = part.trim();
				if (!s) return false;
				if (s === '[contenteditable="true"]') return this.getAttribute('contenteditable') === 'true';
				if (s === '[contenteditable]') return this.hasAttribute('contenteditable');
				if (s.startsWith('#')) return this.id === s.slice(1);
				if (s.startsWith('.')) {
					let classes = s.slice(1).split('.');
					return classes.every(c => this.classList.contains(c));
				}
				return this.tagName.toLowerCase() === s.toLowerCase();
			});
		}
		closest(selector) {
			let cur = this;
			while (cur && cur.nodeType === 1) {
				if (cur.matches(selector)) return cur;
				cur = cur.parentElement;
			}
			return null;
		}
		querySelectorAll(selector) {
			let results = [];
			let parts = selector.trim().split(/\s+/);
			let visit = (node) => {
				for (let child of node.childNodes) {
					if (child.nodeType === 1) {
						let match = false;
						if (parts.length > 1) {
							if (child.matches(parts[parts.length - 1])) {
								let anc = child.parentElement;
								let idx = parts.length - 2;
								while (anc && idx >= 0) {
									if (anc.matches(parts[idx])) idx--;
									anc = anc.parentElement;
								}
								match = idx < 0;
							}
						}
						else {
							match = child.matches(parts[0]);
						}
						if (match) results.push(child);
						visit(child);
					}
				}
			};
			visit(this);
			return results;
		}
		querySelector(selector) {
			return this.querySelectorAll(selector)[0] || null;
		}
		getBoundingClientRect() {
			return { left: 20, top: 20, right: 320, bottom: 520, width: 300, height: 500 };
		}
		focus() {
			doc.activeElement = this;
		}
		scrollIntoView() {
			this._scrolledIntoView = true;
		}
		click() {
			this.dispatchEvent(makeEvent('click'));
		}
	}

	function makeEvent(type, props = {}) {
		return Object.assign({
			type,
			defaultPrevented: false,
			_stopped: false,
			preventDefault() {
				this.defaultPrevented = true;
			},
			stopPropagation() {
				this._stopped = true;
			},
		}, props);
	}

	let doc = {
		documentElement: null,
		head: null,
		body: null,
		activeElement: null,
		defaultView: null,
		createElement(tag) {
			if (tag === 'template') {
				let content = new MockElement('fragment');
				let tpl = new MockElement('template');
				tpl.content = content;
				Object.defineProperty(tpl, 'innerHTML', {
					get: () => content.textContent,
					set: (html) => {
						content.textContent = String(html || '');
					},
				});
				return tpl;
			}
			return new MockElement(tag);
		},
		createElementNS(_ns, tag) {
			return new MockElement(tag);
		},
		createTextNode(text) {
			return new MockText(text);
		},
		getElementById(id) {
			let found = null;
			let visit = (node) => {
				if (found || !node) return;
				if (node.nodeType === 1 && node.id === id) {
					found = node;
					return;
				}
				for (let c of node.childNodes || []) visit(c);
			};
			visit(this.documentElement);
			return found;
		},
		querySelectorAll(sel) {
			return this.documentElement.querySelectorAll(sel);
		},
		querySelector(sel) {
			return this.documentElement.querySelector(sel);
		},
		addEventListener(type, fn, capture = false) {
			addListener(this, type, fn, capture);
		},
		removeEventListener(type, fn, capture = false) {
			removeListener(this, type, fn, capture);
		},
		dispatchEvent(event) {
			let list = (listenersByTarget.get(this) || []).slice();
			for (let l of list) {
				if (l.type === event.type) {
					l.fn.call(this, event);
					if (event._stopped) break;
				}
			}
		},
	};

	doc.documentElement = new MockElement('html');
	doc.documentElement.parentNode = doc;
	doc.head = new MockElement('head');
	doc.body = new MockElement('body');
	doc.documentElement.append(doc.head, doc.body);

	// Standard Zotero reader sidebar skeleton
	let sidebarContainer = new MockElement('div');
	sidebarContainer.id = 'sidebarContainer';
	let toolbar = new MockElement('div');
	toolbar.className = 'sidebar-toolbar';
	let start = new MockElement('div');
	start.className = 'start';
	let nativeBtn = new MockElement('button');
	nativeBtn.className = 'toolbar-button active';
	start.append(nativeBtn);
	let end = new MockElement('div');
	end.className = 'end';
	toolbar.append(start, end);
	let sidebarContent = new MockElement('div');
	sidebarContent.id = 'sidebarContent';
	sidebarContainer.append(toolbar, sidebarContent);
	doc.body.append(sidebarContainer);

	doc.defaultView = {
		innerWidth: 1200,
		innerHeight: 800,
		top: { document: doc },
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		requestAnimationFrame: fn => fn(),
		setInterval: () => 1,
		clearInterval: () => {},
		addEventListener: () => {},
	};

	return { doc, makeEvent };
}

function loadEnvironment() {
	let { doc, makeEvent } = createMockDOM();
	let uiCode = fs.readFileSync(path.join(__dirname, '../addon/content/ui.js'), 'utf8');
	let sbCode = fs.readFileSync(path.join(__dirname, '../addon/content/sidebar.js'), 'utf8');
	let sandbox = {
		ZotRecallCore: Core,
		Zotero: {
			logError: () => {},
			getMainWindow: () => ({ document: doc }),
		},
		console,
		Set,
		Map,
		WeakMap,
		Array,
		Object,
		String,
		Number,
		Boolean,
		Math,
		Date,
		JSON,
		RegExp,
		Error,
		Promise,
	};
	vm.createContext(sandbox);
	vm.runInContext(uiCode, sandbox);
	vm.runInContext(sbCode, sandbox);
	return {
		doc,
		makeEvent,
		UI: sandbox.ZotRecallUI,
		Sidebar: sandbox.ZotRecallSidebar,
	};
}

function makeFixtureApp(sentences, store, settingsOverrides = {}) {
	let savedCount = 0;
	let navigated = [];
	let attachment = {
		key: 'ATT1',
		isPDFAttachment: () => true,
	};
	let reader = {
		_iframeWindow: null,
		_internalReader: { _state: { sidebarOpen: true }, toggleSidebar: () => {} },
		navigate: (loc) => navigated.push(loc),
	};
	let settings = Object.assign({
		model: 'test-model',
		language: 'Italiano',
		colorMeanings: {},
		disabledColors: [],
		concurrency: 2,
		ankiURL: 'http://127.0.0.1:8765',
		ankiKey: '',
		closeOnOutsideClick: true,
		shortcuts: { exclude: 'e', edit: 'm' },
	}, settingsOverrides);
	let ankiCfg = { deck: 'Medicina::Patologia', model: 'Basic', front: 'Front', back: 'Back', tags: 'robbins::cap-4' };
	let app = {
		NO_PARENT_MESSAGE: 'No parent',
		getAttachment: () => attachment,
		getParent: () => ({ id: 1 }),
		getAnnotations: () => [{ key: 'A1', color: '#ffd400', dateModified: '1' }],
		getCurrentPageIndex: () => 0,
		countPageHighlights: () => sentences.filter(s => s.pageIndex === 0).length,
		extract: async () => ({ sentences, unmatched: [] }),
		loadStore: () => store,
		saveStore: async (_att, nextStore) => {
			store = nextStore;
			savedCount++;
		},
		updateReview: async (_att, fn) => {
			fn(store);
			savedCount++;
			return store;
		},
		getSettings: () => settings,
		saveSettings: (next) => {
			Object.assign(settings, next);
		},
		getAnkiConfig: () => ankiCfg,
		saveAnkiConfig: (next) => {
			Object.assign(ankiCfg, next);
		},
		getPref: () => false,
	};
	return { app, reader, attachment, navigated, getSavedCount: () => savedCount };
}

function makeThreeSentencesAndStore() {
	let s1 = {
		key: 'k_p1_edema',
		fingerprint: 'fp1',
		paragraphId: 'b0',
		pageIndex: 0,
		text: 'Edema is important primarily because it points to cardiac or renal disease.',
		spans: [{ start: 0, end: 5, key: 'A1', color: '#ffd400' }],
		section: 'Edema',
		opening: '',
		before: ['Prev sentence 1.'],
		after: ['Next sentence 1.'],
	};
	let s2 = {
		key: 'k_p1_lymph',
		fingerprint: 'fp2',
		paragraphId: 'b1',
		pageIndex: 1,
		text: 'Trauma, fibrosis, invasive tumors, and infectious agents can disrupt lymphatic vessels.',
		spans: [{ start: 0, end: 33, key: 'A2', color: '#ffd400' }],
		section: 'Edema',
		opening: '',
		before: [],
		after: [],
	};
	let s3 = {
		key: 'k_p4_hemo',
		fingerprint: 'fp3',
		paragraphId: 'b2',
		pageIndex: 3,
		text: 'Hemorrhagic disorders are characterized by excessive bleeding.',
		spans: [{ start: 0, end: 21, key: 'A3', color: '#ffd400' }],
		section: 'Hemostasis',
		opening: '',
		before: [],
		after: [],
	};
	let sentences = [s1, s2, s3];
	let store = Core.emptyStore('ATT1');
	let groups = Core.planGeneration(sentences, store);
	for (let g of groups) {
		let { idMap } = Core.buildMessages(g);
		if (g.paragraphId === 'b0') {
			Core.applyResults(store, g, Core.parseResponse('{"groups":[{"sentence_ids":["s1"],"questions":["Q1 edema?"]}],"skipped":[]}', idMap).results);
		}
		else if (g.paragraphId === 'b1') {
			Core.applyResults(store, g, Core.parseResponse('{"groups":[{"sentence_ids":["s1"],"questions":["Q2 lymph 1?","Q2 lymph 2?","Q2 lymph 3?"]}],"skipped":[]}', idMap).results);
		}
		else if (g.paragraphId === 'b2') {
			Core.applyResults(store, g, Core.parseResponse('{"groups":[{"sentence_ids":["s1"],"questions":["Q3 hemo 1?","Q3 hemo 2?"]}],"skipped":[]}', idMap).results);
		}
	}
	return { sentences, store };
}

test('sidebar container layout regression: #zotrecall-sidebar-view never has .preview-popup and fills 100% height/width', async () => {
	let { doc, UI, Sidebar } = loadEnvironment();
	let { sentences, store } = makeThreeSentencesAndStore();
	let { app, reader } = makeFixtureApp(sentences, store);
	reader._iframeWindow = { document: doc };
	UI.init(app);
	Sidebar.init(app, UI);

	assert.equal(Sidebar.ensure(reader, doc), true);
	let view = doc.getElementById('zotrecall-sidebar-view');
	assert.ok(view, '#zotrecall-sidebar-view is created');
	assert.equal(view.classList.contains('viewWrapper'), true);
	assert.equal(view.classList.contains('preview-popup'), false, 'must NOT have .preview-popup class');

	// Even if an older version left .preview-popup on the node, ensure() strips it
	view.classList.add('preview-popup');
	Sidebar.ensure(reader, doc);
	assert.equal(view.classList.contains('preview-popup'), false, 'ensure() removes stale .preview-popup');

	let css = doc.getElementById('zotrecall-sidebar-style').textContent;
	assert.ok(css.includes('#zotrecall-sidebar-view { display: none; width: 100%; height: 100%; max-width: none; max-height: none;'));
});

test('sidebar action buttons are icon-only with tooltips and clicking a period card badge opens the exact period card subset in preview', async () => {
	let { doc, UI, Sidebar } = loadEnvironment();
	let { sentences, store } = makeThreeSentencesAndStore();
	let { app, reader } = makeFixtureApp(sentences, store);
	reader._iframeWindow = { document: doc };
	UI.init(app);
	Sidebar.init(app, UI);

	// Mark period 1 (1 card) and period 2 (3 cards) as sent; leave period 3 (2 cards) unsent
	let tags = Core.parseTags(app.getAnkiConfig().tags);
	let [u1, u2] = Core.buildUnits(sentences, store);
	for (let c of Core.unitCards(store, u1)) Core.markSent(store, c, { noteId: 101, deck: 'Medicina::Patologia', tags });
	for (let c of Core.unitCards(store, u2)) Core.markSent(store, c, { noteId: 102, deck: 'Medicina::Patologia', tags });

	Sidebar.ensure(reader, doc);
	Sidebar.activate(doc);
	await Sidebar.render(doc);

	let view = doc.getElementById('zotrecall-sidebar-view');
	let iconBtns = view.querySelectorAll('.zr-sb-icon-btn');
	assert.equal(iconBtns.length, 4, '4 icon-only action buttons in sidebar header');
	for (let btn of iconBtns) {
		assert.ok(btn.getAttribute('title'), 'each icon button has a tooltip');
		assert.equal(btn.textContent, '', 'icon buttons have no text label');
	}

	let unitNodes = view.querySelectorAll('.zr-sb-unit');
	assert.equal(unitNodes.length, 3);
	let badge1 = unitNodes[0].querySelector('.zr-sb-cards');
	let badge2 = unitNodes[1].querySelector('.zr-sb-cards');
	let badge3 = unitNodes[2].querySelector('.zr-sb-cards');
	assert.equal(badge1.textContent, '1 carta');
	assert.equal(badge2.textContent, '3 carte');
	assert.equal(badge3.textContent, '2 carte');

	// Clicking "1 carta" on period 1 (already sent) while period 3 has 2 unsent cards:
	// preview MUST show "1 di 1" with "Q1 edema?", NEVER "4 di 4" or period 3's cards!
	badge1.click();
	let popup = doc.getElementById('zotrecall-popup');
	assert.ok(popup, 'preview popup opened');
	let meta1 = popup.querySelector('.zr-meta-row').textContent;
	assert.ok(meta1.startsWith('1 di 1 '), `expected "1 di 1", got "${meta1}"`);
	assert.equal(popup.querySelector('.zr-card-q').textContent, 'Q1 edema?');

	// Clicking "3 carte" on period 2 (all 3 already sent):
	// preview MUST show "1 di 3" with "Q2 lymph 1?", NOT "1 di 1"!
	badge2.click();
	let meta2 = popup.querySelector('.zr-meta-row').textContent;
	assert.ok(meta2.startsWith('1 di 3 '), `expected "1 di 3", got "${meta2}"`);
	assert.equal(popup.querySelector('.zr-card-q').textContent, 'Q2 lymph 1?');
});

test('sidebar keyboard navigation (ArrowDown/ArrowUp, Shift+Arrow), selection-order merge, and configurable shortcuts (E/M)', async () => {
	let { doc, makeEvent, UI, Sidebar } = loadEnvironment();
	let { sentences, store } = makeThreeSentencesAndStore();
	let { app, reader, navigated } = makeFixtureApp(sentences, store);
	reader._iframeWindow = { document: doc };
	UI.init(app);
	Sidebar.init(app, UI);

	Sidebar.ensure(reader, doc);
	Sidebar.activate(doc);
	await Sidebar.render(doc);

	// Press ArrowDown -> selects first unit (index 0)
	doc.dispatchEvent(makeEvent('keydown', { key: 'ArrowDown', target: doc.body }));
	let state = Sidebar._states.get(doc);
	assert.deepEqual(Array.from(state.selected), [sentences[0].key]);
	assert.equal(navigated.length, 1);

	// Press ArrowDown twice -> moves to third unit (page 4, index 2)
	doc.dispatchEvent(makeEvent('keydown', { key: 'ArrowDown', target: doc.body }));
	doc.dispatchEvent(makeEvent('keydown', { key: 'ArrowDown', target: doc.body }));
	assert.deepEqual(Array.from(state.selected), [sentences[2].key]);

	// Hold Shift + ArrowUp -> adds second unit AFTER third unit (preserving reverse selection order: [s3, s2])
	doc.dispatchEvent(makeEvent('keydown', { key: 'ArrowUp', shiftKey: true, target: doc.body }));
	assert.deepEqual(Array.from(state.selected), [sentences[2].key, sentences[1].key]);
	assert.deepEqual(Sidebar.selectedUnits(state).map(u => u.id), [sentences[2].key, sentences[1].key]);

	// Merge selected units -> merged in selection order [s3, s2], NOT document order [s2, s3]
	await Sidebar.merge(doc, Sidebar.selectedUnits(state));
	let mergedUnits = Core.buildUnits(sentences, store);
	assert.equal(mergedUnits.length, 2);
	let mergedUnit = mergedUnits.find(u => u.merged);
	assert.deepEqual(mergedUnit.keys, [sentences[2].key, sentences[1].key]);

	// Select first unit and press 'e' (default shortcut for Exclude)
	state.selected = new Set([sentences[0].key]);
	Sidebar.updateSelection(doc);
	doc.dispatchEvent(makeEvent('keydown', { key: 'e', target: doc.body }));
	await new Promise(r => setImmediate(r));
	assert.equal(Core.buildUnits(sentences, store)[0].excluded, true, 'E shortcut excluded the selected unit');

	// Press 'm' (default shortcut for Edit) -> enters inline editing mode for the selected unit
	state.selected = new Set([sentences[0].key]);
	doc.dispatchEvent(makeEvent('keydown', { key: 'm', target: doc.body }));
	await new Promise(r => setImmediate(r));
	assert.equal(state.editingUnitId, sentences[0].key, 'M shortcut opened inline period editor');

	// While editing, pressing 'e' inside the editor does NOT trigger the exclude shortcut
	let view = doc.getElementById('zotrecall-sidebar-view');
	let editor = view.querySelector('.zr-sb-editor');
	assert.ok(editor, 'inline editor rendered');
	let excludedBefore = Core.buildUnits(sentences, store)[0].excluded;
	editor.dispatchEvent(makeEvent('keydown', { key: 'e', target: editor }));
	assert.equal(Core.buildUnits(sentences, store)[0].excluded, excludedBefore);

	// Custom shortcut in settings (e.g. X for exclude)
	state.editingUnitId = null;
	app.saveSettings({ shortcuts: { exclude: 'x', edit: 'k' } });
	state.selected = new Set([sentences[0].key]);
	doc.dispatchEvent(makeEvent('keydown', { key: 'x', target: doc.body }));
	await new Promise(r => setImmediate(r));
	assert.equal(Core.buildUnits(sentences, store)[0].excluded, false, 'custom X shortcut re-included the unit');
});

test('sidebar inline period editor extracts edited text and highlights and persists them to store', async () => {
	let { doc, UI, Sidebar } = loadEnvironment();
	let { sentences, store } = makeThreeSentencesAndStore();
	let { app, reader } = makeFixtureApp(sentences, store);
	reader._iframeWindow = { document: doc };
	UI.init(app);
	Sidebar.init(app, UI);

	Sidebar.ensure(reader, doc);
	Sidebar.activate(doc);
	await Sidebar.render(doc);

	let state = Sidebar._states.get(doc);
	let unit0 = state.units[0];
	Sidebar.startEditUnit(doc, unit0);
	await Sidebar.render(doc);

	let view = doc.getElementById('zotrecall-sidebar-view');
	let editor = view.querySelector('.zr-sb-editor');
	assert.ok(editor, 'editor is mounted');

	// Modify content inside editor: plain text + highlighted span
	editor.replaceChildren(
		doc.createTextNode('Modified period with '),
		UI.h(doc, 'span', { class: 'zr-sb-hl', 'data-color': '#5fb236', text: 'green highlight' }),
		doc.createTextNode('.')
	);
	let extracted = Sidebar.extractUnitEdit(editor, '#ffd400');
	assert.equal(extracted.text, 'Modified period with green highlight.');
	assert.deepEqual(extracted.spans, [{ start: 21, end: 36, color: '#5fb236' }]);

	// Click "Salva" button inside .zr-sb-edit-actions
	let saveBtn = view.querySelectorAll('.zr-sb-edit-actions .zr-sb-btn')[1];
	saveBtn.click();
	await new Promise(r => setImmediate(r));

	let updatedUnit = Core.buildUnits(sentences, store)[0];
	assert.equal(updatedUnit.edited, true);
	assert.equal(updatedUnit.renderSentences[0].text, 'Modified period with green highlight.');

	// Reset unit edit restores original PDF sentence
	await Sidebar.resetUnitEdit(doc, updatedUnit);
	let restoredUnit = Core.buildUnits(sentences, store)[0];
	assert.equal(restoredUnit.edited, false);
	assert.equal(restoredUnit.renderSentences[0].text, sentences[0].text);
});

test('context menu items, deck autocomplete, and general preview filtering of sent cards', async () => {
	let { doc, makeEvent, UI, Sidebar } = loadEnvironment();
	let { sentences, store } = makeThreeSentencesAndStore();
	let { app, reader } = makeFixtureApp(sentences, store);
	app.ankiOptions = async () => ({
		decks: ['Default', 'Medicina::Patologia Generale::Robbins', 'Medicina::Farmacologia'],
		models: ['Basic'],
	});
	app.ankiFields = async () => ['Front', 'Back'];
	reader._iframeWindow = { document: doc };
	UI.init(app);
	Sidebar.init(app, UI);

	Sidebar.ensure(reader, doc);
	Sidebar.activate(doc);
	await Sidebar.render(doc);

	// 1. Context menu shows "Modifica periodo" with shortcut M, and "Ripristina periodo originale" only when edited
	let state = Sidebar._states.get(doc);
	state.selected = new Set([state.units[0].id]);
	Sidebar.openMenu(doc, state.units[0], 100, 100);
	let menu = doc.getElementById('zotrecall-menu');
	assert.ok(menu);
	assert.ok(menu.textContent.includes('Modifica periodo'));
	assert.ok(!menu.textContent.includes('Ripristina periodo originale'));

	Core.setUnitEdit(store, state.units[0].keys, { text: 'Edited text.', spans: [{ start: 0, end: 6, color: '#ffd400' }] });
	await Sidebar.render(doc);
	Sidebar.openMenu(doc, state.units[0], 100, 100);
	menu = doc.getElementById('zotrecall-menu');
	assert.ok(menu.textContent.includes('Ripristina periodo originale'));
	menu.remove();

	// 2. Deck autocomplete: typing filters decks, ArrowDown + Enter selects, new name keeps isNewDeck() = true
	let form = await UI.ankiForm(doc);
	let deckInput = form.node.querySelector('.zr-input');
	let comboList = form.node.querySelector('.zr-combo-list');
	assert.equal(comboList.hidden, true, 'dropdown hidden initially');

	deckInput.value = 'patologia';
	deckInput.dispatchEvent(makeEvent('input'));
	assert.equal(comboList.hidden, false, 'dropdown opens when typing matching query');
	assert.equal(comboList.children.length, 1);
	deckInput.dispatchEvent(makeEvent('keydown', { key: 'Enter' }));
	assert.equal(deckInput.value, 'Medicina::Patologia Generale::Robbins');
	assert.equal(form.isNewDeck(), false);

	deckInput.value = 'Medicina::NuovoMazzo';
	deckInput.dispatchEvent(makeEvent('input'));
	assert.equal(form.isNewDeck(), true, 'new deck creation preserved when typing a non-existing deck');

	// 3. Reopening general preview shows only unsent cards (and message when all are sent)
	let tags = Core.parseTags(app.getAnkiConfig().tags);
	let all = Core.activeCards(store);
	for (let c of all.slice(0, 4)) Core.markSent(store, c, { noteId: 500, deck: 'Medicina::Patologia', tags });
	UI.open(reader, 'preview');
	let popup = doc.getElementById('zotrecall-popup');
	assert.ok(popup.querySelector('.zr-meta-row').textContent.startsWith('1 di 2 '), 'only the 2 unsent cards appear in general preview');
});

