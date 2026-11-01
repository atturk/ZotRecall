/*
 * ZotRecall core: pure logic, no Zotero APIs.
 *
 * Loaded in Zotero via Services.scriptloader.loadSubScript() (defines the
 * global ZotRecallCore) and in Node via require() for tests.
 *
 * Input text comes from Zotero's Structured Document Text (SDT), the
 * paragraph-level extraction Zotero 10 builds for every PDF.
 */
var ZotRecallCore = (function () {
	'use strict';

	// ------------------------------------------------------------------
	// Colors
	// ------------------------------------------------------------------

	// Zotero's annotation palette, in the order shown in the reader
	const ZOTERO_COLORS = [
		{ name: 'yellow', hex: '#ffd400' },
		{ name: 'red', hex: '#ff6666' },
		{ name: 'green', hex: '#5fb236' },
		{ name: 'blue', hex: '#2ea8e5' },
		{ name: 'purple', hex: '#a28ae5' },
		{ name: 'magenta', hex: '#e56eee' },
		{ name: 'orange', hex: '#f19837' },
		{ name: 'gray', hex: '#aaaaaa' },
	];

	function hexToRGB(hex) {
		let m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
		if (!m) return null;
		let n = parseInt(m[1], 16);
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	}

	function rgbToHSL([r, g, b]) {
		r /= 255;
		g /= 255;
		b /= 255;
		let max = Math.max(r, g, b);
		let min = Math.min(r, g, b);
		let l = (max + min) / 2;
		let d = max - min;
		let s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
		let h = 0;
		if (d) {
			if (max === r) h = ((g - b) / d) % 6;
			else if (max === g) h = (b - r) / d + 2;
			else h = (r - g) / d + 4;
			h *= 60;
			if (h < 0) h += 360;
		}
		return [h, s, l];
	}

	/** Name of the Zotero palette color closest to `hex` (custom colors included). */
	function colorName(hex) {
		let rgb = hexToRGB(hex);
		if (!rgb) return 'yellow';
		let [h, s, l] = rgbToHSL(rgb);
		if (s < 0.15) return 'gray';
		let best = null;
		let bestDist = Infinity;
		for (let c of ZOTERO_COLORS) {
			if (c.name === 'gray') continue;
			let [h2, s2, l2] = rgbToHSL(hexToRGB(c.hex));
			let dh = Math.min(Math.abs(h - h2), 360 - Math.abs(h - h2)) / 180;
			let d = dh * dh * 4 + (s - s2) ** 2 * 0.5 + (l - l2) ** 2;
			if (d < bestDist) {
				bestDist = d;
				best = c.name;
			}
		}
		return best;
	}

	// ------------------------------------------------------------------
	// Hashing (deterministic, non-cryptographic)
	// ------------------------------------------------------------------

	function fnv1a(str, seed) {
		let h = seed >>> 0;
		for (let i = 0; i < str.length; i++) {
			h ^= str.charCodeAt(i);
			h = Math.imul(h, 16777619) >>> 0;
		}
		return h;
	}

	function hash(str) {
		str = String(str);
		let a = fnv1a(str, 2166136261).toString(16).padStart(8, '0');
		let b = fnv1a(str, 0x9747b28c).toString(16).padStart(8, '0');
		return a + b;
	}

	function normalizeText(text) {
		return String(text).normalize('NFC').replace(/\s+/g, ' ').trim();
	}

	// ------------------------------------------------------------------
	// SDT decoding
	// ------------------------------------------------------------------

	const HEADER_LAST_IS_SOFT_HYPHEN = 1;
	const HEADER_AXIS_DIR_SHIFT = 1;

	function isWhitespace(ch) {
		return /\s/.test(ch);
	}

	/**
	 * Decode a PDF text node's textMap into one {pageIndex, rect} per
	 * non-whitespace character, in text order.
	 * Run format: [header, pageIndex, minX, minY, maxX, maxY, ...widths],
	 * where a width is a number or a [delta, width] pair.
	 */
	function decodeTextMap(textMap) {
		let runs;
		try {
			runs = typeof textMap === 'string' ? JSON.parse(textMap) : textMap;
		}
		catch (e) {
			return [];
		}
		if (!Array.isArray(runs)) return [];
		let out = [];
		for (let run of runs) {
			if (!Array.isArray(run) || run.length < 6) continue;
			let [header, pageIndex, minX, minY, maxX, maxY, ...widths] = run;
			let axisDir = (header >> HEADER_AXIS_DIR_SHIFT) & 3;
			let vertical = axisDir === 1 || axisDir === 3;
			let start = vertical ? minY : minX;
			let end = vertical ? maxY : maxX;
			let positions = [];
			if (!widths.length) {
				positions.push([start, end]);
			}
			else {
				let pos = start;
				for (let w of widths) {
					if (Array.isArray(w)) {
						pos += w[0];
						positions.push([pos, pos + w[1]]);
						pos += w[1];
					}
					else {
						positions.push([pos, pos + w]);
						pos += w;
					}
				}
			}
			if (header & HEADER_LAST_IS_SOFT_HYPHEN) {
				positions.pop();
			}
			for (let [a, b] of positions) {
				out.push({
					pageIndex,
					rect: vertical ? [minX, a, maxX, b] : [a, minY, b, maxY],
				});
			}
		}
		return out;
	}

	function isTextNode(node) {
		return node && typeof node === 'object' && typeof node.text === 'string';
	}

	function refKey(ref) {
		return Array.isArray(ref) ? ref.join('.') : String(ref);
	}

	/** Text plus per-character geometry (null for whitespace) of a leaf block. */
	function leafText(nodes) {
		let text = '';
		let chars = [];
		let bold = [];
		for (let node of nodes) {
			if (!isTextNode(node)) continue;
			let t = node.text;
			let mapped = decodeTextMap(node.anchor && node.anchor.textMap);
			let k = 0;
			for (let i = 0; i < t.length; i++) {
				if (isWhitespace(t[i])) {
					chars.push(null);
				}
				else {
					chars.push(k < mapped.length ? mapped[k++] : null);
				}
				bold.push(!!(node.style && node.style.bold));
			}
			text += t;
		}
		return { text, chars, bold };
	}

	/**
	 * Flatten an SDT document into logical paragraphs.
	 *
	 * - Blocks with flowClass "excluded" (running headers, page numbers) are dropped.
	 * - Physical parts of one logical block (previousPart/nextPart, e.g. a
	 *   paragraph that continues on the next page) are joined.
	 * - Each paragraph remembers the most recent heading as its section.
	 *
	 * @returns {Array<{id, kind, text, chars, bold, section, pageIndex}>}
	 */
	function flattenDocument(sdt) {
		let paragraphs = [];
		let byRef = new Map();
		let section = '';

		function visit(block, ref) {
			if (!block || typeof block !== 'object') return;
			if (ref.length === 1 && block.flowClass === 'excluded') return;
			let content = Array.isArray(block.content) ? block.content : [];
			if (content.length && isTextNode(content[0])) {
				let { text, chars, bold } = leafText(content);
				if (block.type === 'heading') {
					let headingText = normalizeText(text);
					if (block.previousPart && byRef.has(refKey(block.previousPart))) {
						let prev = byRef.get(refKey(block.previousPart));
						prev.text = normalizeText(prev.text + ' ' + headingText);
						section = prev.text;
						byRef.set(refKey(ref), prev);
					}
					else {
						section = headingText;
						byRef.set(refKey(ref), { heading: true, text: headingText });
					}
					return;
				}
				if (block.previousPart && byRef.has(refKey(block.previousPart))) {
					let prev = byRef.get(refKey(block.previousPart));
					if (prev && !prev.heading) {
						if (prev.text.length && !isWhitespace(prev.text[prev.text.length - 1])
								&& text.length && !isWhitespace(text[0])) {
							prev.text += ' ';
							prev.chars.push(null);
							prev.bold.push(false);
						}
						prev.text += text;
						prev.chars.push(...chars);
						prev.bold.push(...bold);
						byRef.set(refKey(ref), prev);
						return;
					}
				}
				let first = chars.find(c => c);
				let paragraph = {
					id: 'b' + refKey(ref),
					kind: block.type || 'paragraph',
					text,
					chars,
					bold,
					section,
					pageIndex: first ? first.pageIndex : null,
				};
				paragraphs.push(paragraph);
				byRef.set(refKey(ref), paragraph);
				return;
			}
			content.forEach((child, i) => visit(child, ref.concat(i)));
		}

		(sdt && Array.isArray(sdt.content) ? sdt.content : []).forEach((b, i) => visit(b, [i]));
		return paragraphs;
	}

	// ------------------------------------------------------------------
	// Highlights -> characters
	// ------------------------------------------------------------------

	/**
	 * Normalize Zotero annotation items (or plain objects) into
	 * {key, color, sortIndex, rects: [{pageIndex, rect}]}.
	 * Accepts annotationPosition as a JSON string or object, including
	 * nextPageRects for highlights that continue on the next page.
	 */
	function normalizeAnnotation(a) {
		let position = a.position;
		if (typeof position === 'string') {
			try {
				position = JSON.parse(position);
			}
			catch (e) {
				position = null;
			}
		}
		let rects = [];
		if (position && Number.isInteger(position.pageIndex)) {
			for (let r of position.rects || []) {
				rects.push({ pageIndex: position.pageIndex, rect: r });
			}
			for (let r of position.nextPageRects || []) {
				rects.push({ pageIndex: position.pageIndex + 1, rect: r });
			}
		}
		return {
			key: a.key,
			type: a.type,
			color: (a.color || '#ffd400').toLowerCase(),
			sortIndex: a.sortIndex || '',
			text: a.text || '',
			rects,
		};
	}

	const RECT_TOLERANCE = 1;

	function charInRect(charRect, r) {
		let cx = (charRect[0] + charRect[2]) / 2;
		let cy = (charRect[1] + charRect[3]) / 2;
		return cx >= r[0] - RECT_TOLERANCE && cx <= r[2] + RECT_TOLERANCE
			&& cy >= r[1] - RECT_TOLERANCE && cy <= r[3] + RECT_TOLERANCE;
	}

	/**
	 * Mark each paragraph character with the annotation covering it.
	 * Sets paragraph.marks = Array<{key, color} | null>.
	 * @returns {Set<string>} keys of annotations that matched at least one character
	 */
	function applyAnnotations(paragraphs, annotations) {
		let anns = annotations
			.map(normalizeAnnotation)
			.filter(a => (a.type === 'highlight' || a.type === 'underline') && a.rects.length)
			.sort((a, b) => (a.sortIndex < b.sortIndex ? -1 : a.sortIndex > b.sortIndex ? 1 : 0));
		let byPage = new Map();
		for (let a of anns) {
			for (let { pageIndex, rect } of a.rects) {
				if (!byPage.has(pageIndex)) byPage.set(pageIndex, []);
				byPage.get(pageIndex).push({ ann: a, rect });
			}
		}
		let matched = new Set();
		for (let p of paragraphs) {
			p.marks = new Array(p.text.length).fill(null);
			for (let i = 0; i < p.chars.length; i++) {
				let c = p.chars[i];
				if (!c) continue;
				let candidates = byPage.get(c.pageIndex);
				if (!candidates) continue;
				// Later annotations (by position) win where highlights overlap
				for (let { ann, rect } of candidates) {
					if (charInRect(c.rect, rect)) {
						p.marks[i] = { key: ann.key, color: ann.color };
						matched.add(ann.key);
					}
				}
			}
			// Whitespace between two characters of the same annotation is part of it
			for (let i = 0; i < p.marks.length; i++) {
				if (p.marks[i] || !isWhitespace(p.text[i])) continue;
				let prev = i - 1;
				while (prev >= 0 && isWhitespace(p.text[prev])) prev--;
				let next = i + 1;
				while (next < p.text.length && isWhitespace(p.text[next])) next++;
				if (prev >= 0 && next < p.text.length && p.marks[prev] && p.marks[next]
						&& p.marks[prev].key === p.marks[next].key) {
					p.marks[i] = p.marks[prev];
				}
			}
		}
		return matched;
	}

	// ------------------------------------------------------------------
	// Sentences
	// ------------------------------------------------------------------

	const ABBREVIATIONS = new Set([
		'fig', 'figs', 'tab', 'eq', 'eqs', 'ref', 'refs', 'ch', 'chap', 'sec', 'vol', 'no', 'nos',
		'pp', 'p', 'e.g', 'i.e', 'cf', 'vs', 'etc', 'al', 'approx', 'ca', 'dr', 'prof', 'mr', 'mrs',
		'ms', 'st', 'resp', 'incl', 'max', 'min', 'spp', 'sp', 'var', 'subsp',
		// Italian
		'es', 'ecc', 'pag', 'cap', 'sez', 'vd', 'cfr',
	]);

	function endsWithAbbreviation(segment) {
		let m = /([A-Za-zÀ-ÿ.]+)\.\s*$/.exec(segment);
		if (!m) return false;
		let word = m[1].toLowerCase();
		if (ABBREVIATIONS.has(word)) return true;
		// Single initials such as "J." or "A.B."
		if (/^([a-z]\.)*[a-z]$/i.test(word)) return true;
		return false;
	}

	/** Split text into sentences: [{start, end}] (end exclusive, trimmed). */
	function segmentSentences(text, locale) {
		let raw = [];
		if (typeof Intl !== 'undefined' && Intl.Segmenter) {
			let seg = new Intl.Segmenter(locale || 'en', { granularity: 'sentence' });
			for (let s of seg.segment(text)) {
				raw.push({ start: s.index, end: s.index + s.segment.length });
			}
		}
		else {
			let re = /[^.!?]+(?:[.!?]+["')\]]*\s*|$)/g;
			let m;
			while ((m = re.exec(text)) && m[0]) {
				raw.push({ start: m.index, end: m.index + m[0].length });
			}
		}
		// ICU does not break before a lowercase letter, which misses sentences
		// starting with a Greek prefix such as "α-Granules" or "βCells"
		let split = [];
		for (let s of raw) {
			let segText = text.slice(s.start, s.end);
			let re = /[.!?]["')\]]*\s+(?=[α-ω](?:-|\p{Lu}))/gu;
			let last = 0;
			let m;
			while ((m = re.exec(segText))) {
				let cut = m.index + m[0].length;
				if (endsWithAbbreviation(segText.slice(last, cut))) continue;
				split.push({ start: s.start + last, end: s.start + cut });
				last = cut;
			}
			split.push({ start: s.start + last, end: s.end });
		}
		raw = split;
		// Merge splits after abbreviations or before a lowercase/digit continuation
		let merged = [];
		for (let s of raw) {
			let prev = merged[merged.length - 1];
			if (prev) {
				let prevText = text.slice(prev.start, prev.end);
				let curText = text.slice(s.start, s.end).trimStart();
				if (endsWithAbbreviation(prevText) || /^[a-z0-9(]/.test(curText)) {
					prev.end = s.end;
					continue;
				}
			}
			merged.push({ start: s.start, end: s.end });
		}
		let out = [];
		for (let s of merged) {
			let start = s.start;
			let end = s.end;
			while (start < end && isWhitespace(text[start])) start++;
			while (end > start && isWhitespace(text[end - 1])) end--;
			if (end > start) out.push({ start, end });
		}
		return out;
	}

	/** Collapse per-character marks into spans relative to `start`. */
	function marksToSpans(marks, text, start, end) {
		let spans = [];
		let cur = null;
		for (let i = start; i < end; i++) {
			let m = marks[i];
			if (m && cur && cur.key === m.key) {
				cur.end = i + 1 - start;
				continue;
			}
			if (cur) spans.push(cur);
			cur = m ? { start: i - start, end: i + 1 - start, key: m.key, color: m.color } : null;
		}
		if (cur) spans.push(cur);
		// Trim whitespace at span edges
		let sentence = text.slice(start, end);
		return spans
			.map((s) => {
				while (s.start < s.end && isWhitespace(sentence[s.start])) s.start++;
				while (s.end > s.start && isWhitespace(sentence[s.end - 1])) s.end--;
				return s;
			})
			.filter(s => s.end > s.start);
	}

	/**
	 * Extract every sentence that contains at least one highlighted character.
	 *
	 * @returns {Array<{key, fingerprint, paragraphId, pageIndex, text, spans, section, opening}>}
	 *   key: stable id of the sentence (page + normalized text)
	 *   fingerprint: changes when the highlighting of the sentence changes
	 */
	function extractSentences(paragraphs, options = {}) {
		let result = [];
		let seen = new Map();
		for (let p of paragraphs) {
			if (!p.marks || !p.marks.some(m => m)) continue;
			let sentences = segmentSentences(p.text, options.locale);
			let opening = sentences.length ? normalizeText(p.text.slice(sentences[0].start, sentences[0].end)) : '';
			for (let s of sentences) {
				let hasMark = false;
				for (let i = s.start; i < s.end; i++) {
					if (p.marks[i]) {
						hasMark = true;
						break;
					}
				}
				if (!hasMark) continue;
				let rawText = p.text.slice(s.start, s.end);
				let spans = marksToSpans(p.marks, p.text, s.start, s.end);
				// Normalize whitespace while keeping span offsets valid
				let { text, spans: normSpans } = normalizeWithSpans(rawText, spans);
				let firstChar = p.chars.slice(s.start, s.end).find(c => c);
				let pageIndex = firstChar ? firstChar.pageIndex : p.pageIndex;
				let baseKey = hash(pageIndex + '|' + text);
				let n = (seen.get(baseKey) || 0) + 1;
				seen.set(baseKey, n);
				let key = n > 1 ? baseKey + '-' + n : baseKey;
				let fingerprint = hash(JSON.stringify(normSpans.map(x => [x.start, x.end, x.color, x.key])));
				result.push({
					key,
					fingerprint,
					paragraphId: p.id,
					pageIndex,
					text,
					spans: normSpans,
					section: p.section || '',
					opening: opening === text ? '' : opening,
				});
			}
		}
		return result;
	}

	function normalizeWithSpans(rawText, spans) {
		let map = [];
		let text = '';
		let lastWasSpace = true;
		for (let i = 0; i < rawText.length; i++) {
			let ch = rawText[i];
			if (isWhitespace(ch)) {
				if (lastWasSpace) {
					map.push(text.length);
					continue;
				}
				ch = ' ';
				lastWasSpace = true;
			}
			else {
				lastWasSpace = false;
			}
			map.push(text.length);
			text += ch;
		}
		map.push(text.length);
		let trimmedEnd = text.replace(/\s+$/, '').length;
		text = text.slice(0, trimmedEnd);
		let out = spans
			.map(s => ({ ...s, start: map[s.start], end: Math.min(map[s.end], trimmedEnd) }))
			.filter(s => s.end > s.start);
		return { text, spans: out };
	}

	/** Full pipeline: SDT + annotations -> highlighted sentences. */
	function extractFromDocument(sdt, annotations, options) {
		let paragraphs = flattenDocument(sdt);
		let matched = applyAnnotations(paragraphs, annotations);
		let sentences = extractSentences(paragraphs, options);
		let unmatched = annotations
			.filter(a => (a.type === 'highlight' || a.type === 'underline') && !matched.has(a.key))
			.map(a => a.key);
		return { sentences, unmatched };
	}

	// ------------------------------------------------------------------
	// Store (cards + sentence snapshots), persisted in a Zotero note
	// ------------------------------------------------------------------

	function emptyStore(attachmentKey) {
		return { version: 1, attachmentKey, sentences: {}, cards: [] };
	}

	function newCardID() {
		return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
	}

	/**
	 * Classify current sentences against the store.
	 * - fresh: no card ever generated
	 * - unchanged: has an active card and the highlighting is the same
	 * - changed: has an active card but the highlighting changed
	 * - discarded: only discarded cards
	 */
	function classify(sentences, store) {
		let out = { fresh: [], unchanged: [], changed: [], discarded: [] };
		let current = new Map(sentences.map(s => [s.key, s.fingerprint]));
		// A card is changed when the highlighting of any of its sentences changed,
		// so all sentences of a merged card are regenerated together
		let cardChanged = c => c.sentenceKeys.some(k => current.has(k)
			&& (!c.fingerprints || c.fingerprints[k] !== current.get(k)));
		for (let s of sentences) {
			let cards = store.cards.filter(c => c.sentenceKeys.includes(s.key));
			let active = cards.filter(c => c.status === 'active');
			if (!cards.length) {
				out.fresh.push(s);
			}
			else if (active.length) {
				let changed = active.some(cardChanged);
				(changed ? out.changed : out.unchanged).push(s);
			}
			else {
				out.discarded.push(s);
			}
		}
		return out;
	}

	/**
	 * Decide which sentences to send to the LLM, grouped by paragraph.
	 * @returns {Array<{paragraphId, section, opening, sentences}>}
	 */
	function planGeneration(sentences, store, { includeChanged = false, includeDiscarded = false } = {}) {
		let cls = classify(sentences, store);
		let selected = new Set(cls.fresh.map(s => s.key));
		if (includeChanged) cls.changed.forEach(s => selected.add(s.key));
		if (includeDiscarded) cls.discarded.forEach(s => selected.add(s.key));
		let groups = new Map();
		for (let s of sentences) {
			if (!selected.has(s.key)) continue;
			if (!groups.has(s.paragraphId)) {
				groups.set(s.paragraphId, {
					paragraphId: s.paragraphId,
					section: s.section,
					opening: s.opening,
					sentences: [],
				});
			}
			groups.get(s.paragraphId).sentences.push(s);
		}
		return Array.from(groups.values());
	}

	/**
	 * Store the LLM results for one group: replaces the active cards of the
	 * regenerated sentences, keeps discarded cards in the trash.
	 */
	function applyResults(store, group, results, meta = {}) {
		let keys = new Set(group.sentences.map(s => s.key));
		store.cards = store.cards.filter(c => !(c.status === 'active' && c.sentenceKeys.some(k => keys.has(k))));
		for (let s of group.sentences) {
			store.sentences[s.key] = {
				text: s.text,
				spans: s.spans.map(({ start, end, color }) => ({ start, end, color })),
				pageIndex: s.pageIndex,
				section: s.section,
			};
		}
		let added = [];
		let now = new Date().toISOString();
		for (let r of results) {
			let sentenceKeys = r.sentenceKeys.filter(k => keys.has(k));
			if (!sentenceKeys.length) continue;
			let fingerprints = {};
			for (let k of sentenceKeys) {
				fingerprints[k] = group.sentences.find(s => s.key === k).fingerprint;
			}
			for (let q of r.questions) {
				let card = {
					id: newCardID(),
					sentenceKeys,
					question: q,
					status: 'active',
					edited: false,
					fingerprints,
					pageIndex: store.sentences[sentenceKeys[0]].pageIndex,
					model: meta.model || null,
					createdAt: now,
					ankiNoteId: null,
				};
				store.cards.push(card);
				added.push(card);
			}
		}
		return added;
	}

	function activeCards(store) {
		return store.cards
			.filter(c => c.status === 'active')
			.sort((a, b) => (a.pageIndex - b.pageIndex) || (a.createdAt < b.createdAt ? -1 : 1));
	}

	function discardedCards(store) {
		return store.cards.filter(c => c.status === 'discarded');
	}

	function setCardStatus(store, cardID, status) {
		let card = store.cards.find(c => c.id === cardID);
		if (card) card.status = status;
		return card;
	}

	function editCard(store, cardID, question) {
		let card = store.cards.find(c => c.id === cardID);
		if (card) {
			card.question = String(question).trim();
			card.edited = true;
		}
		return card;
	}

	function deleteCard(store, cardID) {
		store.cards = store.cards.filter(c => c.id !== cardID);
		pruneSentences(store);
	}

	function emptyTrash(store) {
		store.cards = store.cards.filter(c => c.status !== 'discarded');
		pruneSentences(store);
	}

	function pruneSentences(store) {
		let used = new Set();
		store.cards.forEach(c => c.sentenceKeys.forEach(k => used.add(k)));
		for (let k of Object.keys(store.sentences)) {
			if (!used.has(k)) delete store.sentences[k];
		}
	}

	/** Keys of stored sentences that are no longer highlighted in the document. */
	function orphanKeys(store, currentSentences) {
		let current = new Set(currentSentences.map(s => s.key));
		return Object.keys(store.sentences).filter(k => !current.has(k));
	}

	// ------------------------------------------------------------------
	// Rendering
	// ------------------------------------------------------------------

	function escapeHTML(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function sentenceToHTML(sentence) {
		let html = '';
		let pos = 0;
		let spans = [...sentence.spans].sort((a, b) => a.start - b.start);
		for (let s of spans) {
			if (s.start < pos) continue;
			html += escapeHTML(sentence.text.slice(pos, s.start));
			html += `<span style="background-color:${escapeHTML(s.color)}">`
				+ escapeHTML(sentence.text.slice(s.start, s.end)) + '</span>';
			pos = s.end;
		}
		html += escapeHTML(sentence.text.slice(pos));
		return html;
	}

	/** Back of a card: the source sentence(s), highlights in their original colors. */
	function backHTML(store, card) {
		return card.sentenceKeys
			.map(k => store.sentences[k])
			.filter(Boolean)
			.map(sentenceToHTML)
			.join('<br><br>');
	}

	function frontHTML(card) {
		return escapeHTML(card.question);
	}

	function csvField(s) {
		return '"' + String(s).replace(/"/g, '""') + '"';
	}

	/** Two columns (front, back), no header, HTML fields. */
	function toCSV(store, cards) {
		return (cards || activeCards(store))
			.map(c => csvField(frontHTML(c)) + ',' + csvField(backHTML(store, c)))
			.join('\r\n') + '\r\n';
	}

	// ------------------------------------------------------------------
	// Prompt
	// ------------------------------------------------------------------

	const DEFAULT_SYSTEM_PROMPT = `You write active-recall questions for a medical student's spaced-repetition deck. Act as a strict, unassisted examiner.

INPUT
- <context>: the section title and the opening sentence of the paragraph. Use it ONLY to understand what the passage is about. Never ask about content that appears only in <context>.
- <passage>: one or more sentences, each wrapped in <s id="...">. Highlighted spans are marked <hl c="color">...</hl>. The highlights are what the student wants to remember; the rest of the sentence is supporting text.
- <colors> (optional): what each highlight color means to the student.

TASK
1. Ask only about highlighted content. Non-highlighted words may make a question precise, but are never its target.
2. If several sentences describe parts of one concept (types, steps, causes, a list), you may merge them into one group that cites all their ids. Otherwise, make one group per sentence.
3. Give each group 1 to 4 questions, one per distinct testable fact in its highlights. Prefer fewer, sharper questions. Never ask twice about the same fact.

RULES
1. SELF-CONTAINED: Name the subject explicitly so the question is unambiguous out of context ("platelet alpha-granules", not "these granules"). Naming the subject is required; revealing the answer is forbidden.
2. NO HINTS OR LEADING LANGUAGE: No introductory clauses or context clues (do NOT write "Knowing that X is true, what is Y?"). Do not reuse words that give away the answer.
3. NO DISCLOSURE: Never include answers, explanations, or rationales.
4. DIRECT AND CONCISE: One sentence per question, ending with "?" (e.g., "What is the primary function of X?"). No yes/no or true/false questions.
5. COLD RECALL ONLY: The answer must come entirely from memory, with zero text-based triggers.
6. FAITHFUL: Every question must be answerable from the cited sentences alone. Never add facts that are not in the text.
7. If a highlight is too fragmentary for a meaningful question, skip it and list its sentence id in "skipped".

Write the questions in {{language}}, whatever the language of the source. Keep standard technical terms, abbreviations and eponyms as written (vWF, GpIb, Bernard-Soulier).

Return only JSON: {"groups":[{"sentence_ids":["..."],"questions":["..."]}],"skipped":["..."]}`;

	function escapeXMLText(s) {
		return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function sentenceToMarkup(sentence, id) {
		let out = '';
		let pos = 0;
		let spans = [...sentence.spans].sort((a, b) => a.start - b.start);
		for (let s of spans) {
			if (s.start < pos) continue;
			out += escapeXMLText(sentence.text.slice(pos, s.start));
			out += `<hl c="${colorName(s.color)}">` + escapeXMLText(sentence.text.slice(s.start, s.end)) + '</hl>';
			pos = s.end;
		}
		out += escapeXMLText(sentence.text.slice(pos));
		return `<s id="${id}">${out}</s>`;
	}

	/**
	 * Build the chat messages for one paragraph group.
	 * @param {Object} opts {systemPrompt, language, colorMeanings: {yellow: '...'}}
	 * @returns {{messages, idMap}} idMap: prompt id -> sentence key
	 */
	function buildMessages(group, opts = {}) {
		let system = (opts.systemPrompt || DEFAULT_SYSTEM_PROMPT)
			.replace(/\{\{language\}\}/g, opts.language || 'English');
		let idMap = {};
		let lines = [];
		let meanings = Object.entries(opts.colorMeanings || {}).filter(([, v]) => v && String(v).trim());
		if (meanings.length) {
			lines.push('<colors>');
			for (let [name, meaning] of meanings) {
				lines.push(`${name}: ${escapeXMLText(String(meaning).trim())}`);
			}
			lines.push('</colors>');
		}
		let ctx = [];
		if (group.section) ctx.push('Section: ' + group.section);
		if (group.opening) ctx.push('Opening: ' + group.opening);
		if (ctx.length) {
			lines.push('<context>' + escapeXMLText(ctx.join('\n')) + '</context>');
		}
		lines.push('<passage>');
		group.sentences.forEach((s, i) => {
			let id = 's' + (i + 1);
			idMap[id] = s.key;
			lines.push(sentenceToMarkup(s, id));
		});
		lines.push('</passage>');
		return {
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: lines.join('\n') },
			],
			idMap,
		};
	}

	/** JSON schema for structured outputs (OpenRouter response_format). */
	const RESPONSE_SCHEMA = {
		type: 'object',
		properties: {
			groups: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						sentence_ids: { type: 'array', items: { type: 'string' } },
						questions: { type: 'array', items: { type: 'string' } },
					},
					required: ['sentence_ids', 'questions'],
					additionalProperties: false,
				},
			},
			skipped: { type: 'array', items: { type: 'string' } },
		},
		required: ['groups', 'skipped'],
		additionalProperties: false,
	};

	/**
	 * Parse and validate the model output.
	 * @returns {{results: Array<{sentenceKeys, questions}>, skipped: string[]}}
	 */
	function parseResponse(text, idMap) {
		let s = String(text || '').trim();
		let fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
		if (fence) s = fence[1].trim();
		let first = s.indexOf('{');
		let last = s.lastIndexOf('}');
		if (first === -1 || last === -1) throw new Error('Risposta del modello non valida: nessun JSON');
		let data = JSON.parse(s.slice(first, last + 1));
		let groups = Array.isArray(data.groups) ? data.groups : Array.isArray(data.cards) ? data.cards : [];
		let results = [];
		for (let g of groups) {
			let ids = Array.isArray(g.sentence_ids) ? g.sentence_ids : [];
			let sentenceKeys = [...new Set(ids.map(id => idMap[String(id).trim()]).filter(Boolean))];
			let questions = (Array.isArray(g.questions) ? g.questions : [])
				.map(q => String(q).trim())
				.filter(Boolean)
				.slice(0, 4);
			if (sentenceKeys.length && questions.length) results.push({ sentenceKeys, questions });
		}
		let skipped = (Array.isArray(data.skipped) ? data.skipped : [])
			.map(id => idMap[String(id).trim()])
			.filter(Boolean);
		return { results, skipped };
	}

	// ------------------------------------------------------------------
	// Note serialization
	// ------------------------------------------------------------------

	const DATA_MARKER = 'ZOTRECALL-DATA:';

	function toBase64(str) {
		let bytes = new TextEncoder().encode(str);
		let bin = '';
		for (let i = 0; i < bytes.length; i += 0x8000) {
			bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		}
		return btoa(bin);
	}

	function fromBase64(b64) {
		let bin = atob(b64);
		let bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return new TextDecoder().decode(bytes);
	}

	/** Note HTML: a readable list of the cards plus the data block. */
	function storeToNoteHTML(store, title) {
		let html = `<h1>ZotRecall — ${escapeHTML(title || '')}</h1>\n`;
		html += '<p><em>Nota gestita dal plugin ZotRecall: non modificarla a mano.</em></p>\n';
		let cards = activeCards(store);
		let byPage = new Map();
		for (let c of cards) {
			let page = (c.pageIndex ?? 0) + 1;
			if (!byPage.has(page)) byPage.set(page, []);
			byPage.get(page).push(c);
		}
		for (let [page, list] of byPage) {
			html += `<h2>Pagina ${page}</h2>\n<ul>\n`;
			for (let c of list) {
				html += `<li><strong>${escapeHTML(c.question)}</strong><br>${backHTML(store, c)}</li>\n`;
			}
			html += '</ul>\n';
		}
		html += `<pre>${DATA_MARKER}${toBase64(JSON.stringify(store))}</pre>`;
		return html;
	}

	function isStoreNote(html) {
		return String(html || '').includes(DATA_MARKER);
	}

	function storeFromNoteHTML(html) {
		let m = new RegExp(DATA_MARKER + '([A-Za-z0-9+/=\\s]+)').exec(String(html || ''));
		if (!m) return null;
		try {
			let store = JSON.parse(fromBase64(m[1].replace(/\s+/g, '')));
			if (!store || !Array.isArray(store.cards) || typeof store.sentences !== 'object') return null;
			return store;
		}
		catch (e) {
			return null;
		}
	}

	return {
		ZOTERO_COLORS,
		colorName,
		hash,
		decodeTextMap,
		flattenDocument,
		applyAnnotations,
		segmentSentences,
		extractSentences,
		extractFromDocument,
		emptyStore,
		classify,
		planGeneration,
		applyResults,
		activeCards,
		discardedCards,
		setCardStatus,
		editCard,
		deleteCard,
		emptyTrash,
		orphanKeys,
		escapeHTML,
		sentenceToHTML,
		backHTML,
		frontHTML,
		toCSV,
		DEFAULT_SYSTEM_PROMPT,
		RESPONSE_SCHEMA,
		buildMessages,
		parseResponse,
		storeToNoteHTML,
		storeFromNoteHTML,
		isStoreNote,
	};
})();

if (typeof module !== 'undefined' && module.exports) {
	module.exports = ZotRecallCore;
}
