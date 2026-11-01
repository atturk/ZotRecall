'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../addon/content/core.js');

// Build an SDT text node: every non-whitespace char gets a 5pt-wide box on one line
function textNode(text, pageIndex, x, y, style) {
	let widths = [];
	let pendingGap = 0;
	let started = false;
	let startX = x;
	for (let ch of text) {
		if (/\s/.test(ch)) {
			pendingGap += 3;
			continue;
		}
		if (!started) {
			startX = x + pendingGap;
			pendingGap = 0;
			started = true;
			widths.push(5);
			continue;
		}
		widths.push(pendingGap ? [pendingGap, 5] : 5);
		pendingGap = 0;
	}
	let total = widths.reduce((s, w) => s + (Array.isArray(w) ? w[0] + w[1] : w), 0);
	let node = { text, anchor: { textMap: JSON.stringify([[0, pageIndex, startX, y, startX + total, y + 10, ...widths]]) } };
	if (style) node.style = style;
	return node;
}

// Rect covering characters [from, to) of a textNode laid out by textNode()
function rectFor(text, from, to, x, y) {
	let pos = x;
	let x1 = null;
	let x2 = null;
	let started = false;
	let gap = 0;
	for (let i = 0; i < text.length; i++) {
		let ch = text[i];
		if (/\s/.test(ch)) {
			gap += 3;
			continue;
		}
		if (started) pos += gap;
		else pos += gap;
		gap = 0;
		started = true;
		if (i >= from && i < to) {
			if (x1 === null) x1 = pos;
			x2 = pos + 5;
		}
		pos += 5;
	}
	return [x1, y, x2, y + 10];
}

const P1A = 'Platelets are disc-shaped anucleate cell fragments. α-Granules have the adhesion molecule P-selectin on their membranes (Chapter 3)';
const P1B = 'and contain proteins involved in coagulation, such as fibrinogen. Dense (or δ) granules contain adenosine diphosphate (ADP), see Fig. 4.5 for details.';

function makeDoc() {
	return {
		schemaVersion: '1.0.0',
		catalog: { pages: [], outline: [] },
		content: [
			{ type: 'heading', anchor: {}, content: [textNode('Platelets', 0, 50, 700)] },
			{ type: 'paragraph', anchor: {}, nextPart: [3], content: [textNode(P1A, 0, 50, 600)] },
			{ type: 'paragraph', flowClass: 'excluded', anchor: {}, content: [textNode('120 CHAPTER 4 Hemodynamic Disorders', 1, 50, 780)] },
			{ type: 'paragraph', anchor: {}, previousPart: [1], content: [textNode(P1B, 1, 50, 700)] },
		],
	};
}

function ann(key, text, needle, pageIndex, x, y, color = '#ffd400', sortIndex = '00000|000000|00000') {
	let from = text.indexOf(needle);
	assert.ok(from >= 0, 'needle not found: ' + needle);
	return {
		key,
		type: 'highlight',
		color,
		sortIndex,
		text: needle,
		position: JSON.stringify({ pageIndex, rects: [rectFor(text, from, from + needle.length, x, y)] }),
	};
}

test('decodeTextMap returns one rect per non-whitespace char', () => {
	let n = textNode('ab c', 2, 10, 20);
	let chars = Core.decodeTextMap(n.anchor.textMap);
	assert.equal(chars.length, 3);
	assert.equal(chars[0].pageIndex, 2);
	assert.deepEqual(chars[0].rect, [10, 20, 15, 30]);
	assert.deepEqual(chars[2].rect, [23, 20, 28, 30]);
});

test('flattenDocument joins parts across pages, drops excluded blocks, tracks section', () => {
	let paras = Core.flattenDocument(makeDoc());
	assert.equal(paras.length, 1);
	assert.equal(paras[0].section, 'Platelets');
	assert.ok(paras[0].text.includes('(Chapter 3) and contain proteins'));
	assert.ok(!paras[0].text.includes('CHAPTER 4'));
	assert.equal(paras[0].pageIndex, 0);
});

test('segmentSentences keeps "Fig. 4.5" inside one sentence', () => {
	let t = 'Dense granules contain ADP, see Fig. 4.5 for details. Next one e.g. here. Last.';
	let s = Core.segmentSentences(t).map(r => t.slice(r.start, r.end));
	assert.deepEqual(s, ['Dense granules contain ADP, see Fig. 4.5 for details.', 'Next one e.g. here.', 'Last.']);
});

