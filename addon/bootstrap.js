/* global Services, APP_SHUTDOWN */
var ZotRecall, ZotRecallCore, ZotRecallUI;

function install() {}

async function startup({ id, version, rootURI }) {
	await Zotero.initializationPromise;
	// Web globals used by core.js that the bootstrap scope doesn't provide by default
	Components.utils.importGlobalProperties(['TextEncoder', 'TextDecoder', 'atob', 'btoa']);
	Services.scriptloader.loadSubScript(rootURI + 'content/core.js');
	Services.scriptloader.loadSubScript(rootURI + 'content/ui.js');
	Services.scriptloader.loadSubScript(rootURI + 'content/zotrecall.js');
	ZotRecall.init({ id, version, rootURI });
}

function onMainWindowLoad() {}

function onMainWindowUnload() {}

function shutdown(data, reason) {
	if (reason === APP_SHUTDOWN) return;
	try {
		ZotRecall && ZotRecall.shutdown();
	}
	catch (e) {
		Zotero.logError(e);
	}
	ZotRecall = undefined;
	ZotRecallUI = undefined;
	ZotRecallCore = undefined;
}

function uninstall() {}
