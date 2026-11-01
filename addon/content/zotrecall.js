/*
 * ZotRecall: Zotero integration (annotations, structured text, settings,
 * OpenRouter, AnkiConnect). UI lives in ui.js, pure logic in core.js.
 */
var ZotRecall = {
	id: null,
	version: null,
	rootURI: null,
	PREF_PREFIX: 'extensions.zotrecall.',
	LOGIN_ORIGIN: 'chrome://zotrecall',
	LOGIN_REALM: 'OpenRouter API key',
	_sdtCache: new Map(),

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		ZotRecallUI.init(this);
		Zotero.Reader.registerEventListener('renderToolbar', (event) => {
			try {
				ZotRecallUI.onRenderToolbar(event);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}, id);
		this.log('Started ' + version);
	},

	shutdown() {
		ZotRecallUI.shutdown();
		this._sdtCache.clear();
	},

	log(msg) {
		Zotero.debug('ZotRecall: ' + msg);
	},

	// ------------------------------------------------------------------
	// Settings
	// ------------------------------------------------------------------

	getPref(name) {
		return Zotero.Prefs.get(this.PREF_PREFIX + name, true);
	},

	setPref(name, value) {
		Zotero.Prefs.set(this.PREF_PREFIX + name, value, true);
	},

	getJSONPref(name, fallback) {
		try {
			let v = JSON.parse(this.getPref(name) || '');
			return v ?? fallback;
		}
		catch (e) {
			return fallback;
		}
	},

	getSettings() {
		return {
			model: this.getPref('model') || 'openai/gpt-6-luna',
			language: this.getPref('language') || 'Italiano',
			systemPrompt: this.getPref('systemPrompt') || '',
			colorMeanings: this.getJSONPref('colorMeanings', {}),
			disabledColors: this.getJSONPref('disabledColors', []),
			concurrency: Math.max(1, Math.min(8, parseInt(this.getPref('concurrency')) || 3)),
			ankiURL: this.getPref('ankiURL') || 'http://127.0.0.1:8765',
			ankiKey: this.getPref('ankiKey') || '',
		};
	},

	saveSettings(s) {
		this.setPref('model', String(s.model || '').trim());
		this.setPref('language', String(s.language || '').trim());
		let prompt = String(s.systemPrompt || '');
		this.setPref('systemPrompt', prompt.trim() === ZotRecallCore.DEFAULT_SYSTEM_PROMPT.trim() ? '' : prompt);
		this.setPref('colorMeanings', JSON.stringify(s.colorMeanings || {}));
		this.setPref('disabledColors', JSON.stringify(s.disabledColors || []));
		this.setPref('concurrency', parseInt(s.concurrency) || 3);
		this.setPref('ankiURL', String(s.ankiURL || '').trim());
		this.setPref('ankiKey', String(s.ankiKey || '').trim());
	},

	async getAPIKey() {
		try {
			let logins = await Services.logins.searchLoginsAsync({
				origin: this.LOGIN_ORIGIN,
				httpRealm: this.LOGIN_REALM,
			});
			return logins.length ? logins[0].password : '';
		}
		catch (e) {
			Zotero.logError(e);
			return '';
		}
	},

	async setAPIKey(key) {
		key = String(key || '').trim();
		let logins = await Services.logins.searchLoginsAsync({
			origin: this.LOGIN_ORIGIN,
			httpRealm: this.LOGIN_REALM,
		});
		for (let login of logins) {
			Services.logins.removeLogin(login);
		}
		if (!key) return;
		let LoginInfo = Components.Constructor('@mozilla.org/login-manager/loginInfo;1', Ci.nsILoginInfo, 'init');
		await Services.logins.addLoginAsync(new LoginInfo(this.LOGIN_ORIGIN, null, this.LOGIN_REALM, 'openrouter', key, '', ''));
	},

	// ------------------------------------------------------------------
	// Reader state
	// ------------------------------------------------------------------

	getAttachment(reader) {
		return Zotero.Items.get(reader.itemID);
	},

	getCurrentPageIndex(reader) {
		try {
			let state = reader._internalReader && reader._internalReader._state;
			let stats = state && (state.primary === false ? state.secondaryViewStats : state.primaryViewStats);
			if (stats && Number.isInteger(stats.pageIndex)) return stats.pageIndex;
		}
		catch (e) {}
		try {
			let state = reader._state;
			if (state && Number.isInteger(state.pageIndex)) return state.pageIndex;
		}
		catch (e) {}
		return 0;
	},

	/** Highlight/underline annotations of an attachment as plain objects. */
	getAnnotations(attachment) {
		let disabled = new Set((this.getSettings().disabledColors || []).map(c => String(c).toLowerCase()));
		return attachment.getAnnotations()
			.filter(a => ['highlight', 'underline'].includes(a.annotationType))
			.map(a => ({
				key: a.key,
				type: a.annotationType,
				color: (a.annotationColor || '#ffd400').toLowerCase(),
				sortIndex: a.annotationSortIndex,
				text: a.annotationText || '',
				position: a.annotationPosition,
				dateModified: a.dateModified,
			}))
			.filter(a => !disabled.has(ZotRecallCore.colorName(a.color)));
	},

	annotationPageIndexes(annotation) {
		try {
			let pos = typeof annotation.position === 'string' ? JSON.parse(annotation.position) : annotation.position;
			let pages = [pos.pageIndex];
			if (pos.nextPageRects && pos.nextPageRects.length) pages.push(pos.pageIndex + 1);
			return pages;
		}
		catch (e) {
			return [];
		}
	},

	countPageHighlights(attachment, pageIndex) {
		return this.getAnnotations(attachment)
			.filter(a => this.annotationPageIndexes(a)[0] === pageIndex)
			.length;
	},

	// ------------------------------------------------------------------
	// Structured text
	// ------------------------------------------------------------------

	async getStructuredText(attachment) {
		let hash = await attachment.attachmentHash;
		let cached = this._sdtCache.get(attachment.id);
		if (cached && cached.hash === hash) return cached.sdt;
		if (!Zotero.SDT || !Zotero.SDT.getReader) {
			throw new Error('Questa versione di Zotero non fornisce il testo strutturato (serve Zotero 10).');
		}
		let packReader = await Zotero.SDT.getReader(attachment.id, { isPriority: true });
		if (!packReader) {
			throw new Error('Zotero non è riuscito a estrarre il testo di questo PDF.');
		}
		let sdt = await packReader.materialize();
		this._sdtCache.clear();
		this._sdtCache.set(attachment.id, { hash, sdt });
		return sdt;
	},

	/** Highlighted sentences of the whole document (or of one page). */
	async extract(attachment, pageIndex = null) {
		let sdt = await this.getStructuredText(attachment);
		let annotations = this.getAnnotations(attachment);
		let { sentences, unmatched } = ZotRecallCore.extractFromDocument(sdt, annotations);
		if (pageIndex !== null) {
			sentences = sentences.filter(s => s.pageIndex === pageIndex);
			let pageKeys = new Set(annotations
				.filter(a => this.annotationPageIndexes(a)[0] === pageIndex)
				.map(a => a.key));
			unmatched = unmatched.filter(k => pageKeys.has(k));
		}
		return { sentences, unmatched, annotations };
	},

	// ------------------------------------------------------------------
	// Connection tests
	// ------------------------------------------------------------------

	async testOpenRouter(apiKey, model) {
		if (!apiKey) throw new Error('Inserisci la chiave API.');
		let keyReq = await Zotero.HTTP.request('GET', 'https://openrouter.ai/api/v1/key', {
			headers: { Authorization: 'Bearer ' + apiKey },
			responseType: 'json',
			successCodes: false,
			timeout: 20000,
		});
		if (keyReq.status === 401) throw new Error('Chiave API non valida.');
		if (keyReq.status !== 200) throw new Error('OpenRouter ha risposto ' + keyReq.status + '.');
		let modelsReq = await Zotero.HTTP.request('GET', 'https://openrouter.ai/api/v1/models', {
			responseType: 'json',
			successCodes: false,
			timeout: 20000,
		});
		let models = (modelsReq.response && modelsReq.response.data) || [];
		let found = models.find(m => m.id === model);
		if (!found) throw new Error(`Chiave valida, ma il modello "${model}" non esiste su OpenRouter.`);
		let structured = (found.supported_parameters || []).includes('response_format')
			|| (found.supported_parameters || []).includes('structured_outputs');
		return `Chiave valida. Modello ${found.name || model} disponibile`
			+ (structured ? ', con output JSON strutturato.' : '.');
	},

	async ankiRequest(action, params = {}) {
		let { ankiURL, ankiKey } = this.getSettings();
		let body = { action, version: 6, params };
		if (ankiKey) body.key = ankiKey;
		let req = await Zotero.HTTP.request('POST', ankiURL, {
			body: JSON.stringify(body),
			headers: { 'Content-Type': 'application/json' },
			responseType: 'json',
			successCodes: false,
			timeout: 15000,
		});
		if (req.status !== 200) throw new Error('AnkiConnect ha risposto ' + req.status + '.');
		let res = req.response;
		if (!res || typeof res !== 'object') throw new Error('Risposta di AnkiConnect non valida.');
		if (res.error) throw new Error('AnkiConnect: ' + res.error);
		return res.result;
	},

	async testAnki() {
		let version;
		try {
			version = await this.ankiRequest('version');
		}
		catch (e) {
			if (/AnkiConnect/.test(e.message)) throw e;
			throw new Error('Anki non risponde. È aperto e AnkiConnect è attivo all\'indirizzo indicato?');
		}
		let needed = ['deckNames', 'createDeck', 'modelNames', 'modelFieldNames', 'addNotes', 'updateNoteFields', 'notesInfo'];
		let missing = [];
		try {
			let reflect = await this.ankiRequest('apiReflect', { scopes: ['actions'], actions: needed });
			let available = new Set((reflect && reflect.actions) || []);
			missing = needed.filter(a => !available.has(a));
		}
		catch (e) {
			this.log('apiReflect failed: ' + e.message);
		}
		let decks = await this.ankiRequest('deckNames');
		return `Connesso ad AnkiConnect (versione ${version}), ${decks.length} mazzi.`
			+ (missing.length ? ' Azioni mancanti: ' + missing.join(', ') + '.' : '');
	},
};