test('extractFromDocument: whole sentence across page break, highlight spans and colors', () => {
	let doc = makeDoc();
	let anns = [
		ann('A1', P1A, 'α-Granules', 0, 50, 600),
		ann('A2', P1A, 'adhesion molecule P-selectin', 0, 50, 600),
		ann('A3', P1B, 'Dense (or δ) granules', 1, 50, 700, '#5fb236'),
		ann('A4', P1B, '(ADP)', 1, 50, 700),
	];
	let { sentences, unmatched } = Core.extractFromDocument(doc, anns);
	assert.deepEqual(unmatched, []);
	assert.equal(sentences.length, 2);

	let [s1, s2] = sentences;
	assert.equal(s1.text, 'α-Granules have the adhesion molecule P-selectin on their membranes (Chapter 3) and contain proteins involved in coagulation, such as fibrinogen.');
	assert.equal(s1.pageIndex, 0);
	assert.equal(s1.section, 'Platelets');
	assert.equal(s1.opening, 'Platelets are disc-shaped anucleate cell fragments.');
	assert.deepEqual(s1.spans.map(s => s1.text.slice(s.start, s.end)), ['α-Granules', 'adhesion molecule P-selectin']);

	assert.equal(s2.pageIndex, 1);
	assert.deepEqual(s2.spans.map(s => [s2.text.slice(s.start, s.end), s.color]), [
		['Dense (or δ) granules', '#5fb236'],
		['(ADP)', '#ffd400'],
	]);
	assert.equal(s1.paragraphId, s2.paragraphId);
});

test('prompt markup uses <hl c> tags and context', () => {
	let { sentences } = Core.extractFromDocument(makeDoc(), [
		ann('A3', P1B, 'Dense (or δ) granules', 1, 50, 700, '#5fb236'),
	]);
	let [group] = Core.planGeneration(sentences, Core.emptyStore('X'));
	let { messages, idMap } = Core.buildMessages(group, { language: 'Italiano', colorMeanings: { green: 'definizioni', red: '' } });
	assert.ok(messages[0].content.includes('Write the questions in Italiano'));
	let user = messages[1].content;
	assert.ok(user.includes('<colors>\ngreen: definizioni\n</colors>'));
	assert.ok(user.includes('<context>Section: Platelets'));
	assert.ok(user.includes('<s id="s1"><hl c="green">Dense (or δ) granules</hl> contain adenosine diphosphate (ADP), see Fig. 4.5 for details.</s>'));
	assert.deepEqual(idMap.s1, [sentences[0].key]);
});

test('generation lifecycle: fresh, unchanged, changed, discarded', () => {
	let doc = makeDoc();
	let a1 = ann('A1', P1A, 'α-Granules', 0, 50, 600);
	let a3 = ann('A3', P1B, 'Dense (or δ) granules', 1, 50, 700);
	let store = Core.emptyStore('X');

	let { sentences } = Core.extractFromDocument(doc, [a1, a3]);
	let groups = Core.planGeneration(sentences, store);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].sentences.length, 2);

	let { idMap } = Core.buildMessages(groups[0]);
	let reply = '```json\n{"groups":[{"sentence_ids":["s1","s2"],"questions":["Which two types of granules do platelets contain?","Which adhesion molecule is on platelet alpha-granule membranes?"]}],"skipped":[]}\n```';
	let { results } = Core.parseResponse(reply, idMap);
	Core.applyResults(store, groups[0], results, { model: 'test' });
	assert.equal(Core.activeCards(store).length, 2, 'one card per question');
	assert.deepEqual(Core.activeCards(store)[0].sentenceKeys, sentences.map(s => s.key));

	// Nothing to do on the second run
	assert.equal(Core.planGeneration(sentences, store).length, 0);

	// Change the highlight in sentence 2 -> changed
	let a4 = ann('A4', P1B, '(ADP)', 1, 50, 700);
	let again = Core.extractFromDocument(doc, [a1, a3, a4]).sentences;
	let cls = Core.classify(again, store);
	assert.equal(cls.changed.length, 2, 'both sentences share the merged card');
	assert.equal(Core.planGeneration(again, store).length, 0);
	assert.equal(Core.planGeneration(again, store, { includeChanged: true })[0].sentences.length, 2);

	// Discard both cards -> discarded
	for (let c of Core.activeCards(store)) Core.setCardStatus(store, c.id, 'discarded');
	cls = Core.classify(sentences, store);
	assert.equal(cls.discarded.length, 2);
	assert.equal(Core.planGeneration(sentences, store).length, 0);
	assert.equal(Core.planGeneration(sentences, store, { includeDiscarded: true }).length, 1);

	Core.emptyTrash(store);
	assert.equal(store.cards.length, 0);
	assert.deepEqual(store.sentences, {});
});

