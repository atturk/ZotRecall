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

## Revisione nella barra laterale

Nella barra laterale sinistra del lettore, accanto a miniature, annotazioni e indice, c'è una quarta scheda: ZotRecall. Mostra i periodi evidenziati di tutto il documento, ognuno con il suo stato (da generare, con carta, cambiato, escluso).

- Clic seleziona un periodo e porta all'evidenziazione. Cmd/Ctrl+clic aggiunge o toglie dalla selezione, Maiusc+clic seleziona un intervallo.
- "Unisci" fa di più periodi un unico periodo: il modello lo riceve come un'unica unità e le carte avranno sul retro tutti i periodi uniti. "Separa" annulla l'unione.
- "Escludi" toglie un periodo dalla generazione senza cancellare l'evidenziazione.
- Il menu ⋯ di ogni periodo offre le stesse azioni.
- "Genera pagina", "Genera tutto" e "Genera" sulla selezione chiedono sempre conferma, indicando quanti periodi verranno inviati al modello.

La barra laterale del lettore non ha un'API per i plugin, quindi la scheda viene aggiunta direttamente all'interfaccia. Se una versione futura di Zotero la cambia, la scheda può sparire, ma il resto del plugin continua a funzionare dal bottone in alto.

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
- `addon/content/sidebar.js`: scheda di revisione nella barra laterale.

La specifica completa è nel documento di progetto.
