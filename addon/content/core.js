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

	function hexToRGB(color) {
		let s = String(color || '').trim();
		let m6 = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(s);
		if (m6) {
			let n = parseInt(m6[1], 16);
			return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
		}
		let m3 = /^#?([0-9a-f]{3})(?:[0-9a-f])?$/i.exec(s);
		if (m3) {
			let [r, g, b] = m3[1].split('').map(c => parseInt(c + c, 16));
			return [r, g, b];
		}
		let mRgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(s);
		if (mRgb) {
			return [
				Math.min(255, parseInt(mRgb[1], 10)),
				Math.min(255, parseInt(mRgb[2], 10)),
				Math.min(255, parseInt(mRgb[3], 10)),
			];
		}
		return null;
	}

	function rgbToHex([r, g, b]) {
		return '#' + [r, g, b].map(x => Math.max(0, Math.min(255, x | 0)).toString(16).padStart(2, '0')).join('');
	}

	function normalizeColorHex(color) {
		let rgb = hexToRGB(color);
		return rgb ? rgbToHex(rgb) : String(color || '').trim();
	}

	function srgbToLinear(channel) {
		let v = channel / 255;
		return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
	}

	function relativeLuminance([r, g, b]) {
		return 0.2126 * srgbToLinear(r)
			+ 0.7152 * srgbToLinear(g)
			+ 0.0722 * srgbToLinear(b);
	}

	/**
	 * WCAG-contrasting text color ('#000000' or '#ffffff') for a highlight
	 * background color, so highlighted text remains legible in both light and
	 * dark mode (Anki and Zotero) across all highlight colors.
	 */
	function highlightTextColor(color) {
		let rgb = hexToRGB(color);
		if (!rgb) return '#000000';
		return relativeLuminance(rgb) > 0.179 ? '#000000' : '#ffffff';
	}

	function highlightStyle(color) {
		let c = escapeHTML(color);
		let fg = highlightTextColor(color);
		return `background-color:${c};color:${fg};border-radius:2px;padding:0 2px`;
	}

	/**
	 * Ensure every <span style="...background-color:..."> in an HTML snippet
	 * carries an explicit contrasting text color, border-radius and padding.
	 */
	function ensureHighlightContrast(html) {
		return String(html || '').replace(/<span\b([^>]*?)\bstyle="([^"]*)"([^>]*)>/gi, (full, before, style, after) => {
			let m = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i.exec(style);
			if (!m) return full;
			let bg = m[1].trim();
			if (!bg || bg === 'transparent' || /rgba\(.*,\s*0\s*\)/i.test(bg)) return full;
			let fg = highlightTextColor(bg);
			let props = style
				.split(';')
				.map(p => p.trim())
				.filter(p => p && !/^(color|border-radius|padding)\s*:/i.test(p));
			props.push(`color:${fg}`, 'border-radius:2px', 'padding:0 2px');
			return `<span${before}style="${props.join(';')}"${after}>`;
		});
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
	const CONTEXT_SENTENCES = 3;

	function extractSentences(paragraphs, options = {}) {
		let result = [];
		let seen = new Map();
		let segCache = new Map();
		let textsOf = (pi) => {
			if (!segCache.has(pi)) {
				let p = paragraphs[pi];
				segCache.set(pi, segmentSentences(p.text, options.locale).map(x => normalizeText(p.text.slice(x.start, x.end))));
			}
			return segCache.get(pi);
		};
		// Up to CONTEXT_SENTENCES sentences before/after, crossing into the
		// neighboring paragraphs when needed (in document order)
		let neighbors = (pi, si) => {
			let before = textsOf(pi).slice(Math.max(0, si - CONTEXT_SENTENCES), si);
			for (let q = pi - 1; q >= 0 && before.length < CONTEXT_SENTENCES; q--) {
				let t = textsOf(q);
				before = t.slice(Math.max(0, t.length - (CONTEXT_SENTENCES - before.length))).concat(before);
			}
			let after = textsOf(pi).slice(si + 1, si + 1 + CONTEXT_SENTENCES);
			for (let q = pi + 1; q < paragraphs.length && after.length < CONTEXT_SENTENCES; q++) {
				after = after.concat(textsOf(q).slice(0, CONTEXT_SENTENCES - after.length));
			}
			return { before, after };
		};
		for (let pi = 0; pi < paragraphs.length; pi++) {
			let p = paragraphs[pi];
			if (!p.marks || !p.marks.some(m => m)) continue;
			let sentences = segmentSentences(p.text, options.locale);
			let opening = sentences.length ? normalizeText(p.text.slice(sentences[0].start, sentences[0].end)) : '';
			for (let si = 0; si < sentences.length; si++) {
				let s = sentences[si];
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
					...neighbors(pi, si),
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
		return { version: 1, attachmentKey, sentences: {}, cards: [], review: { merges: [], excluded: [] } };
	}

	// ------------------------------------------------------------------
	// Review: the user can merge sentences into one unit and exclude
	// sentences before anything is sent to the model
	// ------------------------------------------------------------------

	function ensureReview(store) {
		if (!store.review || typeof store.review !== 'object') store.review = {};
		if (!Array.isArray(store.review.merges)) store.review.merges = [];
		if (!Array.isArray(store.review.excluded)) store.review.excluded = [];
		if (!store.review.extend || typeof store.review.extend !== 'object') store.review.extend = {};
		if (!store.review.edits || typeof store.review.edits !== 'object') store.review.edits = {};
		return store.review;
	}

	function normalizeEditedUnit(rawText, rawSpans, defaultColor = '#ffd400') {
		let { text, spans } = normalizeWithSpans(String(rawText || ''), Array.isArray(rawSpans) ? rawSpans : []);
		let sorted = spans
			.map(s => ({ start: s.start, end: s.end, color: normalizeColorHex(s.color || defaultColor) }))
			.filter(s => s.end > s.start)
			.sort((a, b) => a.start - b.start || a.end - b.end);
		let merged = [];
		for (let s of sorted) {
			let last = merged[merged.length - 1];
			if (last && s.start <= last.end && last.color === s.color) {
				last.end = Math.max(last.end, s.end);
			}
			else if (last && s.start < last.end) {
				if (s.end > last.end) {
					merged.push({ start: last.end, end: s.end, color: s.color });
				}
			}
			else {
				merged.push({ ...s });
			}
		}
		if (text && !merged.length) {
			merged.push({ start: 0, end: text.length, color: normalizeColorHex(defaultColor) });
		}
		return { text, spans: merged };
	}

	/**
	 * Save a manual edit ({text, spans, defaultColor}) for a unit identified
	 * by `keys`. Passing null or empty text removes the manual edit.
	 */
	function setUnitEdit(store, keys, edit) {
		let review = ensureReview(store);
		let list = Array.isArray(keys) ? keys.filter(Boolean) : [keys].filter(Boolean);
		if (!list.length) return false;
		for (let k of list) delete review.edits[k];
		if (!edit || !String(edit.text || '').trim()) return true;
		let norm = normalizeEditedUnit(edit.text, edit.spans, edit.defaultColor || '#ffd400');
		if (!norm.text) return false;
		review.edits[list[0]] = {
			text: norm.text,
			spans: norm.spans,
			keys: list.slice(),
		};
		return true;
	}

	function clearUnitEdit(store, keys) {
		return setUnitEdit(store, keys, null);
	}

	/**
	 * Group the current sentences into review units.
	 * A unit is a single sentence or a user-made merge of several (in the
	 * exact order the user selected them when merging).
	 * @returns {Array<{id, keys, sentences, renderSentences, edited, excluded, merged, before, after}>}
	 */
	function buildUnits(sentences, store) {
		let review = ensureReview(store);
		let byKey = new Map(sentences.map(s => [s.key, s]));
		let mergeOf = new Map();
		for (let m of review.merges) {
			let keys = m.filter(k => byKey.has(k));
			if (keys.length < 2) continue;
			for (let k of keys) mergeOf.set(k, keys);
		}
		let excluded = new Set(review.excluded);
		let units = [];
		let emittedMerges = new Set();
		for (let s of sentences) {
			let m = mergeOf.get(s.key);
			if (m) {
				if (emittedMerges.has(m)) continue;
				if (s.key !== m[0]) continue;
				emittedMerges.add(m);
				units.push({
					id: 'm:' + m[0],
					keys: m.slice(),
					sentences: m.map(k => byKey.get(k)),
					merged: true,
				});
			}
			else {
				units.push({ id: s.key, keys: [s.key], sentences: [s], merged: false });
			}
		}
		for (let u of units) {
			u.excluded = u.keys.some(k => excluded.has(k));
			let first = u.sentences[0];
			let last = u.sentences[u.sentences.length - 1];
			let nb = Math.min((review.extend[first.key] || {}).before || 0, (first.before || []).length);
			let na = Math.min((review.extend[last.key] || {}).after || 0, (last.after || []).length);
			u.before = nb ? first.before.slice(-nb) : [];
			u.after = na ? last.after.slice(0, na) : [];

			let renderSentences = [];
			let covered = new Set();
			let edited = false;
			for (let s of u.sentences) {
				if (covered.has(s.key)) continue;
				let ed = review.edits[s.key];
				if (ed && typeof ed.text === 'string' && Array.isArray(ed.spans)) {
					edited = true;
					if (Array.isArray(ed.keys)) ed.keys.forEach(k => covered.add(k));
					covered.add(s.key);
					renderSentences.push({
						key: s.key,
						text: ed.text,
						spans: ed.spans.map(sp => ({ start: sp.start, end: sp.end, color: sp.color })),
						pageIndex: s.pageIndex,
						section: s.section,
					});
				}
				else {
					covered.add(s.key);
					renderSentences.push({
						key: s.key,
						text: s.text,
						spans: s.spans,
						pageIndex: s.pageIndex,
						section: s.section,
					});
				}
			}
			u.edited = edited;
			u.renderSentences = renderSentences;
		}
		return units;
	}

	/** Context sentences added around each sentence key: {key: [before, after]}. */
	function unitContext(unit) {
		let ctx = {};
		if (unit.before.length) ctx[unit.keys[0]] = [unit.before.length, 0];
		if (unit.after.length) {
			let k = unit.keys[unit.keys.length - 1];
			ctx[k] = [(ctx[k] || [0])[0], unit.after.length];
		}
		return ctx;
	}

	/**
	 * Add (delta > 0) or remove (delta < 0) non-highlighted sentences before or
	 * after a sentence. side: 'before' | 'after'.
	 */
	function extendKey(store, key, side, delta) {
		let review = ensureReview(store);
		let e = Object.assign({ before: 0, after: 0 }, review.extend[key]);
		e[side] = Math.max(0, Math.min(CONTEXT_SENTENCES, (e[side] || 0) + delta));
		if (!e.before && !e.after) delete review.extend[key];
		else review.extend[key] = e;
	}

	function clearExtend(store, keys) {
		let review = ensureReview(store);
		for (let k of keys) delete review.extend[k];
	}

	/**
	 * Merge the given sentence keys (and any merge they already belong to) into
	 * one unit, preserving the exact selection order of `keys`.
	 */
	function mergeKeys(store, keys) {
		let review = ensureReview(store);
		let inputSet = new Set(keys);
		let matchingMerges = review.merges.filter(m => m.some(k => inputSet.has(k)));
		let rest = review.merges.filter(m => !m.some(k => inputSet.has(k)));
		let ordered = [];
		let seen = new Set();
		let add = (k) => {
			if (k && !seen.has(k)) {
				seen.add(k);
				ordered.push(k);
			}
		};
		for (let k of keys) {
			add(k);
			for (let m of matchingMerges) {
				if (m.includes(k)) m.forEach(add);
			}
		}
		if (ordered.length < 2) return false;
		rest.push(ordered);
		review.merges = rest;
		return true;
	}

	/** Undo the merges that contain any of the given keys. */
	function splitKeys(store, keys) {
		let review = ensureReview(store);
		let set = new Set(keys);
		let before = review.merges.length;
		review.merges = review.merges.filter(m => !m.some(k => set.has(k)));
		for (let [k, ed] of Object.entries(review.edits)) {
			if (Array.isArray(ed.keys) && ed.keys.length > 1 && ed.keys.some(x => set.has(x))) {
				delete review.edits[k];
			}
		}
		return review.merges.length !== before;
	}

	function setExcluded(store, keys, excluded) {
		let review = ensureReview(store);
		let set = new Set(review.excluded);
		for (let k of keys) {
			if (excluded) set.add(k);
			else set.delete(k);
		}
		review.excluded = Array.from(set);
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
		// A sentence the user merged, re-ordered, or manually edited after its
		// cards were made counts as changed; same for context sentences added/removed
		let unitOf = new Map();
		let ctxOf = new Map();
		for (let u of buildUnits(sentences, store)) {
			if (u.merged) u.keys.forEach(k => unitOf.set(k, u.keys));
			let ctx = unitContext(u);
			u.keys.forEach(k => ctxOf.set(k, JSON.stringify(ctx[k] || [0, 0])));
			if (u.edited) {
				let editSig = hash(JSON.stringify(u.renderSentences.map(r => [r.text, r.spans])));
				for (let s of u.sentences) {
					current.set(s.key, hash(s.fingerprint + '|edit:' + editSig));
				}
			}
		}
		let cardChanged = c => c.sentenceKeys.some(k => current.has(k)
			&& (!c.fingerprints || c.fingerprints[k] !== current.get(k)));
		let hasSubsequenceInOrder = (arr, sub) => {
			let pos = -1;
			for (let k of sub) {
				let next = arr.indexOf(k, pos + 1);
				if (next === -1) return false;
				pos = next;
			}
			return true;
		};
		let mergeChanged = (c, key) => (unitOf.has(key)
			&& !hasSubsequenceInOrder(c.sentenceKeys, unitOf.get(key)))
			|| JSON.stringify((c.context || {})[key] || [0, 0]) !== ctxOf.get(key);
		for (let s of sentences) {
			let cards = store.cards.filter(c => c.sentenceKeys.includes(s.key));
			let active = cards.filter(c => c.status === 'active');
			if (!cards.length) {
				out.fresh.push(s);
			}
			else if (active.length) {
				let changed = active.some(c => cardChanged(c) || mergeChanged(c, s.key));
				(changed ? out.changed : out.unchanged).push(s);
			}
			else {
				out.discarded.push(s);
			}
		}
		return out;
	}

	/**
	 * Decide what to send to the LLM, grouped by paragraph. Excluded sentences
	 * are skipped; a merged unit is sent whole when any of its sentences is
	 * selected, in the paragraph of its first sentence.
	 * @param {Object} opts includeChanged, includeDiscarded, keys (limit to these sentence keys)
	 * @returns {Array<{paragraphId, section, opening, units, sentences}>}
	 */
	function planGeneration(sentences, store, { includeChanged = false, includeDiscarded = false, keys = null } = {}) {
		let cls = classify(sentences, store);
		let selected = new Set(cls.fresh.map(s => s.key));
		if (includeChanged) cls.changed.forEach(s => selected.add(s.key));
		if (includeDiscarded) cls.discarded.forEach(s => selected.add(s.key));
		let limit = keys ? new Set(keys) : null;
		let groups = new Map();
		for (let unit of buildUnits(sentences, store)) {
			if (unit.excluded) continue;
			if (!unit.keys.some(k => selected.has(k) && (!limit || limit.has(k)))) continue;
			let first = unit.sentences[0];
			if (!groups.has(first.paragraphId)) {
				groups.set(first.paragraphId, {
					paragraphId: first.paragraphId,
					section: first.section,
					opening: first.opening,
					units: [],
					sentences: [],
				});
			}
			let g = groups.get(first.paragraphId);
			g.units.push(unit);
			g.sentences.push(...unit.sentences);
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
		let context = {};
		for (let u of group.units || []) Object.assign(context, unitContext(u));
		let unitOfKey = new Map();
		let renderOfKey = new Map();
		let fpOfKey = new Map();
		for (let s of group.sentences) fpOfKey.set(s.key, s.fingerprint);
		for (let u of group.units || []) {
			let editSig = u.edited ? hash(JSON.stringify((u.renderSentences || []).map(r => [r.text, r.spans]))) : '';
			let rMap = new Map((u.renderSentences || u.sentences).map(r => [r.key, r]));
			for (let s of u.sentences) {
				unitOfKey.set(s.key, u);
				renderOfKey.set(s.key, rMap.get(s.key) || { text: '', spans: [] });
				if (editSig) fpOfKey.set(s.key, hash(s.fingerprint + '|edit:' + editSig));
			}
		}
		for (let s of group.sentences) {
			let u = unitOfKey.get(s.key);
			let rs = renderOfKey.get(s.key) || s;
			let lastRenderKey = (u && u.renderSentences && u.renderSentences.length)
				? u.renderSentences[u.renderSentences.length - 1].key
				: (u ? u.keys[u.keys.length - 1] : null);
			let entry = {
				text: rs.text,
				spans: (rs.spans || []).map(({ start, end, color }) => ({ start, end, color })),
				pageIndex: s.pageIndex,
				section: s.section,
			};
			if (u && u.keys[0] === s.key && u.before.length) entry.before = u.before.slice();
			if (u && lastRenderKey === s.key && u.after.length) entry.after = u.after.slice();
			store.sentences[s.key] = entry;
		}
		let added = [];
		let now = new Date().toISOString();
		for (let r of results) {
			let sentenceKeys = r.sentenceKeys.filter(k => keys.has(k));
			if (!sentenceKeys.length) continue;
			let fingerprints = {};
			for (let k of sentenceKeys) {
				fingerprints[k] = fpOfKey.get(k) || group.sentences.find(s => s.key === k).fingerprint;
			}
			for (let q of r.questions) {
				let cardContext = {};
				for (let k of sentenceKeys) if (context[k]) cardContext[k] = context[k];
				let card = {
					id: newCardID(),
					sentenceKeys,
					context: cardContext,
					question: q,
					originalQuestion: q,
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

	/**
	 * Ensure store.sentences has the current text, spans and context for the
	 * given unit(s), and return {sentenceKeys, context, fingerprints, pageIndex}.
	 */
	function storeUnitSentences(store, units) {
		let unitList = Array.isArray(units) ? units : [units].filter(Boolean);
		let sentenceKeys = [];
		let context = {};
		let fingerprints = {};
		let pageIndex = 0;
		let hasPage = false;
		for (let u of unitList) {
			if (!u || !Array.isArray(u.sentences) || !u.sentences.length) continue;
			Object.assign(context, unitContext(u));
			let editSig = u.edited ? hash(JSON.stringify((u.renderSentences || []).map(r => [r.text, r.spans]))) : '';
			let rMap = new Map((u.renderSentences || u.sentences).map(r => [r.key, r]));
			let lastRenderKey = (u.renderSentences && u.renderSentences.length)
				? u.renderSentences[u.renderSentences.length - 1].key
				: u.keys[u.keys.length - 1];
			for (let s of u.sentences) {
				if (!sentenceKeys.includes(s.key)) sentenceKeys.push(s.key);
				fingerprints[s.key] = editSig ? hash(s.fingerprint + '|edit:' + editSig) : s.fingerprint;
				let rs = rMap.get(s.key) || s;
				let entry = {
					text: rs.text,
					spans: (rs.spans || []).map(({ start, end, color }) => ({ start, end, color })),
					pageIndex: s.pageIndex,
					section: s.section,
				};
				if (u.keys[0] === s.key && u.before && u.before.length) entry.before = u.before.slice();
				if (lastRenderKey === s.key && u.after && u.after.length) entry.after = u.after.slice();
				store.sentences[s.key] = entry;
				if (!hasPage) {
					pageIndex = s.pageIndex ?? 0;
					hasPage = true;
				}
			}
		}
		return { sentenceKeys, context, fingerprints, pageIndex };
	}

	/**
	 * Create a manual card for the given unit(s), populating store.sentences so
	 * backHTML(store, card) renders the period with highlights immediately.
	 */
	function createManualCard(store, units, question = '') {
		let { sentenceKeys, context, fingerprints, pageIndex } = storeUnitSentences(store, units);
		if (!sentenceKeys.length) return null;
		let cardContext = {};
		for (let k of sentenceKeys) if (context[k]) cardContext[k] = context[k];
		let qText = String(question || '').trim();
		let card = {
			id: newCardID(),
			sentenceKeys,
			context: cardContext,
			question: qText,
			originalQuestion: qText,
			status: 'active',
			edited: false,
			manual: true,
			fingerprints,
			pageIndex,
			model: 'manual',
			createdAt: new Date().toISOString(),
			ankiNoteId: null,
		};
		store.cards.push(card);
		return card;
	}

	/**
	 * Create a manual card linked to the same period as the given source card.
	 */
	function createManualCardFromSource(store, sourceCard, question = '') {
		if (!sourceCard || !Array.isArray(sourceCard.sentenceKeys) || !sourceCard.sentenceKeys.length) return null;
		let sentenceKeys = sourceCard.sentenceKeys.slice();
		let context = Object.assign({}, sourceCard.context || {});
		let fingerprints = Object.assign({}, sourceCard.fingerprints || {});
		let pageIndex = sourceCard.pageIndex ?? 0;
		let qText = String(question || '').trim();
		let card = {
			id: newCardID(),
			sentenceKeys,
			context,
			question: qText,
			originalQuestion: qText,
			status: 'active',
			edited: false,
			manual: true,
			fingerprints,
			pageIndex,
			model: 'manual',
			createdAt: new Date().toISOString(),
			ankiNoteId: null,
		};
		if (sourceCard.back) card.back = sourceCard.back;
		store.cards.push(card);
		return card;
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

	/**
	 * Edit a card. `back` is sanitized HTML for the back, or null to go back
	 * to the source sentence(s) built by the code. `front` is optional sanitized
	 * HTML for the front (question) when formatted, or null for plain text.
	 */
	function editCard(store, cardID, question, back, front) {
		let card = store.cards.find(c => c.id === cardID);
		if (card) {
			if (card.originalQuestion === undefined) card.originalQuestion = card.question;
			if (question !== undefined && question !== null) card.question = String(question).trim();
			if (back !== undefined) {
				if (back === null || !String(back).trim()) delete card.back;
				else card.back = String(back);
			}
			if (front !== undefined) {
				let f = front === null ? '' : String(front).trim();
				if (!f || f === escapeHTML(card.question)) delete card.front;
				else card.front = f;
			}
			card.edited = true;
		}
		return card;
	}

	// ------------------------------------------------------------------
	// Keyboard shortcuts normalization and matching
	// ------------------------------------------------------------------

	const DEFAULT_SHORTCUTS = {
		exclude: 'e',
		edit: 'm',
		manualCard: 'g',
		newCard: 'n',
		send: 'Enter',
		discard: '-',
	};

	function normalizeShortcutKey(v, def) {
		if (typeof v !== 'string') return def;
		let k = v.trim();
		if (!k) return def;
		if (/^(enter|invio)$/i.test(k)) return 'Enter';
		if (/^(space|spazio)$/i.test(k)) return ' ';
		if (/^(backspace)$/i.test(k)) return 'Backspace';
		if (/^(delete|canc)$/i.test(k)) return 'Delete';
		return k.slice(0, 1).toLowerCase();
	}

	function shortcutDisplayLabel(k) {
		if (!k) return '';
		if (k === 'Enter' || /^(enter|invio)$/i.test(k)) return 'Invio';
		if (k === ' ' || /^(space|spazio)$/i.test(k)) return 'Spazio';
		if (k === 'Backspace' || /^backspace$/i.test(k)) return '⌫';
		if (k === 'Delete' || /^(delete|canc)$/i.test(k)) return 'Canc';
		return String(k).toUpperCase();
	}

	function matchesShortcut(eventKey, configuredKey) {
		if (!eventKey || !configuredKey) return false;
		if (configuredKey === 'Enter' || /^(enter|invio)$/i.test(configuredKey)) return eventKey === 'Enter';
		if (configuredKey === ' ' || /^(space|spazio)$/i.test(configuredKey)) return eventKey === ' ';
		if (configuredKey === 'Backspace' || /^backspace$/i.test(configuredKey)) return eventKey === 'Backspace';
		if (configuredKey === 'Delete' || /^(delete|canc)$/i.test(configuredKey)) return eventKey === 'Delete';
		if (configuredKey.length === 1) return String(eventKey).toLowerCase() === configuredKey.toLowerCase();
		return String(eventKey).toLowerCase() === String(configuredKey).toLowerCase();
	}

	// ------------------------------------------------------------------
	// Anki sync state
	// ------------------------------------------------------------------

	/** Anki tags from user text: space separated, "::" for hierarchy. */
	function parseTags(text) {
		return [...new Set(String(text || '').split(/\s+/).map(t => t.trim()).filter(Boolean))];
	}

	/** What Anki would receive for this card; changes when front, back or tags change. */
	function ankiSignature(store, card, tags = []) {
		return hash(frontHTML(card) + '\u0001' + backHTML(store, card) + '\u0001' + [...tags].sort().join(' '));
	}

	/**
	 * 'new': never sent; 'sent': Anki has exactly this card;
	 * 'changed': sent, but edited or regenerated since.
	 */
	function ankiState(store, card, tags = []) {
		if (!card.ankiNoteId) return 'new';
		return card.ankiSig === ankiSignature(store, card, tags) ? 'sent' : 'changed';
	}

	function markSent(store, card, { noteId, deck, tags = [] }) {
		card.ankiNoteId = noteId;
		card.ankiDeck = deck;
		card.ankiSig = ankiSignature(store, card, tags);
		card.sentAt = new Date().toISOString();
	}

	function sentCards(store) {
		return activeCards(store).filter(c => c.ankiNoteId);
	}

	function unsentCards(store, tags = []) {
		return activeCards(store).filter(c => ankiState(store, c, tags) !== 'sent');
	}

	/** Active cards associated with a review unit (or an array of sentence keys). */
	function unitCards(store, unitOrKeys) {
		let keys = Array.isArray(unitOrKeys) ? unitOrKeys : (unitOrKeys && Array.isArray(unitOrKeys.keys) ? unitOrKeys.keys : []);
		if (!keys.length) return [];
		let keySet = new Set(keys);
		return activeCards(store).filter(c => Array.isArray(c.sentenceKeys) && c.sentenceKeys.some(k => keySet.has(k)));
	}

	/**
	 * Select the subset of cards and starting index for the preview window:
	 * - When opened from a sidebar period badge ({cardIDs, sentenceKeys, cardID}),
	 *   returns strictly the active cards of that period (even if already sent to Anki),
	 *   never mixing in unsent cards from other periods.
	 * - When opened from "Carte inviate ad Anki" ({fromSent: true, cardID}),
	 *   returns all sent cards starting at cardID.
	 * - When opened normally (start = number or undefined), returns only unsent cards.
	 */
	function selectPreviewCards(store, tags = [], start = 0) {
		let fromSent = Boolean(start && typeof start === 'object' && start.fromSent);
		let unitCardIDs = (start && typeof start === 'object' && Array.isArray(start.cardIDs) && start.cardIDs.length)
			? start.cardIDs
			: null;
		let unitSentenceKeys = (start && typeof start === 'object' && Array.isArray(start.sentenceKeys) && start.sentenceKeys.length)
			? start.sentenceKeys
			: null;
		let allActive = activeCards(store);
		let initialCards;
		if (unitCardIDs) {
			let idSet = new Set(unitCardIDs);
			initialCards = allActive.filter(c => idSet.has(c.id));
		}
		else if (unitSentenceKeys) {
			initialCards = unitCards(store, unitSentenceKeys);
		}
		else if (fromSent) {
			initialCards = sentCards(store);
			if (start && typeof start === 'object' && start.cardID && !initialCards.some(c => c.id === start.cardID)) {
				let target = allActive.find(c => c.id === start.cardID);
				if (target) initialCards = [target, ...initialCards];
			}
		}
		else if (start && typeof start === 'object' && start.cardID) {
			let target = allActive.find(c => c.id === start.cardID);
			if (target && Array.isArray(target.sentenceKeys) && target.sentenceKeys.length) {
				initialCards = unitCards(store, target.sentenceKeys);
			}
			else {
				initialCards = target ? [target] : [];
			}
		}
		else {
			initialCards = unsentCards(store, tags);
		}
		let index = typeof start === 'object' && start
			? Math.max(0, initialCards.findIndex(c => c.id === start.cardID))
			: Math.max(0, Math.min(Number(start) || 0, Math.max(0, initialCards.length - 1)));
		return {
			cards: initialCards,
			index,
			fromSent,
			unitCardIDs,
			unitSentenceKeys,
		};
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
			html += `<span style="${highlightStyle(s.color)}">`
				+ escapeHTML(sentence.text.slice(s.start, s.end)) + '</span>';
			pos = s.end;
		}
		html += escapeHTML(sentence.text.slice(pos));
		return html;
	}

	/** Back of a card: the source sentence(s), highlights in their original colors. */
	function backHTML(store, card) {
		if (card.back) return ensureHighlightContrast(card.back);
		return card.sentenceKeys
			.map(k => store.sentences[k])
			.filter(s => s && (s.text || (s.before && s.before.length) || (s.after && s.after.length)))
			.map(s => [...(s.before || []).map(escapeHTML), s.text ? sentenceToHTML(s) : '', ...(s.after || []).map(escapeHTML)].filter(Boolean).join(' '))
			.join('<br><br>');
	}

	function frontHTML(card) {
		if (card && card.front) return ensureHighlightContrast(card.front);
		return escapeHTML(card ? card.question : '');
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
- An <s merged="true"> holds several consecutive sentences that the student joined on purpose because they form one idea: treat it as a single unit and ask about it as a whole.
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

	/** A merged unit becomes one <s> holding all its sentences. */
	function unitToMarkup(unit, id) {
		let list = unit.renderSentences || unit.sentences;
		let inner = [
			...(unit.before || []).map(escapeXMLText),
			...list.map(s => sentenceToMarkup(s, null)),
			...(unit.after || []).map(escapeXMLText),
		].join(' ');
		return unit.sentences.length > 1
			? `<s id="${id}" merged="true">${inner}</s>`
			: `<s id="${id}">${inner}</s>`;
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
		return id ? `<s id="${id}">${out}</s>` : out;
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
		let units = group.units || group.sentences.map(s => ({ keys: [s.key], sentences: [s] }));
		units.forEach((u, i) => {
			let id = 's' + (i + 1);
			idMap[id] = u.keys.slice();
			lines.push(unitToMarkup(u, id));
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
			let sentenceKeys = [...new Set(ids.flatMap(id => [].concat(idMap[String(id).trim()] || [])))];
			let questions = (Array.isArray(g.questions) ? g.questions : [])
				.map(q => String(q).trim())
				.filter(Boolean)
				.slice(0, 4);
			if (sentenceKeys.length && questions.length) results.push({ sentenceKeys, questions });
		}
		let skipped = (Array.isArray(data.skipped) ? data.skipped : [])
			.flatMap(id => [].concat(idMap[String(id).trim()] || []));
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
		normalizeColorHex,
		highlightTextColor,
		highlightStyle,
		ensureHighlightContrast,
		hash,
		decodeTextMap,
		flattenDocument,
		applyAnnotations,
		segmentSentences,
		extractSentences,
		extractFromDocument,
		emptyStore,
		classify,
		ensureReview,
		normalizeEditedUnit,
		setUnitEdit,
		clearUnitEdit,
		buildUnits,
		mergeKeys,
		splitKeys,
		setExcluded,
		extendKey,
		clearExtend,
		planGeneration,
		applyResults,
		storeUnitSentences,
		createManualCard,
		createManualCardFromSource,
		activeCards,
		discardedCards,
		setCardStatus,
		editCard,
		DEFAULT_SHORTCUTS,
		normalizeShortcutKey,
		shortcutDisplayLabel,
		matchesShortcut,
		parseTags,
		ankiSignature,
		ankiState,
		markSent,
		sentCards,
		unsentCards,
		unitCards,
		selectPreviewCards,
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