test('back HTML keeps original highlight colors with contrasting text color; CSV has two columns, no header', () => {
	let { sentences } = Core.extractFromDocument(makeDoc(), [ann('A4', P1B, '(ADP)', 1, 50, 700, '#ff6666')]);
	let store = Core.emptyStore('X');
	let [group] = Core.planGeneration(sentences, store);
	Core.applyResults(store, group, [{ sentenceKeys: [sentences[0].key], questions: ['What does "ADP" stand for?'] }]);
	let card = Core.activeCards(store)[0];
	assert.ok(Core.backHTML(store, card).includes('<span style="background-color:#ff6666;color:#000000;border-radius:2px;padding:0 2px">(ADP)</span>'));
	for (let c of Core.ZOTERO_COLORS) {
		assert.equal(Core.highlightTextColor(c.hex), '#000000', `${c.name} uses dark text`);
	}
	assert.equal(Core.highlightTextColor('rgb(255, 212, 0)'), '#000000');
	assert.equal(Core.highlightTextColor('#1e3a8a'), '#ffffff', 'dark custom color uses white text');
	assert.equal(
		Core.ensureHighlightContrast('<span style="background-color: rgb(255, 212, 0)">Hyperemia</span> and <span style="font-weight:bold">flow</span>'),
		'<span style="background-color: rgb(255, 212, 0);color:#000000;border-radius:2px;padding:0 2px">Hyperemia</span> and <span style="font-weight:bold">flow</span>'
	);
	let csv = Core.toCSV(store);
	assert.equal(csv.split('\r\n').filter(Boolean).length, 1);
	assert.ok(csv.startsWith('"What does &quot;ADP&quot; stand for?","Dense (or δ) granules contain'));
});

test('note round trip', () => {
	let store = Core.emptyStore('KEY');
	store.cards.push({ id: 'c1', sentenceKeys: [], question: 'Q àè?', status: 'active', pageIndex: 0, createdAt: 'x' });
	let html = Core.storeToNoteHTML(store, 'Robbins');
	assert.ok(Core.isStoreNote(html));
	assert.deepEqual(Core.storeFromNoteHTML(html), store);
});

test('colorName maps custom colors to the nearest palette color', () => {
	assert.equal(Core.colorName('#ffd400'), 'yellow');
	assert.equal(Core.colorName('#ffe066'), 'yellow');
	assert.equal(Core.colorName('#2ea8e5'), 'blue');
});

test('review: merged sentences go to the model as one unit, excluded ones are skipped', () => {
	let doc = makeDoc();
	let a1 = ann('A1', P1A, 'α-Granules', 0, 50, 600);
	let a2 = ann('A2', P1A, 'disc-shaped', 0, 50, 600);
	let a3 = ann('A3', P1B, 'Dense (or δ) granules', 1, 50, 700);
	let store = Core.emptyStore('X');
	let { sentences } = Core.extractFromDocument(doc, [a1, a2, a3]);
	assert.equal(sentences.length, 3);
	let [s1, s2, s3] = sentences.map(s => s.key);

	assert.ok(Core.mergeKeys(store, [s2, s3]));
	let units = Core.buildUnits(sentences, store);
	assert.equal(units.length, 2);
	assert.deepEqual(units[1].keys, [s2, s3]);
	assert.ok(units[1].merged);

	Core.setExcluded(store, [s1], true);
	let groups = Core.planGeneration(sentences, store);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].units.length, 1);
	let { messages, idMap } = Core.buildMessages(groups[0]);
	assert.ok(messages[1].content.includes('<s id="s1" merged="true">'));
	assert.ok(!messages[1].content.includes('<hl c="yellow">disc-shaped'), 'excluded sentence not sent');
	assert.deepEqual(idMap.s1, [s2, s3]);

	let { results } = Core.parseResponse('{"groups":[{"sentence_ids":["s1"],"questions":["Q?"]}],"skipped":[]}', idMap);
	Core.applyResults(store, groups[0], results);
	assert.deepEqual(Core.activeCards(store)[0].sentenceKeys, [s2, s3]);
	assert.equal(Core.planGeneration(sentences, store).length, 0);

	// Limit to a page/selection: selecting one sentence of a merge sends the whole merge
	Core.setExcluded(store, [s1], false);
	let limited = Core.planGeneration(sentences, store, { keys: [s1] });
	assert.equal(limited[0].units.length, 1);
	assert.deepEqual(limited[0].units[0].keys, [s1]);

	// Splitting after generation: cards made for the merge stay; merging anew marks them changed
	Core.splitKeys(store, [s2]);
	assert.equal(Core.buildUnits(sentences, store).length, 3);
	Core.mergeKeys(store, [s1, s2]);
	let cls = Core.classify(sentences, store);
	assert.ok(cls.changed.some(s => s.key === s2), 'new merge invalidates old cards');
});

