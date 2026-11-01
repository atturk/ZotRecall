# ZotRecall

Plugin per Zotero 10 che trasforma le evidenziazioni dei PDF in domande di recall per Anki. Le domande vengono generate da un LLM via OpenRouter. Sul retro della carta il plugin mette il periodo originale, con le evidenziazioni nei colori di Zotero.

## Installazione

1. Scarica il file `zotrecall-<versione>.xpi`.
2. In Zotero apri Strumenti → Plugin.
3. Clicca la rotellina in alto a destra, scegli "Install Plugin From File…" e seleziona il file.
4. Apri un PDF. Il bottone di ZotRecall compare nella barra in alto a destra del lettore (se il PDF era già aperto, chiudi la scheda e riaprila).

## Come funziona

- Il testo viene dal testo strutturato che Zotero 10 estrae da ogni PDF. Questo testo ha già i paragrafi, i titoli e le intestazioni da scartare, e ricuce i paragrafi che continuano sulla pagina successiva.
- Ogni evidenziazione viene collegata ai caratteri che copre. Il plugin ricostruisce poi il periodo intero che la contiene.
- Il modello riceve il periodo con le parti evidenziate marcate (`<hl c="yellow">…</hl>`), più il titolo della sezione e la prima frase del paragrafo come contesto.

## Sviluppo

```sh
npm test          # test della logica (Node 22+, nessuna dipendenza)
npm run build     # crea build/zotrecall-<versione>.xpi
```

Struttura:

- `addon/bootstrap.js`: punto d'ingresso del plugin (Zotero bootstrap).
- `addon/content/core.js`: logica pura (estrazione, prompt, carte, CSV), testata in Node.
- `addon/content/zotrecall.js`: integrazione con Zotero (annotazioni, testo strutturato, impostazioni, OpenRouter, AnkiConnect).
- `addon/content/ui.js`: bottone nel lettore e popup.

La specifica completa è nel documento di progetto.