test('review: include the previous or next non-highlighted sentence', () => {
	let doc = makeDoc();
	let a3 = ann('A3', P1B, 'Dense (or δ) granules', 1, 50, 700);
	let store = Core.emptyStore('X');
	let { sentences } = Core.extractFromDocument(doc, [a3]);
	assert.equal(sentences.length, 1);
	let s = sentences[0];
	assert.equal(s.before[s.before.length - 1].startsWith('α-Granules have the adhesion molecule'), true);
	assert.deepEqual(s.after, []);

	Core.extendKey(store, s.key, 'before', 1);
	let [unit] = Core.buildUnits(sentences, store);
	assert.equal(unit.before.length, 1);
	let [group] = Core.planGeneration(sentences, store);
	let { messages, idMap } = Core.buildMessages(group);
	assert.ok(/<s id="s1">α-Granules have the adhesion molecule .*fibrinogen\. <hl c="yellow">Dense/.test(messages[1].content));

	let { results } = Core.parseResponse('{"groups":[{"sentence_ids":["s1"],"questions":["Q?"]}],"skipped":[]}', idMap);
	Core.applyResults(store, group, results);
	let card = Core.activeCards(store)[0];
	assert.ok(Core.backHTML(store, card).startsWith('α-Granules have'), 'context on the back');
	assert.equal(Core.planGeneration(sentences, store).length, 0);

	// Removing the context afterwards marks the card as changed
	Core.extendKey(store, s.key, 'before', -1);
	assert.equal(Core.classify(sentences, store).changed.length, 1);
	assert.equal(store.review.extend[s.key], undefined);
});

test('anki state: new, sent, changed after edit; tags parsing; edited back', () => {
	let doc = makeDoc();
	let a3 = ann('A3', P1B, 'Dense (or δ) granules', 1, 50, 700);
	let store = Core.emptyStore('X');
	let { sentences } = Core.extractFromDocument(doc, [a3]);
	let [group] = Core.planGeneration(sentences, store);
	let { idMap } = Core.buildMessages(group);
	Core.applyResults(store, group, Core.parseResponse('{"groups":[{"sentence_ids":["s1"],"questions":["Q?"]}],"skipped":[]}', idMap).results);
	let card = Core.activeCards(store)[0];
	let tags = Core.parseTags('  patologia::emostasi  zotrecall patologia::emostasi ');
	assert.deepEqual(tags, ['patologia::emostasi', 'zotrecall']);

	assert.equal(Core.ankiState(store, card, tags), 'new');
	assert.equal(Core.unsentCards(store, tags).length, 1);
	Core.markSent(store, card, { noteId: 123, deck: 'A::B', tags });
	assert.equal(Core.ankiState(store, card, tags), 'sent');
	assert.equal(Core.unsentCards(store, tags).length, 0, 'sent card excluded from unsentCards');
	assert.equal(Core.ankiState(store, card, [...tags].reverse()), 'sent', 'tag order does not matter');
	assert.equal(Core.ankiState(store, card, []), 'changed', 'different tags');
	assert.equal(Core.unsentCards(store, []).length, 1, 'card with changed tags included in unsentCards');

	Core.editCard(store, card.id, null, '<b>Dense</b> granules');
	assert.equal(Core.backHTML(store, card), '<b>Dense</b> granules');
	assert.equal(card.question, 'Q?');
	assert.equal(Core.ankiState(store, card, tags), 'changed');
	assert.equal(Core.unsentCards(store, tags).length, 1, 'edited card included in unsentCards');
	Core.editCard(store, card.id, null, null);
	assert.ok(Core.backHTML(store, card).includes('background-color'), 'back restored');
	assert.equal(Core.ankiState(store, card, tags), 'sent');
	assert.equal(Core.unsentCards(store, tags).length, 0);
});

test('review: merge preserves selection order even when reverse of document order', () => {
	let doc = makeDoc();
	let a1 = ann('A1', P1A, 'disc-shaped', 0, 50, 600);
	let a3 = ann('A3', P1B, 'Dense (or δ) granules', 1, 50, 700);
	let store = Core.emptyStore('X');
	let { sentences } = Core.extractFromDocument(doc, [a1, a3]);
	let [sPage1, sPage2] = sentences.map(s => s.key);

	// Select page 2 first, then page 1
	assert.ok(Core.mergeKeys(store, [sPage2, sPage1]));
	let units = Core.buildUnits(sentences, store);
	assert.equal(units.length, 1);
	assert.deepEqual(units[0].keys, [sPage2, sPage1]);
	assert.equal(units[0].sentences[0].key, sPage2);
	assert.equal(units[0].sentences[1].key, sPage1);

	let [group] = Core.planGeneration(sentences, store);
	let { messages, idMap } = Core.buildMessages(group);
	assert.deepEqual(idMap.s1, [sPage2, sPage1]);
	assert.ok(
		messages[1].content.includes('<s id="s1" merged="true"><hl c="yellow">Dense (or δ) granules</hl> contain adenosine diphosphate (ADP), see Fig. 4.5 for details. Platelets are <hl c="yellow">disc-shaped</hl> anucleate cell fragments.</s>'),
		'merged prompt follows selection order'
	);

	let { results } = Core.parseResponse('{"groups":[{"sentence_ids":["s1"],"questions":["Q?"]}],"skipped":[]}', idMap);
	Core.applyResults(store, group, results);
	let card = Core.activeCards(store)[0];
	assert.deepEqual(card.sentenceKeys, [sPage2, sPage1]);
	assert.ok(Core.backHTML(store, card).indexOf('Dense') < Core.backHTML(store, card).indexOf('disc-shaped'));
	assert.equal(Core.planGeneration(sentences, store).length, 0);

	// Re-merging in the opposite order marks existing cards as changed
	assert.ok(Core.mergeKeys(store, [sPage1, sPage2]));
	assert.equal(Core.classify(sentences, store).changed.length, 2);
});

test('review: manual unit editing persists in sidebar, goes to LLM, and marks cards changed', () => {
	let doc = makeDoc();
	let a3 = ann('A3', P1B, 'Dense (or δ) granules', 1, 50, 700);
	let store = Core.emptyStore('X');
	let { sentences } = Core.extractFromDocument(doc, [a3]);
	let sKey = sentences[0].key;

	assert.ok(Core.setUnitEdit(store, [sKey], {
		text: 'Dense granules store ADP and serotonin.',
		spans: [
			{ start: 0, end: 14, color: '#ffd400' },
			{ start: 21, end: 38, color: '#5fb236' },
		],
	}));

	let [unit] = Core.buildUnits(sentences, store);
	assert.equal(unit.edited, true);
	assert.equal(unit.renderSentences.length, 1);
	assert.equal(unit.renderSentences[0].text, 'Dense granules store ADP and serotonin.');

	let [group] = Core.planGeneration(sentences, store);
	let { messages, idMap } = Core.buildMessages(group);
	assert.ok(messages[1].content.includes('<s id="s1"><hl c="yellow">Dense granules</hl> store <hl c="green">ADP and serotonin</hl>.</s>'));

	let { results } = Core.parseResponse('{"groups":[{"sentence_ids":["s1"],"questions":["What do dense granules store?"]}],"skipped":[]}', idMap);
	Core.applyResults(store, group, results);
	let card = Core.activeCards(store)[0];
	assert.ok(Core.backHTML(store, card).includes('ADP and serotonin'));
	assert.equal(Core.planGeneration(sentences, store).length, 0);

	// Editing the unit text again marks the sentence as changed
	Core.setUnitEdit(store, [sKey], {
		text: 'Dense granules store ADP, ATP, and serotonin.',
		spans: [{ start: 0, end: 14, color: '#ffd400' }],
	});
	assert.equal(Core.classify(sentences, store).changed.length, 1);

	// Restoring original unit removes the edit
	Core.clearUnitEdit(store, [sKey]);
	let [restored] = Core.buildUnits(sentences, store);
	assert.equal(restored.edited, false);
	assert.equal(restored.renderSentences[0].text, sentences[0].text);
});

