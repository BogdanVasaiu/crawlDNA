# crawldna — TODO miglioramenti

> Backlog di miglioramenti **allineati alla filosofia del progetto**, pensato per
> essere lavorato un pezzo alla volta nelle sessioni future. In una nuova sessione
> basta dire: _"apri TODO.md e implementiamo il #N"_.
>
> Fonti: revisione approfondita (2026-06-30) di concorrenti (Crawl4AI, Firecrawl/
> FIRE-1, Skyvern, browser-use) + ricerca accademica, incrociata col nostro codice
> (item #1–#12); revisione ingegneristica integrale del codice (2026-07-02, Claude
> Fable) → correzioni applicate + item #13–#18 (vedi la sezione "Revisione
> ingegneristica completa — 2026-07-02"); sessione architetturale 2026-07-02
> (modalità no-AI, parametri espliciti al posto dello sniffing della task, reveal
> a ciclo chiuso, embeddings) → item #19–#22 (Gruppo D).
> Vedi anche [ARCHITECTURE.md](ARCHITECTURE.md) e [build-spec.md](build-spec.md).

---

## Posizionamento (cosa È crawldna)

crawldna è uno **strumento generale e autonomo**, utile a chiunque — non un pezzo di
refdna. Il suo valore, per qualsiasi utente e qualsiasi sito:

1. **Estrae tutto, anche il nascosto/dinamico** (il reveal: tab, accordion, "load more",
   wizard, contenuto lazy). È il differenziatore.
2. **Segue una task generica QUALSIASI e la rispetta** ("la documentazione", "il menù
   delle pizze", "i prezzi", "gli orari") → tiene solo ciò che la task chiede.
3. **Output pulito, senza roba inutile**, e **fedele** (verbatim nel crawl; ogni
   trasformazione è Fase 2/reshape).

**refdna è SOLO UNO dei consumatori** (userà crawldna per il caso "documentazioni").
Le scelte di design vanno valutate sul tool **generale**, non su refdna. Differenza dai
concorrenti task-driven (Firecrawl `/extract`, ScrapeGraphAI): loro **trasformano** la
pagina nei campi di uno schema; crawldna tiene **tutto il pertinente, verbatim** — non
perdi ciò che non avevi previsto.

---

## Regole non negoziabili (valgono per OGNI item qui sotto)

Chi implementa un punto DEVE rispettare questi principi, anche a costo di fare di meno:

1. **Precisione prima della velocità, sempre.** Lento va bene. **Mai perdere contenuto.**
   Ogni ottimizzazione che *potrebbe* scartare contenuto va resa **opzionale** o
   **conservativa**, e va verificata che non riduca la copertura.
2. **Universale, mai per-sito.** Niente regex/selettori specifici di un sito o
   framework. Le decisioni si basano sulla **task dell'utente** (via AI o segnali di
   testo universali), non sulla forma degli URL del sito.
3. **Due fasi separate.** Il *crawl* (Fase 1) tiene contenuto **verbatim**; filtri,
   tabelle, split sono **Fase 2 (reshape)** sui file salvati. Un item non deve
   spostare lavoro di reshape dentro il crawl.
4. **Backstop deterministici = leggono l'istruzione dell'utente, non il sito.** Sono
   ammessi come rete di sicurezza, ma il giudice primario resta l'AI.
5. **Dipendenze minime.** Preferire JS puro / Node built-in. Niente dipendenze pesanti
   nel core senza un buon motivo.
6. **Il testo libero non pilota mai il motore** (deciso 2026-07-02). La task parla SOLO
   all'AI (e nomina l'output); ogni switch di comportamento (profilo/completezza, focus,
   no-AI) è un **parametro esplicito** scelto dall'utente — mai una regex che sniffa la
   prosa. Corollario: la modalità **no-AI è sacra — zero chiamate a QUALSIASI modello**
   (chat ED embeddings); il click engine resta completo, si rinuncia solo alle decisioni
   tieni/scarta. Le due visioni da rispettare in ogni item: **AI** = trova, naviga,
   clicca ed estrae ciò che conta per la task; **no-AI** = stesso click engine, nessuna
   decisione su cosa tenere (si tiene tutto).

**Come verificare di non aver perso nulla** (per gli item a rischio): rifare un crawl
di riferimento (es. Firebase web, o un sito calendario tipo ACI Cremona) *prima e dopo*
la modifica e confrontare numero di pagine tenute, byte totali, e i blocchi rivelati.

---

## Previsioni oneste — cosa risolvono e cosa NO

- **Gruppo A (#1–#9)** migliora **nettamente precisione e tempi/consumi** del *crawl*.
  Alta confidenza.
- **Il "rispetto della task"** (output mirato, senza roba inutile) è una **spina a 3
  livelli**: la frontiera (**#1**: quali pagine), lo scope di sezione (`aiScopeContent`:
  quali parti di una pagina) e il **reshape/#11** (filtro fine finale). Il Gruppo A
  copre il primo livello; il #11 il terzo. La ricerca avverte: gli LLM confondono
  *istruzione* e *contenuto* → un secondo passaggio di verifica aiuta (vedi #11/#12).
- **La completezza al 100% non è dimostrabile** (risultato accademico: un singolo crawl
  non sa quanto ha mancato). Si **misura per proxy** → vedi **#12** (copertura sitemap +
  metro stile SWDE su task diverse).
- **Il modello locale NON è un tetto duro** per classificazione/estrazione (la ricerca
  dice differenza ~2% coi grandi, non significativa; soffre di *recall* non di
  precisione). #1/#2 lo rendono più affidabile trasformando i giudizi in
  classificazione vincolata.
- **Fuori scope per sempre** (ARCHITECTURE.md §14): login/paywall, CAPTCHA, contenuto
  solo-immagine/canvas. Si saltano con un warning, non si aggirano.

---

## Tabella riassuntiva

**Gruppo A — Crawl: precisione & consumi**

| # | Titolo | Effetto | Sforzo | Stato |
|---|--------|---------|--------|-------|
| 1 | Link relevance ranking dalla task (information foraging) | consumi + precisione | Medio | ✅ fatto (2026-07-01, da verificare dal vivo) |
| 2 | Output JSON vincolato (constrained decoding) | consumi + precisione | Basso | ✅ fatto (2026-07-01, da verificare dal vivo) |
| 3 | Trigger "documentazione" universale (multilingua) | consumi + precisione | Basso-Medio | ✅ fatto (2026-07-01) |
| 4 | Prompt caching del prefisso istruzioni (API remote) | consumi | Basso | ✅ fatto (2026-07-02) |
| 5 | Riuso contesto browser per worker (cache asset) | consumi (tempo+banda) | Basso-Medio | ✅ fatto (2026-07-01, verificato con browser reale) |
| 6 | Crawl incrementale (ETag / Last-Modified / lastmod) | consumi (enorme per refdna) | Medio | ✅ fatto (2026-07-06) — lastmod-skip + HTTP 304 + hash-net, `--incremental` |
| 7 | Dedup near-duplicate con SimHash | precisione output + consumi | Medio | ✅ fatto (2026-07-01 opt-in; 2026-07-02 tier mirror/variante DEFAULT-ON + stop espansione dai duplicati) |
| 8 | Estrazione stile Trafilatura (pruning per densità link) | precisione | Medio | ✅ fatto (2026-07-01) |
| 9 | Rinforzo reveal: accessibility-tree / Set-of-Marks | precisione (casi difficili) | Alto | 🟡 Fase 1 fatta (2026-07-06: a11y-role + gate label rilassato su residuo alto); Fase 2 (Set-of-Marks/vision) deferita (residuo reale ~5%) |

**Gruppo B — Rispetto della task & fruibilità dell'output (generale)**

| # | Titolo | Effetto | Sforzo | Stato |
|---|--------|---------|--------|-------|
| 10 | Output per-documento identificabile + metadata (opzione) | fruibilità | Medio | ✅ fatto (2026-07-01) |
| 11 | Reshape (Fase 2): fedeltà verificata | rispetto-task | Medio | ✅ fatto (2026-07-02) |
| 12 | Harness di misurazione (completezza / rispetto-task / token) | trasversale — abilita tutto | Medio | ✅ fatto (2026-07-01, da verificare dal vivo) |
| 24 | Fedeltà di layout dell'.md (varianti in posizione, link esterni, indentazione) | precisione output — leggibilità | Medio | ✅ fatto (2026-07-04) |
| 25 | App incorporate: viste raggiunte (nav-in-main), budget protetto (futility guard), liste/tabelle leggibili | precisione reveal + leggibilità output | Medio | ✅ fatto (2026-07-04) |
| 26 | Recupero heading per peso visivo (scheletro dell'.md, deterministico) | precisione output — struttura, abilita meglio il reshape | Medio | ✅ fatto (2026-07-04, commit d4cf445 + regressione ce1d218) |
| 28 | Copertura totale dei cliccabili: controlli JS nella chrome (nav/header/footer) | precisione reveal — nessun cliccabile perso | Basso-Medio | ✅ fatto (2026-07-04) |
| 29 | Reveal "compatto ma strutturato" + record fedele per-stato (`states/`) | precisione output — struttura/contesto tra stati | Medio | ✅ fatto (2026-07-04) |

**Gruppo C — Affidabilità & operazioni** (dalla revisione ingegneristica 2026-07-02)

| # | Titolo | Effetto | Sforzo | Stato |
|---|--------|---------|--------|-------|
| 13 | Persistenza incrementale + resume del crawl | affidabilità (crash ≠ perdita totale) | Medio-Alto | ✅ fatto (2026-07-02) |
| 14 | Politeness opt-in (delay/robots) + rilevamento anti-bot/challenge | affidabilità / reputazione | Basso-Medio | ✅ fatto (2026-07-03) |
| 15 | Render-wait: response-quiet al posto di `networkidle` | tempo (−secondi fissi per pagina) | Basso-Medio | ✅ fatto (2026-07-02, da verificare dal vivo) |
| 16 | Budget/ranking per le route minate dai JS | consumi (token gate `links`) | Basso | ✅ fatto (2026-07-02, da misurare dal vivo) |
| 17 | CI GitHub Actions (suite offline a ogni push) | qualità continua | Basso | ✅ fatto (2026-07-02) |
| 18 | Packaging npm (playwright peer-optional, metadata repo) | fruibilità libreria | Basso | ✅ fatto (2026-07-06) — deps `optional` (scelta b) + escape-hatch `--omit=optional`, dry-run pulito |

**Gruppo D — Architettura esplicita & no-AI** (sessione 2026-07-02; ogni item deve
rispettare: miglioramento netto qualità/costo/velocità a precisione invariata · usabile
come libreria · sinergia con le componenti esistenti · entrambe le visioni AI/no-AI)

| # | Titolo | Effetto | Sforzo | Stato |
|---|--------|---------|--------|-------|
| 19 | Modalità no-AI (crawl a zero chiamate modello) | fruibilità + costi | Basso | ✅ fatto (2026-07-02, da committare) |
| 20 | `mode` esplicito (complete/targeted) — via lo sniffing della task | architettura + costi (−gate/scope in complete) | Medio | ✅ fatto (2026-07-03) |
| 21 | Reveal a ciclo chiuso (misura, non giudizio) | precisione reveal — la missione | Medio-Alto | ✅ fatto (2026-07-03) |
| 22 | Tier embeddings (`embedModel`) — ranking semantico multilingua | qualità ranking + Reshape | Medio | ✅ fatto (2026-07-03) |

**Da fare per primi (qualità del crawl):** #1, #2, #3. *(fatti)*
**Per dimostrare il valore (misurabile):** #12. *(fatto)*
**Per i consumatori programmatici (refdna incluso):** #10 + #6.

### Ordine consigliato per gli item aperti (2026-07-02)

0. **Smoke test dal vivo** (non è un item): un crawl reale (ACI Cremona + un sito docs)
   per validare le correzioni della revisione 2026-07-02 e chiudere i "⏳ da verificare
   dal vivo" di #1/#2/#12 — compilando una golden spec vera per l'harness, così ogni
   item successivo ha il numero prima/dopo.
1. **#17 CI** — 10 minuti; da lì in poi ogni altro item è protetto dai test a ogni push.
2. **#13 persistenza incrementale + resume** — PRIMA del #6: crea il layer di scrittura
   per-URL su disco su cui il crawl incrementale si appoggia (evita di rifarlo due volte).
3. **#15 render-wait response-quiet** — basso rischio, secondi fissi risparmiati a pagina;
   rende più rapidi anche tutti i test dal vivo degli item successivi.
4. **#16 budget route JS** — piccolo, taglia token del gate `links`; misurabile subito.
5. **#14 politeness opt-in** — obbligatorio prima di pubblicizzare il pacchetto.
6. **#6 crawl incrementale (ETag/lastmod)** — eredita gratis la persistenza del #13.
7. **#18 packaging npm** — agganciato al momento del publish.
8. **#9 accessibility-tree / Set-of-Marks** — per ultimo: sforzo più alto per i casi più
   rari; affrontarlo quando un sito reale mostra un controllo che il path DOM non trova.

### Ordine aggiornato (sessione 2026-07-02 — supersede il precedente per gli item aperti)

0. **Commit del working tree** (non è un item): due commit separati — cambio licenza
   MIT→AGPL-3.0 (LICENSE, package.json, README) e modalità no-AI #19 (core, CLI, UI,
   test, README). Va fatto PRIMA di toccare altro, il tree è sporco.
1. **#20 `mode` esplicito** — è il pezzo architetturale: #21 e #22 ci si appoggiano.
2. **#21 reveal a ciclo chiuso** — il cuore della missione ("mai perdere contenuto"
   diventa misurato, non sperato). Il fix consent è urgente: bug reale anche in AI mode.
3. **#22 tier embeddings** — il boost semantico, dopo che la base è pulita.
4. Poi si torna all'ordine precedente per gli item aperti: #14 politeness → #6
   incrementale → #18 packaging → #9 accessibility-tree.

---

## #1 — Link relevance ranking dalla task (information foraging)
**Effetto:** consumi + precisione · **Sforzo:** Medio · **Stato:** ✅ FATTO (2026-07-01)

> **Implementato.** Nuovo modulo [src/lib/relevance.mjs](src/lib/relevance.mjs)
> (tokenizzazione multilingua + `scoreLink` task→link, zero dipendenze, deterministico).
> Integrato in `decideFollow` ([src/engine/crawl-page.mjs](src/engine/crawl-page.mjs)):
> (a) **default (`minRelevance: 0`)** — non scarta NULLA; usa il punteggio solo per
> ordinare i link **best-first** e per rankare l'input all'AI (così il cap di 160 tiene i
> più pertinenti); (b) **focused mode opt-in (`minRelevance` 0..1)** — scarta i link
> chiaramente fuori-tema PRIMA dell'AI, ma solo quando la task **discrimina** tra i link
> della pagina (un task generico non sovra-taglia mai). Nuova opzione `minRelevance` in
> `DEFAULT_OPTIONS`, esposta in UI ("Focus on task") e CLI (`--min-relevance`).
> **Verificato** (scratchpad): scoring su URL Firebase reali (web/auth=1.0, firestore=0.5,
> iOS/pricing/codelabs=0.0) + flusso di `decideFollow` (default non taglia / focused taglia
> prima dell'AI / generico non sovra-taglia) — ALL PASS. ⏳ **Da verificare dal vivo** con
> un crawl reale (Ollama+Playwright) e da misurare con #12.
>
> _Decisione presa:_ il punteggio NON scarta mai da solo in default (rispetta "non perdere
> contenuto"); il taglio è opt-in. _Possibile seguito:_ best-first a livello di frontiera
> globale (oggi è per-batch di pagina) e passare `context` (heading) ai candidati link.

**Problema oggi.** Il crawl segue *tutti* i link in scope finché la coda è vuota: su
Firebase ha generato ~7000 pagine in coda / 5h, entrando in iOS/Android/pricing che la
task ("web JavaScript/Vue") non chiedeva. Lo scope è affidato solo all'AI-gate
`aiSelectLinks` ([src/engine/decide.mjs:327](src/engine/decide.mjs)) che ha bias
"nel dubbio segui" ed è debole sul modello locale.

**Proposta.** Prima di chiamare l'AI, dare a ogni link scoperto un **punteggio di
rilevanza** rispetto alla task usando solo testo universale (token dell'URL + anchor +
heading vicino):
- **v1 senza dipendenze:** term-overlap / BM25 in JS puro (è la "statistical strategy"
  di default di Crawl4AI).
- **v2 opzionale:** embedding locali (Ollama `nomic-embed-text`) per similarità semantica.

Poi: seguire prima i link ad alto punteggio; mandare all'AI-gate **solo i link
ambigui** (punteggio medio); scartare i chiaramente fuori-tema. Si innesta in
`decideFollow` ([src/engine/crawl-page.mjs:25](src/engine/crawl-page.mjs)) e nella
gestione della frontiera in `runGeneralCrawl` ([src/index.mjs](src/index.mjs)).

**Perché è nella filosofia.** È la **task** a decidere lo scope, con segnali universali
(no regole per-sito). È la versione corretta e supportata da letteratura di ciò che NON
va fatto (regex `exclude` scritte a mano per Firebase).

**Criterio di accettazione (anti-perdita).**
- Su un crawl di riferimento: le pagine **in-tema** tenute restano le stesse (nessuna
  pagina web persa), mentre crollano le pagine fuori-tema visitate e le chiamate
  all'AI-gate.
- ⚠️ **Tenere solo l'ORDINAMENTO/filtro per rilevanza.** Lo "stop quando saturo"
  (early-stopping di Crawl4AI) NON va attivato di default: contraddice "non perdere mai
  contenuto". Eventualmente solo come opzione esplicita.
- Soglia di scarto conservativa: nel dubbio, manda all'AI (non scartare).

**Evidenza.** Focused crawling (Chakrabarti 1999); Crawl4AI adaptive crawling
(`top_k_links`, `KeywordRelevanceScorer`, coverage/saturation).

**File:** `src/engine/crawl-page.mjs` (decideFollow), `src/engine/decide.mjs`
(aiSelectLinks), `src/index.mjs` (frontiera), eventuale nuovo `src/lib/relevance.mjs`.

---

## #2 — Output JSON vincolato (constrained decoding)
**Effetto:** consumi + precisione · **Sforzo:** Basso · **Stato:** ✅ FATTO (2026-07-01)

> **Implementato.** `chat(llm, system, user, schema?)` ([src/lib/llm.mjs](src/lib/llm.mjs))
> ora accetta uno schema opzionale: **Ollama** → `format: schema` (constrained decoding via
> XGrammar — JSON valido al 100%, più veloce); **OpenAI-compatibile** → `response_format:
> {type:'json_object'}` (supportato da OpenAI/DeepSeek/Groq/vLLM/LM Studio), con **retry
> automatico senza** se il provider lo rifiuta (400/404/422/…), così un crawl non si rompe
> mai. Le 5 chiamate di giudizio in [decide.mjs](src/engine/decide.mjs) passano il loro
> schema (`SCHEMAS.reveal/links/keep/relevant/plan`); il **reshape resta testo libero** (non
> è JSON). La validazione a valle in ogni funzione resta la rete di sicurezza.
> **Verificato** (scratchpad transport-json-test): schema→response_format, rifiuto→retry-senza,
> niente-schema→niente-response_format, metering token intatto — ALL PASS. ⏳ **Da verificare
> dal vivo** su Ollama (qwen3-coder:30b) — confermare che `format` accelera e azzera i parse
> falliti; misurare con #12 (token per-tipo).

**Problema oggi.** Le 4 chiamate AI (reveal/scope/links/nav-plan) chiedono JSON come
testo libero e lo estraggono con regex (`parseJson` in
[src/engine/decide.mjs:24](src/engine/decide.mjs)). **Se il parsing fallisce, il
fallback è "segui/tieni TUTTO"** ([src/engine/crawl-page.mjs:40](src/engine/crawl-page.mjs))
→ spreco + vagabondaggio fuori-tema. In `llm.mjs` non si passa nessuno schema.

**Proposta.** In [src/lib/llm.mjs](src/lib/llm.mjs):
- `ollamaChat` → aggiungere il campo `format` con lo **JSON schema** (Ollama usa
  XGrammar per il constrained decoding).
- `openaiChat` → aggiungere `response_format: { type: "json_schema", … }`.
- Estendere `chat(llm, system, user, schema?)` per passare lo schema opzionale; i
  chiamanti in `decide.mjs` forniscono lo schema della rispettiva risposta
  (`{click:[...]}`, `{keep:[...]}`, `{follow:[...]}`, `{direction,target}`).

**Effetto.** JSON valido **100%** delle volte → niente fallback distruttivi (meno
off-task) **e** su Ollama generazione fino a ~6× più veloce (niente token sprecati a
formattare).

**Criterio di accettazione.** Le stesse decisioni di prima ma con zero `parseJson`
falliti nei log; nessuna regressione di copertura; verificare che lo schema non sia
troppo rigido (deve permettere liste vuote = "non seguire/non rivelare nulla").

**Evidenza.** Ollama structured outputs (XGrammar); JSONSchemaBench (arXiv 2501.10868).

**File:** `src/lib/llm.mjs`, `src/engine/decide.mjs`.

---

## #3 — Trigger "documentazione" universale (multilingua)
**Effetto:** consumi + precisione · **Sforzo:** Basso-Medio · **Stato:** ✅ FATTO (2026-07-01)

> **Implementato.** `isDocsTask` ([src/lib/task.mjs](src/lib/task.mjs)) ora matcha lo
> **stem** della parola-documentazione invece di una sola lingua: `documenta` copre
> documentation / documentazione / documentación / documentação / documentatie;
> `dokumenta` copre tedesco/nordico; più `docs`, `api reference`, `sdk`. Lo stem (non un
> "document" nudo) evita falsi positivi su task-dato tipo "the documents list". Una sola
> funzione risolve **entrambe** le metà del bug (via sitemap + niente taglia-sezioni),
> perché è usata sia in index.mjs (strategia) sia in crawl-page.mjs (scope gate).
> **Verificato** (scratchpad task-test): 11 task-docs in 6 lingue (incl. l'esatta task
> Firebase italiana) → tutte true; 6 task-dato (menu/prezzi/orari/"documents list") →
> tutte false. ALL PASS. _Upgrade futuro opzionale:_ classificazione AID dell'intento per
> lingue non-latine (CJK/cirillico), una volta per scan, con questo matcher come fallback.

**Problema oggi.** `isDocsTask` ([src/lib/task.mjs:4](src/lib/task.mjs)) riconosce solo
parole **inglesi** (`documentation|docs|api reference`). Una task in italiano
("documentazione") NON viene riconosciuta → il crawl (1) **salta la via sitemap**
completa+veloce e (2) attiva per sbaglio il taglia-sezioni per-pagina
(`aiScopeContent`, eseguito solo per task NON-doc, [src/engine/crawl-page.mjs:195](src/engine/crawl-page.mjs))
→ brucia token e **rischia di scartare sezioni** di documentazione.

**Proposta (in ordine di preferenza filosofica).**
- **Meglio:** far classificare l'**intento** della task all'AI una volta sola
  (doc / non-doc) — coerente con "l'AI legge la task". Cache per stringa-task.
- **Minimo:** ampliare il backstop a più lingue (documentazione/documentación/
  dokumentation/…). È ammesso (legge l'istruzione dell'utente, non il sito) ma è la
  soluzione "rozza".

**Criterio di accettazione.** Con task "estrai la documentazione…" in italiano: il log
mostra `strategy: docs:sitemap` (o `docs:llms-full`), e `aiScopeContent` NON gira; le
pagine restano intere (verbatim).

**Evidenza.** Comportamento previsto da ARCHITECTURE.md §5/§10 (docs profile).

**File:** `src/lib/task.mjs`, `src/index.mjs:283`, eventuale interpret-step AI.

---

## #4 — Prompt caching del prefisso istruzioni (API remote)
**Effetto:** consumi · **Sforzo:** Basso · **Stato:** ✅ FATTO (2026-07-02)

> **Implementato**, in tre pezzi:
> - **Contratto di stabilità.** I system-prompt delle chiamate di giudizio erano GIÀ
>   literal senza interpolazione (il prefisso stabile che la cache automatica di
>   OpenAI/DeepSeek/vLLM richiede); ora il contratto è esplicito (commento in
>   [decide.mjs](src/engine/decide.mjs)) e **blindato da un test** che verifica
>   byte-identici i system di links/reveal/scope/nav-plan su chiamate con task diverse
>   — un'interpolazione accidentale futura fa fallire la suite.
> - **Metering dei token cachati** (il criterio di accettazione). `openaiChat` legge
>   il riporto del provider — `prompt_tokens_details.cached_tokens` (OpenAI/OpenRouter)
>   o `prompt_cache_hit_tokens` (DeepSeek) — e lo propaga: `tokens.cachedInputTokens`
>   nel run/scan/manifest (+ per-kind in `byKind`), tipi aggiornati, e l'harness #12
>   mostra `N in cached X%` nel report. Ollama non lo riporta → 0 (il riuso KV locale
>   resta invisibile ma gratuito).
> - **`cache_control` esplicito SOLO su OpenRouter** (`buildOpenAiMessages` in
>   [llm.mjs](src/lib/llm.mjs)): i modelli Anthropic dietro OpenRouter cachano solo i
>   blocchi marcati, e OpenRouter documenta la forma content-parts per tutti i modelli
>   (rimuove il campo dove non supportato). Ogni altro endpoint riceve la system
>   string invariata — rischio zero. _Deliberatamente NON fatto:_ marcatore sul layer
>   OpenAI-compat di Anthropic diretto (supporto non documentato; servirebbe un
>   transport nativo Anthropic — fuori scope finché non serve).
>
> **Verificato** (suite permanente, 5 test nuovi, 90 totali): metering nelle due forme
> di riporto + zero-fallback, forma OpenRouter vs plain, prefissi byte-identici.
> ⏳ _Riscontro dal vivo:_ girare un crawl con `--provider openai` su
> DeepSeek/OpenAI/OpenRouter e vedere `cachedInputTokens` crescere dopo le prime
> chiamate di ogni tipo (su OpenAI serve prefisso ≥1024 token perché la cache
> automatica scatti: i system ~400–600 token contano insieme allo schema/user).

**Problema oggi.** I system-prompt in `decide.mjs` sono lunghi (~1.5–2.5k caratteri) e
**identici** su migliaia di chiamate. Su API a pagamento sono token pagati ogni volta.

**Proposta.** Tenere le istruzioni grosse come **prefisso stabile** (già lo sono: sono
nel messaggio `system`). Poi:
- OpenAI / DeepSeek: cachano **automaticamente** i prefissi identici → assicurarsi solo
  che il system-prompt sia byte-identico tra chiamate dello stesso tipo.
- Anthropic-style: aggiungere il marcatore `cache_control` sul blocco system in
  `openaiChat`/transport.

**Effetto.** Token di input ripetuti ~**10× più economici**. Conta soprattutto per la
via a pagamento (refdna). Per Ollama locale è poco rilevante.

**Criterio di accettazione.** Su un provider che riporta i cached tokens, il metering
mostra una quota crescente di input cachato dopo le prime chiamate.

**Evidenza.** Anthropic prompt caching; OpenAI automatic prefix caching.

**File:** `src/lib/llm.mjs`, (struttura prompt) `src/engine/decide.mjs`.

---

## #5 — Riuso contesto browser per worker
**Effetto:** consumi (tempo + banda) · **Sforzo:** Basso-Medio · **Stato:** ✅ FATTO (2026-07-01)

> **Implementato.** [src/lib/browser.mjs](src/lib/browser.mjs) ha ora una **pool di
> contesti**: `newPage()` prende un contesto **idle riusabile** (o ne crea uno) e ritorna
> `{ page, context, release }`; `release()` chiude la pagina e **rimette il contesto nella
> pool** per riuso. La pool è dimensionata sulla concurrency (`configureContextPool`,
> chiamata in [index.mjs](src/index.mjs)), così **ogni worker tiene il suo contesto** →
> parallelismo invariato, ma la **cache HTTP è condivisa** tra le pagine dello stesso sito
> (CSS/JS scaricati una volta). Lo SNIFFER è ora su `addInitScript` **una volta per
> contesto**, non per pagina. I due chiamanti ([crawl-page.mjs](src/engine/crawl-page.mjs),
> [fetcher.mjs](src/lib/fetcher.mjs)) usano `release()` in `finally` (idempotente).
> Contesto riciclato dopo `_maxUses` (100) pagine per igiene.
>
> _Perché NON perde contenuto (regola #1):_ il riuso condivide **solo la cache asset**; non
> cambia cosa rende una pagina, perché il motore (a) apre una `page` nuova e naviga da zero
> per ogni URL, e (b) clicca **tutti** i controlli reveal a prescindere dallo stato client
> ricordato → cookie/localStorage accumulati non possono nascondere contenuto (una tab
> "ricordata" viene comunque cliccata; un tour di primo-accesso è chrome, non contenuto). Il
> consent è comunque dismesso per-pagina. **Verificato con browser reale** (scratchpad,
> 15+3 asserzioni): riuso identità/parallelismo/cap/idempotenza, e **la vittoria** — su 5
> pagine con un contesto riusato il CSS condiviso è scaricato **1 volta vs 5** con contesto
> fresco per pagina; e2e crawl (concurrency 2, 4 pagine) = **2 fetch CSS vs 4**, contenuto
> verbatim invariato. ⏳ **Da confermare dal vivo** su un sito docs grande (tempo medio/pagina).

**Problema oggi.** `newPage()` ([src/lib/browser.mjs:87](src/lib/browser.mjs)) apre un
**contesto nuovo per ogni pagina** → la cache HTTP non è condivisa → CSS/JS comuni del
sito vengono **ri-scaricati per ogni pagina**.

**Proposta.** Riusare **un contesto per worker** (concurrency = N → N contesti
riutilizzati), aprendo/chiudendo solo la `page` per ogni URL. Così il browser cacha gli
asset condivisi tra pagine dello stesso sito, mantenendo il parallelismo. Lo "spione"
(`addInitScript(SNIFFER)`) va messo sul contesto, una volta.

**Criterio di accettazione.** Tempo medio per pagina più basso su un sito doc grande;
nessun cambiamento nel contenuto estratto. Attenzione a stato/cookie tra pagine (per un
crawl in sola lettura è accettabile; valutare reset se un sito si comporta male).

**File:** `src/lib/browser.mjs`, `src/engine/crawl-page.mjs`, `src/index.mjs` (pool worker).

---

## #6 — Crawl incrementale (ETag / Last-Modified / sitemap lastmod)
**Effetto:** consumi (enorme per refdna) · **Sforzo:** Medio · **Stato:** ✅ FATTO
(2026-07-06) — Fette 1 (lastmod-skip) + 2 (HTTP 304) + 3 (hash-net), opt-in `--incremental`

> **Fetta 1 — lastmod-skip (FATTA, opt-in, conservativa).** `incremental: true` (CLI
> `--incremental`) riusa le pagine il cui `<lastmod>` in sitemap è invariato dall'ultima
> run incrementale (salta render+reveal) e ri-crawla solo ciò che è cambiato. Sicura per
> costruzione (regola #1): si riusa SOLO con prova positiva — lastmod salvato E corrente
> entrambi presenti e uguali; ogni incertezza ri-crawla. La prima run incrementale è un
> crawl pieno che stampa il `lastmod` per pagina e RITIENE il journal come baseline; le
> successive riusano da lì. Riusa il replay del resume (#13) per il restore, filtrato ai
> soli record freschi. File: `src/lib/incremental.mjs` (planner puro), `src/profiles/docs/
> sitemap.mjs` (`collectSitemapEntries`/`sitemapLastmodMap` — cattura il lastmod, prima
> scartato), `src/lib/runs.mjs` (`findBaselineRun`/`targetsMatch` + journal ritenuto se
> `options.incremental`), `src/index.mjs` (baseline load + gate per-scan + stamp lastmod
> in addPage + evento `incremental`), CLI `--incremental`. Test: `test/incremental.test.mjs`
> (planner "mai skip nel dubbio", parse lastmod, target-match) + `test/incremental-crawl.
> test.mjs` (E2E offline, sitemap mutabile: 1ª full+baseline → 2ª riusa 3/3 identiche → 3ª
> con 1 pagina cambiata riusa 2/3 e ri-crawla la cambiata). 246 test verdi.
>
> **Fetta 2 — HTTP 304 (FATTA, opt-in, conservativa).** Per le pagine che il lastmod NON
> ha già assolto, se STATIC-SAFE e con un validator salvato: conditional GET in HTTP puro
> (`If-None-Match`/`If-Modified-Since`) → un **304** = il server conferma "byte-identica" →
> riuso senza render. STATIC-SAFE = catturata in un solo stato reveal, residuo nascosto 0
> (`isStaticSafe`): una pagina click/JS-driven NON è mai fidata a un 304 sulla shell (regola
> #1 — la trappola SPA). I validator si stampano in `meta` (`httpEtag`/`httpLastModified`)
> al crawl quando `incremental`. File: `fetcher.mjs` (`conditionalGet`), `incremental.mjs`
> (`isStaticSafe`/`planConditional` puri), `crawl-page.mjs` (cattura validator entrambe le
> vie), `index.mjs` (`conditionalReuse` a concorrenza limitata + tier 304 nel gate + stats
> `viaLastmod`/`via304`). Test: `test/incremental-304.test.mjs` (E2E offline, NO sitemap ma
> ETag+If-None-Match: 1ª full+baseline → 2ª riusa 3/3 via 304 senza ri-servire il body → 3ª
> con 1 ETag cambiato ri-crawla solo quella) + unit `isStaticSafe`/`planConditional`/
> `conditionalGet`. **253 test verdi.**
>
> **Fetta 3 — hash-net (FATTA).** Per le pagine che nessun segnale ha potuto saltare
> (né lastmod né validator), dopo il render si confronta il content-hash (lo stesso sha1
> normalizzato del dedup) con quello della baseline: se combacia, la pagina era invariata.
> NON risparmia il render — riporta solo la VERITÀ (misurata, non indovinata): evento
> `incremental` `phase:'done'` con `reused` / `recrawled` / `unchangedByHash`. Il
> `contentHash` si stampa in `meta` al crawl incrementale. File: `src/index.mjs` (stamp +
> confronto in addPage + report per-scan). Test: `test/incremental-hash.test.mjs` (sito
> senza sitemap né ETag: 2ª run ri-crawla 3 ma hash-net=3 invariate; 3ª con 1 pagina
> editata → 2 invariate, 1 cambiata catturata). **256 test verdi.**
>
> **Nota costo (onestà).** Fetta 2: una pagina cambiata paga un conditional GET (200) IN
> PIÙ del re-crawl; il guadagno è tutto sulle invariate. Fetta 3 non risparmia nulla, è
> solo misura. I due grandi risparmi restano lastmod (docs) e 304 (siti con ETag).

**Problema oggi.** Ogni crawl riparte da zero. refdna dovrà tenere i doc **freschi** nel
tempo: ri-renderizzare migliaia di pagine immutate è spreco puro.

**Proposta.**
- Salvare per URL: `ETag`, `Last-Modified`, hash del contenuto (già calcoliamo un sha1
  in `addPage`).
- Al ri-crawl: mandare `If-None-Match` / `If-Modified-Since` → un **304** salta del
  tutto render + reveal. Confronto hash come rete se il server non supporta i validator.
- Sitemap: usare `<lastmod>` per **saltare prima del fetch** le pagine non cambiate
  ([src/profiles/docs/sitemap.mjs](src/profiles/docs/sitemap.mjs)).

**Criterio di accettazione.** Un secondo crawl ravvicinato dello stesso sito processa
solo le pagine cambiate; le immutate risultano "skipped (304/lastmod)"; output
identico per le pagine non cambiate.

**Evidenza.** Google "Crawling December: HTTP caching"; Google/Bing su `lastmod`.

**File:** `src/lib/fetcher.mjs`, `src/engine/crawl-page.mjs`, `src/lib/runs.mjs`
(persistenza validator), `src/profiles/docs/sitemap.mjs`.

---

## #7 — Dedup near-duplicate con SimHash
**Effetto:** precisione output + consumi · **Sforzo:** Medio · **Stato:** ✅ FATTO (2026-07-01 opt-in · 2026-07-02 tier mirror default-on)

> **Evoluzione 2026-07-02 — tier MIRROR/VARIANTE default-on + frontier feedback.**
> L'analisi A/B delle run vuetify (20260701-095045 vs 20260702-123253) ha mostrato che il
> 57% delle 1491 pagine della run nuova erano ri-serviture da host mirror (`next.`/`dev.`/
> `v3.`) e il 16% varianti query (`?one=settings`) — ~35 min e ~840K token input di puro
> doppione. Misurato sulle 1491 pagine reali (script SimHash su `pageSignature`):
> - coppie DUPLICATE vere (mirror/varianti): mediana hamming 4, il 72% ≤ 8;
> - coppie DISTINTE a path diversi: 36 coppie di pagine API a distanza ≤3 (due a 0 —
>   template uguale, i token distintivi sono testo-link che la signature spoglia) →
>   **una soglia globale è insicura a QUALSIASI valore utile**;
> - coppie DISTINTE a forma-sibling (release-notes `?version=A` vs `B`, stesso path su
>   prodotto diverso `0.vuetifyjs.com`): minimo 10, quasi tutte ≥ 23 → **URL-shape +
>   contenuto insieme separano perfettamente**.
>
> Da qui il design a due tier in `addPage`:
> - **`mirrorHamming` (nuovo, default 8 = ON)**: collassa SOLO quando l'URL è un *sibling*
>   di una pagina tenuta (stesso path dopo strip di un segmento locale iniziale —
>   `siblingKey()` in [src/lib/url.mjs](src/lib/url.mjs): host mirror, varianti query di
>   UI-state, gemelli di locale `/en/x`↔`/x`) **E** il SimHash è entro la soglia. La AND
>   dei due segnali è ciò che rende sicuro il default-on.
> - **`nearDupHamming` (esistente, default 0 = off)**: tier cross-path aggressivo,
>   resta opt-in per i motivi misurati sopra.
> - **Frontier feedback**: `addPage` ora ritorna kept/dropped e il loop NON accoda i link
>   di una pagina scartata come duplicato → la cascata mirror muore alla prima pagina
>   (le 846 pagine di sottodominio della run diventano ~4 render). Contatori in
>   `stats.deduped {exact, mirror, near}` + evento `dedup` per l'osservabilità.
> - Bonus igiene frontiera: `normalizeUrl` rifiuta path che INIZIANO con un altro URL
>   assoluto (`/https://…`, join rotto visto dal vivo); i path annidati più in profondità
>   (Wayback) e le query con URL restano leciti.
> Test: [test/mirror-dedup.test.mjs](test/mirror-dedup.test.mjs) (stub-site offline:
> twin+variante collassati, trap-link MAI visitati, `?v=1`/`?v=2` entrambi tenuti,
> `mirrorHamming: 0` ripristina il vecchio comportamento) + url/index-api aggiornati.
> ⏳ Da confermare dal vivo ri-lanciando la crawl vuetify (attesi ~600 pagine, ~25 min).

> **Implementato** in modo conservativo (stesso pattern del #1: default = rischio zero).
> - **Primitiva** [src/lib/simhash.mjs](src/lib/simhash.mjs): SimHash 64-bit (Charikar) puro,
>   zero dipendenze — feature = shingle di parole pesati per frequenza, hash 64-bit via due
>   murmur3-32 (niente BigInt nel loop caldo), `hamming()` con popcount SWAR, `isNearDup()`.
> - **Gate near-dup opt-in** in [index.mjs](src/index.mjs) `addPage`: nuova opzione
>   **`nearDupHamming`** (default **0 = off**, solo dedup esatto sha1 = comportamento attuale).
>   Quando > 0, una pagina il cui SimHash è entro quella distanza di Hamming da una già tenuta
>   (nella stessa scan) viene collassata. Calcolato sulla stessa signature link/URL-stripped
>   dell'sha1, così nav/URL diversi non nascondono un near-dup. Esposto in CLI
>   (`--near-dup-hamming`), tipi (`CrawlOptions.nearDupHamming`), README.
>
> _Perché opt-in e NON default:_ collassare pagine "quasi identiche" può eliminare una pagina
> il cui bit unico è piccolo (due pagine API con lo stesso template) → contro "mai perdere
> contenuto". Il default (0) non scarta **nulla** oltre ai doppioni esatti; l'aggressività è
> una scelta esplicita dell'utente. _Deliberatamente NON fatto_ (documentato): (a) near-dup a
> livello di **BlockAccumulator** — collasserebbe le **varianti reveal** (npm vs yarn), che
> sono il gioiello del crawler; l'exact-dedup normalizzato già toglie i near-dup banali;
> (b) **pre-fetch statico + skip-render** — rischia di saltare pagine con contenuto nascosto
> diverso (contro il differenziatore reveal, vedi [[firebase-perf-and-fixes]]).
>
> **Verificato** (scratchpad, 15 asserzioni): SimHash identico→0, near-dup≤6, unrelated≥12 e
> near<unrelated; hamming/popcount corretti; **default (0) tiene /a /b /c** (near-dup NON
> collassato = nessuna perdita); **opt-in (3) collassa /b in /a MA tiene /c** (contenuto unico
> mai scartato). ⏳ **Da confermare dal vivo** con A/B su un sito reference (0 perdita di
> contenuto unico) via harness #12.

**Problema oggi.** Il dedup scarta solo i doppioni **esatti** (sha1 del contenuto
normalizzato in [src/index.mjs](src/index.mjs) `addPage`) e **dopo** aver renderizzato.
Pagine quasi-identiche (stesso contenuto, template leggermente diverso) passano come
distinte → output gonfio, peggio per il chunking di refdna.

**Proposta.**
- **Parte sicura (precision-neutral):** sostituire/affiancare lo sha1 con un **SimHash
  64-bit** + distanza di Hamming **≤3** per collassare le near-dupe. Vale anche a
  livello di blocco nel `BlockAccumulator` ([src/extract.mjs](src/extract.mjs)).
- **Parte opzionale (efficienza, con cautela):** un pre-fetch statico (solo HTTP, niente
  browser) + SimHash per **saltare il render** di near-dupe ovvie. ⚠️ Rischioso per la
  completezza (potrebbe saltare una pagina il cui contenuto nascosto differisce) → di
  default OFF o molto conservativo.

**Criterio di accettazione.** Le pagine collassate sono davvero ~identiche (ispezione a
campione); nessuna pagina con contenuto unico viene scartata. Per la parte opzionale:
A/B su un sito di riferimento, confermare 0 perdita di contenuto unico.

**Evidenza.** Manku/Google "Detecting Near-Duplicates for Web Crawling"; Charikar SimHash.

**File:** `src/index.mjs` (addPage), `src/extract.mjs` (BlockAccumulator), nuovo
`src/lib/simhash.mjs`.

---

## #8 — Estrazione stile Trafilatura (pruning per densità di link)
**Effetto:** precisione · **Sforzo:** Medio · **Stato:** ✅ FATTO (2026-07-01)

> **Implementato** in [src/extract.mjs](src/extract.mjs), entrambe le proposte, senza
> neurale e senza regole per-sito:
> - **Pruning per densità di link** (`pruneNavByLinkDensity`): rimuove i container
>   (`ul/ol/nav/div/section`) che sono **quasi tutti link** (≥80% del testo è anchor-text)
>   con **pochissimo testo proprio** (≤200 char non-link) e **≥4 link** — cioè navigazione
>   in-content che la lista-classi fissa manca. Segnale universale (un rapporto, mai un nome
>   di classe). Rimuove solo il match **più esterno** (niente nodi già staccati).
> - **Cascade con fallback** (la forma più sicura): estraggo `full` (baseline, PRIMA del
>   pruning) e, se qualcosa è stato potato, `pruned`; tengo il `pruned` **solo se ha
>   preservato ≥98% del testo-parola non-link** (`contentWordLen` esclude di proposito il
>   testo dei link, così togliere nav non conta come perdita, togliere prosa/codice sì).
>   Altrimenti ricado sul `full`. → il pruning **non può mai perdere prosa/codice** (regola #1).
>
> **Verificato** (scratchpad, 27 asserzioni, no browser/modello): nav non-classata potata e
> articolo tenuto; liste-contenuto (link + descrizioni) PRESERVATE (gate densità + cascade);
> menu (testo+prezzi) intatti; prosa con link inline intatta; pagina mista (nav potata MA la
> lista-contenuto sulla stessa pagina sopravvive); nessuna regressione su articolo semplice +
> code fence. Le 126 asserzioni delle suite precedenti restano verdi (estrazione usata in
> tutto il crawl). NIENTE estrattore AI. ⏳ **Da confrontare dal vivo** su pagine doc reali
> (byte + ispezione) con l'harness #12.

**Problema oggi.** `extract.mjs` sceglie "il nodo più denso di testo"
([src/extract.mjs:98](src/extract.mjs)) e toglie una **lista fissa di classi-chrome**
([src/extract.mjs:11](src/extract.mjs)). Robusto, ma la lista fissa è un po' "per-caso"
e può lasciare boilerplate o tagliare contenuto su layout inusuali.

**Proposta.** Aggiungere segnali **universali** in stile Trafilatura, senza diventare
neurali (la ricerca dice che l'euristica è meglio del neurale qui):
- **Pruning per densità di link**: un blocco con rapporto link/testo molto alto = nav →
  scartabile (segnale universale, non un nome di classe).
- **Cascade con fallback**: prova estrazione "precisa", se il risultato è troppo
  povero ricadi su una più permissiva.

**Criterio di accettazione.** Su pagine doc di riferimento, meno chrome residuo e nessun
contenuto vero perso (confronto byte + ispezione). NON introdurre un estrattore AI.

**Evidenza.** Trafilatura (Barbaresi, F1 ~0.91); SIGIR 2023 (Bevendorff): euristica >
neurale per il contenuto principale.

**File:** `src/extract.mjs`.

---

## #9 — Rinforzo reveal: accessibility-tree / Set-of-Marks
**Effetto:** precisione (casi difficili) · **Sforzo:** Alto · **Stato:** 🟡 misura
veritiera FATTA (2026-07-05, `b08d59a`) + **Fase 1 FATTA** (2026-07-06: a11y-role + gate
label rilassato su residuo-vero alto); Fase 2 (Set-of-Marks/vision) DEFERITA (target reale
~5% e raro)

> **Fase 1 — a11y-role + gate label rilassato (FATTA, 2026-07-06, deterministica, no-AI).**
> Il gate di `perceive` (riga ~261) scarta i cliccabili interattivi **senza label e senza
> aria-controls** (un `role=tab` nudo, un div listener-only, un toggle hover-only): quasi
> sempre ridondanti → restano fuori di default, così le pagine normali restano snelle. Nuovo
> parametro `perceive(page, { relaxLabels })`: quando il chiamante ESCALA su **residuo-vero
> alto**, ammette quelli con un **segnale a11y meccanico** (ruolo ARIA/nativo interattivo,
> listener sniffato, aria-expanded/pressed/selected) come seconda fonte — il segnale
> dell'accessibility-tree letto dal DOM, **senza AX snapshot né vision**; taggati `relaxed`.
> In `revealAll`, dopo il loop stretto: se il residuo-vero (via il puro `truthfulResidual`,
> estratto) è ≥ `RESIDUAL_WARN_CHARS` **E** non ho esaurito il budget (`hitCap` ⇒ è un
> problema di `--max-actions`, non di rilevamento), un passo di **fallback bounded**
> (`RELAX_CAP` 8): ri-percepisce relaxed, triage (no-AI approva tutto), clicca ogni nuovo
> controllo `relaxed`, ricattura, ricalcola il residuo. **Additivo** (regola #1 — può solo
> aggiungere), gira SOLO su quella rara pagina ad alto residuo; il warning `reveal-residual`
> finale riflette il residuo POST-fallback. Evento `action: reveal` "a11y fallback: revealed
> N control(s)…". File: `src/engine/perceive.mjs` (param + gate + flag `relaxed`),
> `src/engine/reveal.mjs` (`truthfulResidual` esportato + fallback + warning post-fallback),
> `test/reveal-loop.test.mjs` (2 test: fallback drena il residuo su pagina alta; nessun pass
> relaxed su pagina bassa). **258 test verdi.** Limite onesto (nel codice): tratta questi
> come reveal in-place (la loro forma tipica) — un paginatore relaxed NON è percorso; è la
> Fase 2. ⏳ Verifica dal vivo pendente (il codice DOM di perceive gira solo nel browser vero;
> caso raro → node --check + trace, come per #28).

> **Scoperta 2026-07-05 (audit di una run no-AI a 504 pagine).** Il segnale che motivava
> il #9 — `reveal-residual` su **211 pagine (~42%)** ("contenuto ancora nascosto, nessun
> controllo lo rivela") — era per **~90% un FALSO POSITIVO**. L'exit audit (#21d) contava
> come "nascosto" OGNI elemento invisibile nello stato FINALE, ma un pannello mutuamente
> esclusivo (tab B quando è attivo tab C) è nascosto pur essendo stato **catturato** quando
> era aperto. Prova: il volume di contenuto era INVARIATO rispetto alle run precedenti → non
> mancava nulla, l'audit gonfiava. Quindi il vero #9 per questi dati NON era costruire
> a11y/vision per recuperare contenuto **già catturato** — era rendere la **misura onesta**.
>
> **Fatto (deterministico, no-AI, zero rischio motore):** `perceive` ritorna un campione di
> testo per blocco nascosto; `reveal` sottrae dal residuo quelli il cui testo è **già
> nell'accumulatore** (match verbatim ≥60 char; il testo oltre il cap di campionamento resta
> contato, così un buco vero non è mai mascherato — regola #1). Cambia SOLO l'audit, non il
> comportamento del reveal né il contenuto catturato. **Verificato dal vivo** (crawl no-AI 40
> pagine): residuo "no control" da **~37% → 2/40 (~5%)** delle pagine. 230 test verdi (1
> nuovo). File: `perceive.mjs` (campioni `hiddenTexts`), `reveal.mjs` (sottrazione + residuo
> veritiero), `test/reveal-loop.test.mjs`.
>
> **Cosa resta del #9 dopo la Fase 1 (la metà "difficile", opzionale = Fase 2).** La Fase 1
> copre il caso "controllo con segnale a11y/listener ma senza label". Resta il controllo
> **visivamente ovvio ma INVISIBILE ANCHE all'a11y-tree** (hover-only puro / eventi delegati
> senza ruolo, classe né `cursor:pointer`), che nemmeno il gate rilassato prende. Per quello
> servirebbe **Set-of-Marks** (screenshot con elementi numerati → Vision LLM), solo in
> modalità AI. Target minuscolo e raro (~5% delle pagine, e di quel 5% solo la frazione senza
> alcun segnale DOM) → basso ritorno, alto costo (screenshot + vision per pagina, rompe la
> simmetria no-AI): **deferito** finché un sito reale non lo richiede.

**Problema oggi.** Il rilevamento controlli è già ottimo (≈ browser-use: tag + ARIA +
sniffer listener + visibilità). Resta il raro controllo **visivamente ovvio ma
invisibile al DOM** (es. eventi delegati senza classe né `cursor:pointer`).

**Proposta (solo come RIPIEGO, non di default).** Quando il reveal trova pochissimo,
fare un passaggio extra:
- **Accessibility tree** (lo stesso albero degli screen reader) come seconda fonte di
  elementi interattivi, **oppure**
- **Set-of-Marks**: screenshot con ogni elemento interattivo numerato → Vision LLM che
  sceglie. Usato da browser-use e Project Mariner.

⚠️ Costa uno screenshot + una chiamata vision → attivarlo solo come fallback mirato, per
non appesantire ogni pagina (contro l'efficienza).

**Criterio di accettazione.** Su una pagina nota "difficile", il fallback recupera
contenuto che il path DOM non trovava; sulle pagine normali non si attiva.

**Evidenza.** browser-use interactive element detection; Set-of-Marks (Yang 2023);
Skyvern (vision).

**File:** `src/engine/perceive.mjs`, `src/engine/reveal.mjs`, `src/lib/browser.mjs`.

---

## #10 — Output per-documento identificabile + metadata (opzione)
**Effetto:** fruibilità · **Sforzo:** Medio · **Stato:** ✅ FATTO (2026-07-01)
**(Era già un item strutturale rimandato.)**

> **Implementato.** Nuova opzione **`perDocument`** (default `false`). Quando ON, oltre al
> `.md` consolidato, il crawl impacchetta **un documento per pagina**: `assemblePerDocument`
> ([src/lib/layout.mjs](src/lib/layout.mjs)) produce, per ogni pagina tenuta, un record
> `{ id, url, title, fetchedAt, bytes, markdown (VERBATIM), headings, file }` con **id
> stabile** derivato dall'URL (de-colliso), un **`index.md`** stile llms.txt e un
> **`documents.jsonl`** machine-readable. Su disco ([output.mjs](src/lib/output.mjs)
> `writeBundle`): sottocartella `documents/` con un `.md` per pagina (front-matter
> url/title/fetchedAt + corpo verbatim) + `index.md` + `documents.jsonl` a livello di scan;
> il manifest ([runs.mjs](src/lib/runs.mjs)) elenca i documenti (solo metadata + headings).
> In memoria: `result.scans[].documents` (disponibile anche senza save). Esposto in CLI
> (`--per-document`) e nei tipi (`Document`, `Scan.documents`, `CrawlOptions.perDocument`).
>
> _Filosofia rispettata:_ è **puro re-impacchettamento** — non tocca crawl né verbatim, e il
> consolidato di default è invariato (nessun campo `documents` nel manifest quando OFF).
> **Criterio d'accettazione verificato** (scratchpad, 34 asserzioni, no browser/modello): la
> UNIONE dei corpi per-documento == pagine verbatim == contenuto del consolidato (nessuna
> perdita), sia in memoria sia su disco; JSONL valido 1-record-per-riga che punta ai file;
> id stabili; default OFF invariato. _Nota:_ UI non ancora esposta (opzionale/repo-only; core
> + CLI + libreria coprono l'uso programmatico — è lì il valore).

**Problema oggi.** `assembleScan` ([src/lib/layout.mjs](src/lib/layout.mjs)) produce
**UN solo .md consolidato** per scan (Firebase = 9.5MB). Per **qualsiasi consumatore
programmatico** (uno script, una pipeline, un indice, e sì anche refdna) è scomodo:
serve **un documento per pagina** con **metadata** (URL, titolo, data) per poterli
trattare singolarmente con ID stabili.

**Proposta.** Aggiungere un formato output **per-pagina** (o JSONL) come **opzione**: un
record per pagina `{ url, title, fetchedAt, markdown, headings?/sectionPath? }`.
Mantenere il `.md` consolidato come default (comodo per l'utente umano). Il contenuto
resta **verbatim** — è solo un modo diverso di impacchettarlo. Bonus: un indice (stile
llms.txt) di cosa è stato crawlato.

**Perché è nella filosofia.** Non tocca il crawl né il verbatim: cambia solo
l'**impacchettamento** dell'output, e solo se l'utente lo chiede.

**Criterio di accettazione.** Un consumatore può caricare per-documento con URL/ID
stabili; somma dei contenuti per-pagina == contenuto del consolidato (nessuna perdita).

**Esempio d'uso (refdna):** un sistema RAG vuole esattamente questo per fare chunking
sulla struttura Markdown — è ciò che fa il concorrente **Context7** (chunk su AST
Markdown + metadata + budget token). Ma il formato per-pagina serve a **molti** usi, non
solo a refdna.

**Evidenza.** Context7; ricerca RAG (chunking markdown-aware +5-10%, gerarchico
parent/child, metadata enrichment) — come esempio di un consumatore tipico.

**File:** `src/lib/layout.mjs`, `src/lib/output.mjs`, `src/lib/runs.mjs`.

---

## #11 — Reshape (Fase 2): fedeltà verificata
**Effetto:** accuratezza · **Sforzo:** Medio · **Stato:** ✅ FATTO (2026-07-02)

> **Implementato**, progettato su un fallimento OSSERVATO DAL VIVO (chat sul run Vuetify
> 2026-07-01): fonte da 2.7MB, cap contesto 60KB → per "v-alert props" (oltre il cap) il
> modello ha FABBRICATO una tabella di props dalla sua memoria (default `'Close'` dove la
> doc vera dice `'$vuetify.close'`), servita senza alcun avviso. Tre pezzi:
> - **Causa radice — retrieval del contesto** ([src/lib/retrieve.mjs](src/lib/retrieve.mjs)):
>   quando le fonti superano il budget, `selectRelevant` seleziona le SEZIONI pertinenti
>   all'istruzione (stessa tokenizzazione task→link del crawler, zero dipendenze) invece dei
>   primi 60KB ciechi; verbatim, in ordine di documento, omissioni marcate; un documento
>   nominato per filename o byte size ("the original 2788831b") viene incluso per primo.
>   Fallback 'head' = comportamento storico quando nulla discrimina. Prompt rinforzato:
>   "mai rispondere dalla tua conoscenza; se non è nelle fonti, dillo".
> - **La verifica** ([src/lib/faithful.mjs](src/lib/faithful.mjs)): `verifyValues` estrae
>   gli atomi valore-simili di ogni file prodotto (numeri/URL/inline-code/stringhe quotate/
>   righe di codice — la prosa può essere riformulata, i VALORI no) e li cerca nelle fonti
>   COMPLETE (non nel contesto del modello) + nell'istruzione dell'utente (un valore digitato
>   dall'utente non è un'invenzione). I non-trovati: banner di avviso DENTRO il file (block-
>   quote firmato crawldna, strippabile meccanicamente), `fidelity` per-file nel risultato/
>   session.json, warning in CLI. Matching normalizzato e generoso (substring, numeri
>   separator-insensitive): cattura affidabilmente il caso pericoloso (valori che non
>   esistono da nessuna parte), non fa la polizia alla prosa. Default ON, `--no-verify` /
>   `verify:false` per disattivare.
> - **Contorno, sempre dall'esperienza**: filtro anti-riemissione (un file quasi identico
>   — SimHash Hamming ≤3 — a uno già prodotto in chat viene saltato CON nota, erano 3 copie
>   di "pagination" in un solo run) e timeout reshape 300s (il "redo the original" moriva a
>   120s, che restano per le chiamate di giudizio del crawl).
>
> **Verificato** (suite permanente, 17 test nuovi, 83 totali): unit su retrieve/faithful +
> **integrazione end-to-end** ([test/reshape.test.mjs](test/reshape.test.mjs)) che riproduce
> in miniatura il caso Vuetify contro uno stub OpenAI-compatibile: la sezione giusta
> raggiunge il modello (non il filler), `'elevated'` inventato → flaggato nel file salvato,
> `'$vuetify.close'` reale → passa, ri-emissione → saltata con nota. ⏳ _Da provare dal vivo_
> sul run Vuetify esistente (`crawldna reshape 20260701-095045-c57db0 --ask "dammi i props
> del v-alert"`). _Limite onesto:_ un valore che ESISTE nelle fonti ma è attribuito alla
> cosa sbagliata passa (serve il giudizio semantico, non deterministico); la rete cattura
> l'invenzione, non la mis-attribuzione.

**Problema oggi.** Il reshape ([src/reshape.mjs](src/reshape.mjs), `aiReshape` in
[src/engine/decide.mjs](src/engine/decide.mjs)) è l'**unico** punto dove l'AI può
riformattare/filtrare — e quindi l'unico dove potrebbe *alterare un valore*. Il prompt
impone già "value-faithful", ma non c'è una **verifica**.

**Proposta.** Aggiungere un controllo opzionale di **faithfulness**: ogni valore
(numero/prezzo/URL/stringa) nell'output del reshape deve esistere nelle fonti; se
qualcosa non torna, segnalarlo invece di servirlo silenziosamente. È la metrica
anti-allucinazione di RAGAS applicata a casa nostra.

**Perché è nella filosofia.** Rafforza il principio "Fase 2 è l'unico posto non-verbatim,
ma resta fedele ai valori".

**Criterio di accettazione.** Su un set di richieste reshape, 0 valori inventati non
rilevati; le alterazioni vengono evidenziate.

**Evidenza.** RAGAS *faithfulness* (decompone la risposta in claim e li verifica sul
contesto).

**File:** `src/reshape.mjs`, `src/engine/decide.mjs`.

---

## #12 — Harness di misurazione (completezza / rispetto-task / token)
**Effetto:** trasversale — **abilita di valutare tutti gli altri** · **Sforzo:** Medio · **Stato:** ✅ FATTO (2026-07-01)

> **Implementato.** Tre pezzi, tutti verificati offline (47 asserzioni node, senza
> modello né browser — `fetch` stubbato):
> - **(c) Token per TIPO di chiamata.** `chat(llm, system, user, schema?, kind?)`
>   ([src/lib/llm.mjs](src/lib/llm.mjs)) ora passa un `kind` al sink `__onUsage`; le 5
>   chiamate di giudizio in [decide.mjs](src/engine/decide.mjs) lo etichettano
>   (`reveal`/`scope`/`links`/`nav-plan`/`reshape`) e l'health-ping è `health`.
>   [src/index.mjs](src/index.mjs) accumula un `tokens.byKind` accanto ai totali; la
>   persistenza ([runs.mjs](src/lib/runs.mjs) `aggregateTokens`) fonde il `byKind` tra
>   scan. Così si vede **dove** vanno i token, non solo il totale. `index.d.ts`
>   aggiornato (`TokenUsage.byKind` + `tokens` su `Stats`).
> - **(a)+(b) Metriche pure** in [src/eval/metrics.mjs](src/eval/metrics.mjs)
>   (dependency-free, deterministiche): `revealCoverage` (contenuto nascosto noto
>   presente?), `sitemapCoverage` (+ `diffRuns` tra run), `taskRespect` (recall/precision
>   stile SWDE), `tokenBreakdown`. Assemblate in [src/eval/report.mjs](src/eval/report.mjs)
>   (`evaluate` + `formatReport`).
> - **Runner** [scripts/eval.mjs](scripts/eval.mjs) (`npm run eval`): crawla una GOLDEN
>   SPEC, recupera la sitemap (inline o live via `collectSitemapUrls`), stampa il report.
>   Spec di esempio (una doc + una non-doc, come richiesto) in `eval/golden/` +
>   [eval/README.md](eval/README.md) che documenta lo schema.
>
> _Confini onesti tenuti nel codice:_ la completezza assoluta NON è dimostrabile → si
> misurano PROXY (reveal-noto + copertura sitemap); il rispetto-task si valuta contro un
> golden set che l'utente fornisce (le spec di esempio sono TEMPLATE da verificare sul
> sito reale). Il core puro (`src/eval/`) viaggia con l'npm; runner + golden restano
> repo-only. ⏳ **Da usare dal vivo:** riempire una golden spec con valori verificati e
> girare `npm run eval -- --model qwen3-coder:30b` prima/dopo un item per avere il numero.

**Problema oggi.** Non c'è modo di **misurare** completezza/rispetto-task/consumi: ogni
stima (anche le mie) è solo una stima. Senza numeri, non si sa se un item ha migliorato
o peggiorato.

**Proposta.** Misure semplici e universali, su un piccolo set di siti di prova che
includa **task diverse** (una doc + una non-doc tipo "il menù"/"i prezzi"/"un calendario"):
- **(a) Completezza.** (i) Reveal: il contenuto nascosto noto (tab/accordion) compare
  nell'output? (ii) Pagine: copertura sitemap (di N URL, quante tenute?) + diff tra run.
  (La completezza assoluta non è dimostrabile; questi sono i proxy standard.)
- **(b) Rispetto della task = precisione "stile SWDE".** Su un sito noto, l'output
  contiene **tutto-e-solo** ciò che la task chiedeva? Si segna su un golden set
  (presenza degli attributi/sezioni attesi = recall; assenza di roba inutile =
  precision). SWDE è il benchmark standard per l'estrazione su siti diversi.
- **(c) Token per TIPO di chiamata** (reveal / scope / links / nav-plan), non solo il
  totale → si vede *dove* vanno davvero i token.

**Perché serve.** Trasforma "fidati di me" in "guarda il numero prima/dopo". È la
risposta giusta alla tua domanda "ma risolverà davvero le mie perplessità?": si verifica,
non si promette.

**Criterio di accettazione.** Ogni item del TODO ha un numero misurabile prima/dopo.

**Evidenza.** SWDE (F1 attributo-livello su 80 siti/8 categorie — metro per un crawler
generale); misurazione coverage (sitemap-coverage / golden set; la coverage assoluta non
è ricavabile da un singolo crawl). _Per il caso refdna_, in più, metriche RAG-side
(RAGAS faithfulness/context-recall) — ma sono del consumatore, non del crawler.

**File:** nuovo `src/eval/` o script; il metering token per-tipo tocca
`src/lib/llm.mjs` + `src/index.mjs`.

---

## Revisione ingegneristica completa — 2026-07-02

> Lettura integrale del codice (engine, layer AI, transport LLM, estrazione,
> persistenza, CLI, server UI, tipi, test) fatta con Claude (Fable). Due esiti:
> **(a) 9+ correzioni applicate subito** (verbale sotto — sono nel working tree di
> quella sessione; una sessione futura le trova nel git history una volta committate)
> e **(b) gli item #13–#18** qui sotto, i miglioramenti strutturali NON fatti quel
> giorno, da chiudere nelle prossime sessioni.

### Correzioni applicate (verbale, 2026-07-02) — 97/97 test verdi

1. **Click sull'elemento sbagliato** ([src/engine/perceive.mjs](src/engine/perceive.mjs)):
   gli id `data-crawldna-id` ripartivano da 0 a ogni passata SENZA pulire quelli
   vecchi → il locator `.first()` poteva cliccare un elemento stale e corrompere la
   camminata del reveal. Ora ogni perceive rimuove i marker prima di ristampare.
2. **Estrazione che perdeva contenuto vero** ([src/extract.mjs](src/extract.mjs)):
   `CHROME_SELECTORS` rimuoveva `.menu` (il menù di una pizzeria!), `.banner`/
   `.announcement` (annunci reali), `form` (calendari di prenotazione, menù
   ordinabili) e ogni `header` anche dentro `<article>`. Tolti dalla lista (il
   pruning per densità di link #8 copre la nav che quelle classi cacciavano);
   `header` ora è article-aware. +2 test di regressione.
3. **Retry LLM su errori transitori** ([src/lib/llm.mjs](src/lib/llm.mjs)): un 429/5xx
   faceva fallire la chiamata di giudizio → fallback "segui/tieni tutto" → esplosione
   fuori tema. Ora ≤2 retry con backoff, rispetta `Retry-After`, ritenta i reset di
   rete, NON ritenta i timeout, convive col degrade di `response_format`. +5 test.
4. **Pagine perse in silenzio su timeout di navigazione**
   ([src/engine/crawl-page.mjs](src/engine/crawl-page.mjs) +
   [src/index.mjs](src/index.mjs)): il fallimento ora è marcato (`failed`) e la
   frontiera riprova l'URL una volta (warn `retry`), poi errore esplicito.
5. **Pagine 404/500 tenute come contenuto**: con status ≥400 e testo povero
   (`contentWordLen < 200`) la pagina è scartata; i link si raccolgono comunque.
   La soglia protegge l'SPA mal configurata che risponde 404 ma renderizza davvero.
6. **Candidati reveal mai giudicati** ([src/engine/reveal.mjs](src/engine/reveal.mjs)):
   il triage giudicava solo i primi 100 indecisi per passata → ora batcha fino a
   esaurirli (rule #1).
7. **`class="table"` inondava i candidati** (perceive): la regex `/tab/` matchava
   "table" e con il cap a 150 poteva spingere fuori i tab veri → `tab(?!le)`.
8. **Consent-dismiss che cliccava bottoni di contenuto** (perceive): "Continue"/"OK"/
   "Close" venivano cliccati ovunque PRIMA della baseline (anche step di wizard/
   calendari). Ora il candidato deve stare in un vero overlay (fixed/sticky,
   `role=dialog`, `aria-modal`) — il segnale universale dei cookie banner.
9. **Race sul browser condiviso** ([src/lib/browser.mjs](src/lib/browser.mjs)): il
   `finally` di un run chiudeva Chromium sotto le pagine di un run appena avviato
   (stop+restart dalla UI). Ora retain/release con refcount.
10. **Igiene**: UI legata a 127.0.0.1 (prima: chiunque in LAN poteva avviare crawl e
    cancellare run), probe `ollama --version` cachato (era un `execSync` bloccante a
    ogni richiesta), eliminati i moduli morti `profiles/docs/framework/*` (pubblicati
    su npm senza mai essere importati), `--version` in CLI, progress in-place su TTY,
    `author`/`keywords` in package.json.

### Riscontri minori NON corretti (da tenere d'occhio)

- `candidateObjs` in crawl-page fa un `find` O(n²) su link×candidati — irrilevante
  fino a ~400 link, da rifare con una Map se mai pesasse.
- `normalizeUrl` strappa `hl`/`lang`/`locale` dalle query: giusto per dedup delle
  traduzioni, ma su un sito dove `?lang=` seleziona contenuti DIVERSI una lingua
  sola viene tenuta. Caso raro, decisione consapevole — documentata qui.
- La sessione reshape (`session.json`) non è protetta da turni concorrenti (utente
  singolo oggi: ok).
- `handleModels` passa l'apiKey come query param (solo loopback dopo il fix: ok).

---

## #13 — Persistenza incrementale + resume del crawl
**Effetto:** affidabilità (un crash non perde più nulla) · **Sforzo:** Medio-Alto · **Stato:** ✅ FATTO (2026-07-02)

> **Implementato**, tutti e cinque i punti della proposta:
> - **Run folder subito** ([runs.mjs](src/lib/runs.mjs) `initRun`): con save on, `run.json`
>   nasce all'avvio con `status:'running'` + targets + opzioni (così un run ucciso resta
>   listato E resumabile). Igiene contestuale in `sanitizeOptions`: `apiKey`/`llm`/`__*`
>   non finiscono MAI più su disco (né in run.json né nel manifest).
> - **Journal append-only** (`appendJournal`/`readJournal`): in `ctx.addPage` ogni pagina
>   tenuta è appesa a `<scanId>/pages.jsonl` NEL MOMENTO in cui è catturata — record
>   `{ page, links }` verbatim, con i link scoperti dalla pagina (servono al resume per
>   ri-seminare la frontiera: senza, le pagine raggiungibili solo attraverso una pagina
>   già tenuta non si ritroverebbero mai). Append serializzati con una promise-chain
>   (i worker concorrenti non possono intrecciare le righe) e flushati prima del save
>   finale; in lettura una riga strappata da un crash a metà scrittura viene saltata
>   (quella pagina si ri-crawla, mai persa). Errore di journaling = warn, il crawl
>   continua in memoria.
> - **Fine run**: `saveRun` riusa id/createdAt del folder e scrive `status:'done'`
>   (frontiera esaurita — journal eliminato, il contenuto vive nei file consolidati) o
>   `'stopped'` (Stop volontario — journal CONSERVATO, run resumabile). Il consolidato
>   è assemblato dalla RAM come oggi (deliberato: se il disco avesse perso un append,
>   leggere da disco perderebbe pagine che la RAM ha — regola #1; il journal è la rete
>   anti-crash, non la fonte di verità di un run sano).
> - **`resumeCrawl(runId)`** ([index.mjs](src/index.mjs)) = CLI `crawldna resume <runId>`
>   + UI `POST /resume`: rilegge run.json/manifest (opzioni+targets salvati, override da
>   flag), rigioca il journal — pagine ripristinate verbatim nel risultato (mai
>   ri-renderizzate), hash dedup ricostruiti con la STESSA `pageSignature` condivisa con
>   addPage, URL pre-visitati, link registrati → semi della frontiera — e completa nello
>   STESSO folder. Evento `resume` (`restored: N`) per CLI/UI; `crawldna runs` marca i
>   run interrotti/fermati come resumabili. Un run `done` non si resuma (errore chiaro).
> - **Contratto libreria invariato**: senza `save`/`cacheDir` zero scritture (testato).
>
> **Criterio di accettazione verificato** ([test/resume.test.mjs](test/resume.test.mjs),
> 7 test, 104 totali, offline con sito stub locale + browser 'never'): run interrotto a
> metà → journal su disco leggibile (pagina verbatim + link); `resume` completa e
> l'output è **identico** (stesso set pagine, stesso markdown) a un run mai interrotto;
> variante crash (status 'running', manifest assente, riga journal strappata) idem;
> zero scritture con save off. _Limiti onesti:_ token/durationMs del tratto pre-crash
> non si recuperano (contavano in RAM); nessun lockfile → resumare un run mentre gira
> ancora altrove non è rilevato; le pagine visitate-ma-non-tenute si ri-visitano al
> resume (corretto ma un po' di lavoro rifatto — il journal registra solo ciò che è
> tenuto, come da proposta).

**Problema oggi.** `saveRun` ([src/lib/runs.mjs](src/lib/runs.mjs)) scrive TUTTO solo a
fine run e le pagine vivono in RAM fino ad allora: un crash (o kill, o blackout) alla
4ª ora di un crawl da 5 perde **tutto l'output**. Non esiste alcun modo di riprendere
un run interrotto; anche uno Stop volontario ri-parte sempre da zero.

**Proposta.**
- All'avvio (quando il salvataggio è on) creare subito la cartella del run con un
  `run.json` in stato `running`.
- In `ctx.addPage` appendere OGNI pagina tenuta su disco man mano (un JSONL per scan,
  o direttamente il formato per-documento #10) — verbatim, append-only.
- A fine run assemblare il consolidato COME OGGI ma leggendo da disco, e marcare
  `run.json` → `done`.
- `crawldna resume <runId>`: ricostruisce `visited` + dedup-hashes dalle pagine già
  salvate, ri-semina la frontiera (sitemap/entry) e completa il run.
- Il contratto libreria NON cambia: senza `save`/`cacheDir` tutto resta in memoria.

**Criterio di accettazione.** `kill -9` a metà di un crawl di riferimento → le pagine
già estratte sono su disco e leggibili; `resume` completa e l'output finale è
identico (stesso set di pagine) a un run mai interrotto. Zero scritture quando il
salvataggio è off.

**File:** `src/lib/runs.mjs`, `src/lib/output.mjs`, `src/index.mjs` (addPage/finally),
`bin/cli.mjs`, `ui/server.mjs` (esporre resume).

---

## #14 — Politeness opt-in (delay/robots) + rilevamento anti-bot/challenge
**Effetto:** affidabilità / reputazione · **Sforzo:** Basso-Medio · **Stato:** ✅ FATTO (2026-07-03)

> **Implementato**, entrambe le facce:
> - **Politeness, opt-in** (default off = comportamento byte-identico a oggi; il tool
>   resta user-directed come wget). Nuovo [src/lib/robots.mjs](src/lib/robots.mjs):
>   `createHostGate` (pacer per-host a slot riservati — N worker concorrenti sullo
>   STESSO host si mettono in coda a distanza ≥ delay, host diversi mai in attesa) +
>   `parseRobots`/`isAllowed` puri (selezione gruppo UA più specifico, longest-match
>   alla Google, Allow batte Disallow a parità, wildcard `*` e ancora `$`,
>   Crawl-delay). Frontiera ([index.mjs](src/index.mjs)): opzioni piane **`delay`**
>   (ms, 0=off) e **`respectRobots`** (bool); robots.txt fetchato UNA volta per origin
>   e cachato per run; URL disallowed → **warning `robots` con l'URL, mai in silenzio**
>   (il warning è il contratto); Crawl-delay combinato col delay utente (vince il
>   maggiore); l'attesa polite rispetta lo Stop. CLI `--delay`/`--respect-robots`,
>   UI in Advanced (numero + checkbox, non inviati se a default), tipi e README.
> - **Rilevamento challenge, SEMPRE attivo** (guardia di precisione). Nuovo
>   [src/lib/challenge.mjs](src/lib/challenge.mjs): `detectChallenge` legge
>   l'ARTEFATTO della difesa, non il sito — header vendor (`cf-mitigated: challenge`),
>   widget/iframe dei ~6 vendor (Cloudflare/turnstile, hCaptcha, reCAPTCHA, DataDome,
>   PerimeterX, AWS WAF) su pagina povera, frasi interstitial ("checking your
>   browser", "unusual traffic") SOLO con corroborazione meccanica (status 403/429/503
>   o meta-refresh) e pagina povera (<800 char di testo vero). Una pagina che PARLA di
>   captcha (doc con l'URL del widget in un code sample) non scatta: ha massa di testo.
>   Integrata in ENTRAMBI i path di [crawl-page.mjs](src/engine/crawl-page.mjs)
>   (engine post-settle pre-reveal, e static fallback): **mai tenuta come contenuto**,
>   warning `anti-bot` col segnale, UN retry con backoff (`challengeBackoffMs` onora
>   Retry-After, cap 15s), poi **skip dichiarato** (secondo warning) — link non
>   raccolti dalla pagina-sfida. **Mai aggirata** (ARCHITECTURE §14: si segnala, non
>   si buca). `fetchText`/`loadHtml` ([fetcher.mjs](src/lib/fetcher.mjs)) ora espongono
>   gli header di risposta (chiavi lowercase).
>
> **Verificato** ([test/politeness.test.mjs](test/politeness.test.mjs), 10 test, 176
> totali, offline con sito stub): parseRobots (gruppo specifico batte `*`, UA
> consecutivi, commenti), isAllowed (longest-match, tie→allow, wildcard/$, Disallow
> vuoto), hostGate (spaziatura same-host, cross-host immediato); detectChallenge
> (interstitial 200, turnstile+403, frase+429, header vendor da solo; NEGATIVI: doc
> sul captcha con testo vero, 404 povero senza marker, frase su pagina ricca);
> Retry-After onorato/bounded; e2e: robots on → /docs/b warning-non-pagina e off →
> tenuto (default invariato), delay 150ms con concurrency 2 → richieste same-host
> distanziate (misurate dal log del server), challenge HTTP-200 → warning ×2 (detect
> + skip), esattamente 1 retry, MAI nell'output, resto del sito intatto. Fix di
> contorno: shadowing TDZ del parametro `headers` in fetchText (trovato dai test).
> ⏳ **Dal vivo:** un sito reale dietro Cloudflare per confermare il segnale
> `cf-mitigated`/interstitial nel browser vero; un crawl con `--delay` su un sito
> piccolo per il galateo. _Nota:_ le fetch fuori-frontiera (robots.txt, llms-full,
> sitemap: 1-2 per origin) non sono paced — irrilevanti per il rate.

**Problema oggi.** Due facce dello stesso rischio "il sito ci scambia per attività
sospetta". (1) Nessun rate-limit per host e nessuna lettura di robots.txt: concurrency
4 × reveal martella qualsiasi sito → ban/429 (= contenuto perso, contro la regola #1) e
cattiva reputazione per un tool pubblicato su npm. (2) Quando la difesa scatta comunque,
il sito serve una **pagina-sfida** (Cloudflare "checking your browser", CAPTCHA,
"unusual traffic", interstitial JS) — spesso con **status 200**: il filtro attuale
(status ≥400 + testo povero) non la becca, e finirebbe nell'output **come se fosse
contenuto**, silenziosamente.

**Proposta.**
- *Politeness, opt-in* (il tool resta user-directed come wget):
  - `--delay <ms>`: distanza minima tra richieste allo STESSO host (frontiera e fetch).
  - `--respect-robots`: legge `Disallow`/`Crawl-delay` e salta gli URL vietati **con
    warning** (mai in silenzio — il warning è il contratto).
- *Rilevamento challenge, sempre attivo* (è una guardia di PRECISIONE, non una
  cortesia): riconoscere la pagina-sfida da segnali universali del **challenge**, non
  del sito (stesso argomento del lessico consent in #21a: si legge l'artefatto della
  difesa, che è uguale ovunque) — pagina quasi-vuota + widget/iframe captcha noti,
  marker degli interstitial (meta-refresh + testo "checking/verify", vendor header tipo
  `cf-mitigated`), 403/429 con corpo-sfida. Comportamento: **mai tenerla come
  contenuto**, warning esplicito `anti-bot` con l'URL, un solo retry con backoff
  (rispettando `Retry-After` sui 429, come già fa il transport LLM), poi skip
  dichiarato. **Mai aggirare** (CAPTCHA/challenge restano fuori scope per sempre,
  ARCHITECTURE §14 — si segnala, non si buca).

**Criterio di accettazione.** Con delay attivo le richieste same-host distano ≥ delay
(misurabile dai log); con robots on gli URL disallowed compaiono come warning e non
come pagine; con entrambe off il comportamento è identico a oggi. Per il rilevamento:
fixture offline di pagine-sfida (200 e 403/429) → nessuna finisce nell'output, ognuna
produce il warning `anti-bot`; le pagine vere con la parola "captcha" nel TESTO (es.
una doc che ne parla) NON scattano (serve il widget/marker, non la parola).

**File:** `src/index.mjs` (frontiera), `src/lib/fetcher.mjs`, `src/engine/crawl-page.mjs`
(gate contenuto), nuovo `src/lib/robots.mjs`, test con fixture challenge.

---

## #15 — Render-wait: response-quiet al posto di `networkidle`
**Effetto:** tempo (−secondi FISSI per pagina sui siti con analytics) · **Sforzo:** Basso-Medio · **Stato:** ✅ FATTO (2026-07-02, ⏳ numeri dal vivo con #12)

> **Implementato.** `settle()` estratto in [src/lib/settle.mjs](src/lib/settle.mjs)
> (helper condiviso, puro JS sull'interfaccia page — testabile senza Playwright) e
> usato in TUTTI e tre i punti dove `networkidle` tassava le pagine, non solo nel
> render iniziale:
> - **Render iniziale** ([crawl-page.mjs](src/engine/crawl-page.mjs)): prima il
>   paint-check SPA (com'era), poi `settle(maxMs 8000)` al posto di
>   `networkidle(8s) + 400ms flat`. Stesso tetto di prima → il caso peggiore non
>   regredisce MAI; l'uscita quiet+testo-stabile di settle assorbe anche il 400ms
>   fisso. Il punto chiave: settle conta gli EVENTI response, non le connessioni
>   aperte — un sito con websocket/SSE/long-poll aperto (dove l'idle non arriva
>   MAI e si pagavano gli 8s pieni a pagina) esce dopo una grace window (~0.8s).
> - **`restoreBase`** ([reveal.mjs](src/engine/reveal.mjs)): il reload post-navigazione
>   pagava `networkidle(5s) + 300ms` a ogni ripristino → `settle(maxMs 5000)`.
> - **`loadHtml`** ([fetcher.mjs](src/lib/fetcher.mjs)) — il caso peggiore trovato
>   leggendo il codice: `goto(waitUntil:'networkidle', timeout:45000)` sulla via
>   di escalation browser bruciava fino a **45 secondi** su un sito con socket
>   aperto → `goto('domcontentloaded') + settle(maxMs 8000)`.
>
> _Perché non perde contenuto (regola #1):_ ogni garanzia del wait vecchio è
> conservata o rafforzata — contenuto dipinto (paint-check invariato), rete quieta
> (grace 650ms sugli eventi ≈ i 500ms di idle, ma immune ai socket), stabilità del
> testo DOPO il paint (più forte del 400ms cieco), e il tetto massimo identico.
> Su una pagina patologica con traffico continuo sotto-grace, settle arriva al cap
> = comportamento odierno. È lo STESSO segnale già validato dal vivo sul post-click
> (calendario ACI: cascata lazy da 1s catturata correttamente).
>
> **Verificato** ([test/settle.test.mjs](test/settle.test.mjs), 5 test, 109 totali):
> pagina quieta/socket-aperto esce alla grace (non al cap); heartbeat sotto-grace
> bounded dal cap (mai appeso); cascata di load attesa fino in fondo ma ben sotto
> il cap; testo che cresce ritarda l'uscita finché non si stabilizza; evaluate che
> muore (navigazione sotto i piedi) esce pulito e stacca il listener.
> ⏳ **Dal vivo:** misurare il tempo medio/pagina prima/dopo su un sito con
> analytics (harness #12) e confermare Markdown identico sulle pagine di riferimento.

**Problema oggi.** `crawlPageWithEngine` aspetta `networkidle` con timeout 8s
([src/engine/crawl-page.mjs](src/engine/crawl-page.mjs)): sui siti con
analytics/websocket/heartbeat l'idle non arriva MAI, quindi sono 8 secondi di tassa
fissa a pagina — ore su un crawl grande (è uno dei motivi delle 5h su Firebase, vedi
[[firebase-perf-and-fixes]]).

**Proposta.** Sostituire quel wait col segnale **response-quiet già validato** in
`settle()` ([src/engine/actions.mjs](src/engine/actions.mjs)): risposta vista + grace
window + testo stabile, bounded. Estrarre `settle` in un helper condiviso e usarlo sia
al render iniziale sia dopo i click (oggi è solo post-click).

**Criterio di accettazione.** Su un sito con analytics il tempo medio/pagina cala di
secondi; su pagine di riferimento il Markdown estratto resta byte-identico (harness #12
+ diff).

**File:** `src/engine/crawl-page.mjs`, `src/engine/actions.mjs` (estrazione helper).

---

## #16 — Budget/ranking per le route minate dai JS
**Effetto:** consumi (token del gate `links`) · **Sforzo:** Basso · **Stato:** ✅ FATTO (2026-07-02, ⏳ byKind.links dal vivo con #12)

> **Implementato** col pattern del #1 (l'AI resta il giudice, il ranking aiuta).
> Nuova `budgetRoutes(routes, terms, maxRoutes)` pura in
> [crawl-page.mjs](src/engine/crawl-page.mjs): le route minate dai blob JS —
> l'UNICA sorgente speculativa — vengono rankate con `scoreLink` (già esistente,
> universale, task-driven) e solo le prime `maxRoutes` (default **200**, `0` =
> illimitato, CLI `--max-routes`) raggiungono il gate AI. I link DOM/nav/popup
> NON sono mai cappati; una route già presente come link reale non consuma budget.
> Evento `action: route-budget` quando il taglio avviene (visibile in Activity/CLI).
>
> _Guardia conservativa (regola #1), più precisa della proposta:_ il taglio scatta
> SOLO quando i punteggi **discriminano davvero** tra le route (min < max). Serve
> perché `scoreLink` dà **1 a tutto** con task generica (non 0): task generica →
> tutti 1 → nessuna varianza → nessun taglio; task fuori-vocabolario → tutti 0 →
> idem; caso reale (route doc > 0, `/static/chunk-…` = 0) → varianza → il taglio
> assorbe il rumore e le route on-task sopravvivono TUTTE. Pareggi in ordine di
> mining (deterministico). Una route tagliata resta comunque raggiungibile via
> link DOM/sitemap dalle pagine successive.
>
> **Verificato** ([test/route-budget.test.mjs](test/route-budget.test.mjs), 5 test,
> 114 totali): sotto-budget intatto; sopra-budget con task discriminante le route
> on-task sopravvivono tutte e il rumore assorbe il taglio (pareggi in ordine
> stabile); task generica → zero tagli; task fuori-vocabolario → zero tagli;
> budget 0 = illimitato. ⏳ **Dal vivo:** confermare il calo di `byKind.links` su
> una SPA di riferimento con set di pagine tenute identico (harness #12).

**Problema oggi.** `perceive` mina fino a **800 path** dai blob JS/JSON della pagina
([src/engine/perceive.mjs](src/engine/perceive.mjs)); sono tutti same-site, quindi
passano lo scope e finiscono TUTTI al gate AI in batch da 160 — token bruciati su
`/static/chunk-...`, path di build e simili, e qualche 404 inseguito.

**Proposta.** Stesso pattern del #1 (l'AI resta il giudice, il ranking aiuta):
- rankare le route con `scoreLink` (già esiste) e mandarne al gate solo le prime N
  (cap configurabile, es. 200 best) — le altre restano scartabili SOLO da segnali
  universali non-pagina (estensioni asset, già filtrate in parte);
- niente regole per-sito, niente pattern URL nuovi.

**Criterio di accettazione.** Su una SPA di riferimento i token `byKind.links` calano
sensibilmente; il set di pagine tenute resta identico (harness #12).

**File:** `src/engine/perceive.mjs`, `src/engine/crawl-page.mjs`.

---

## #17 — CI GitHub Actions (suite offline a ogni push)
**Effetto:** qualità continua · **Sforzo:** Basso · **Stato:** ✅ FATTO (2026-07-02)

> **Implementato.** Nuovo [.github/workflows/test.yml](.github/workflows/test.yml):
> trigger su push a `main` + ogni PR (niente doppioni push/PR sulla stessa branch),
> matrice **Node 20 + 22** (`fail-fast: false` — un fallimento su una versione non
> nasconde l'esito dell'altra), `npm ci && npm test` con cache npm,
> `permissions: contents: read` (least privilege) e `concurrency` che cancella i run
> superati dello stesso ref. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` come cintura di
> sicurezza: la suite è offline by design (verificato: nessun test importa playwright;
> 97/97 verdi in ~1.7s) e Chromium non va MAI scaricato in CI. Badge aggiunto in cima
> al README. Lockfile verificato in sync con package.json (`npm ci` non fallirà).
> ⚠️ **Slug provvisorio:** il repo non ha ancora un remote GitHub → badge e URL usano
> `BogdanVasaiu/crawldna`; quando si configura il remote (vedi #18, repository/
> homepage in package.json) va allineato se lo slug reale è diverso. Il workflow in
> sé è slug-agnostico (si attiva da solo al primo push).

**Problema oggi.** La suite (97 test, zero rete/browser/modello) gira solo a mano: una
regressione può entrare inosservata.

**Proposta.** `.github/workflows/test.yml`: trigger su push/PR, matrice Node 20 + 22,
`npm ci && npm test`. Niente browser né modello (la suite è offline by design, resta
veloce e gratuita).

**Criterio di accettazione.** Badge verde nel README; un test rotto fa fallire il
check del PR.

**File:** nuovo `.github/workflows/test.yml`, badge nel README.

---

## #18 — Packaging npm (playwright peer-optional + metadata)
**Effetto:** fruibilità come libreria · **Sforzo:** Basso · **Stato:** ✅ FATTO (2026-07-06)

> **Implementato (scelta di prodotto b — deps out-of-the-box).** I metadata erano già a
> posto (il remote GitHub è ora configurato): `repository`/`homepage`/`bugs`/`keywords`
> presenti in [package.json](package.json). Decisione presa sulla dipendenza Playwright:
> **resta `optionalDependency`** (non spostata a peer) così il reveal engine — il
> differenziatore — funziona out-of-the-box su CLI/UI/global install, coerente con "il
> reveal è il differenziatore, non andare static-first" ([[firebase-perf-and-fixes]]). Il
> consumer statico attento al peso ha comunque l'escape-hatch **`npm install crawldna
> --omit=optional`**, ora documentato nel README (sezione Requirements), con la nota che i
> crawl che servono il browser stampano l'hint per installarlo. Fix packaging: rimosso il
> `./` iniziale dal path del bin (`./bin/cli.mjs` → `bin/cli.mjs`) che faceva emettere a
> `npm publish` il warning "bin script name was cleaned / npm pkg fix". La Web UI (`ui/`)
> è deliberatamente FUORI dal tarball (`files` allowlist) e `crawldna serve` lo rileva e
> spiega come ottenerla invece di crashare ([bin/cli.mjs:552](bin/cli.mjs)).
>
> **Verificato.** `npm publish --dry-run` **pulito** (nessun warning `npm pkg fix`; 37
> file, ~182 kB; `ui/`/`test/`/`scripts/`/`eval/` esclusi, solo `src`/`bin`/`index.d.ts`/
> `README`/`LICENSE`). 256/256 test verdi.
>
> _Deliberatamente NON fatto:_ passaggio a `peerDependencies` (opzione a) — degraderebbe
> l'esperienza CLI/global (un secondo `npm install playwright` per il motore reveal); non
> vale la pena finché il pacchetto non è pubblicato e non emerge un consumer-libreria
> puramente statico che lo chieda.

**Problema (storico).** `playwright` è in `optionalDependencies`: npm lo SCARICA comunque
(~50MB) a ogni `npm install crawldna`, anche per un consumer che usa solo la via
statica/llms-full.

**Decisione di prodotto (presa: b).**
- (a) passare a `peerDependencies` + `peerDependenciesMeta: { playwright: { optional:
  true } }` → install leggero, il README già spiega `npx playwright install chromium`;
- (b) ✅ **scelta** — restare `optionalDependency` per l'esperienza out-of-the-box;
  chi vuole il pacchetto leggero usa `npm install --omit=optional` (documentato).

**Criterio di accettazione.** ✅ `npm publish --dry-run` pulito; il consumer statico può
installare senza Playwright via `--omit=optional`.

**File:** `package.json`, README (sezione Requirements).

---

## #19 — Modalità no-AI (crawl a zero chiamate modello)
**Effetto:** fruibilità + costi · **Sforzo:** Basso · **Stato:** ✅ FATTO (2026-07-02, da committare)

> **Implementato.** Opzione `noAi: true` in `DEFAULT_OPTIONS` → `resolveLlm` produce il
> descrittore provider `'none'` ([src/lib/llm.mjs](src/lib/llm.mjs), predicato
> `llmDisabled()` + guardia difensiva in `chat()`). Le 4 chiamate di giudizio Fase-1 in
> [decide.mjs](src/engine/decide.mjs) corto-circuitano PRIMA del transport sui fallback
> completeness-bias già esistenti: reveal → euristica DOM per-candidato, nav-plan →
> esplorazione open-ended, scope → pagina intera, links → segue tutto l'in-scope.
> Health-check saltato, al suo posto un warn `no-ai` una-tantum che spiega il trade-off.
> CLI `--no-ai` (vale anche per `resume`), UI checkbox "Crawl without AI" (dimma il
> setup provider/modello, salta la validazione modello, persiste in localStorage).
> Reshape (Fase 2) resta chat → richiede sempre un modello, by design.
> **Verificato:** 4 test nuovi (i corto-circuiti danno il risultato giusto con ZERO
> chiamate al transport — lo stub avrebbe risposto l'opposto), 122/122 verdi; UI provata
> dal vivo nel preview. README aggiornato (requisiti, CLI, tabella opzioni) con wording
> onesto: garantisce zero token, NON garantisce più velocità (senza link gate si seguono
> tutti i link in scope — su un sito grande più pagine, non meno).
>
> _Decisioni prese:_ il task resta attivo anche in no-AI nei suoi usi deterministici
> (ordering, nome file) — vedi però #20 che ne ridefinisce il ruolo; `minRelevance`
> funziona anche in no-AI (pruning lessicale, testato). **Vincolo permanente (regola
> #6): no-AI = zero chiamate a QUALSIASI modello, embeddings #22 inclusi.**

---

## #20 — `mode` esplicito (complete/targeted) — via lo sniffing della task
**Effetto:** architettura + costi (−gate/scope in complete) · **Sforzo:** Medio · **Stato:** ✅ FATTO (2026-07-03)

> **Implementato.** Opzione **`mode: 'complete' | 'targeted' | 'auto'`** (default `'auto'`
> = comportamento attuale, pura retrocompatibilità per libreria/run salvate/resume).
> Un'unica traduzione mode→interruttori del motore: `modeBehavior`
> ([src/lib/task.mjs](src/lib/task.mjs)) → `{ docsShortcuts, scopeSections, linkGate }`;
> la regex `isDocsTask` è consultata SOLO dal ramo `'auto'`. Consumatori: dispatch
> strategia in [index.mjs](src/index.mjs); scoping per-pagina e link gate in
> [crawl-page.mjs](src/engine/crawl-page.mjs) — in `complete` `decideFollow` segue tutti
> i candidati in-scope SENZA toccare il transport (zero chiamate `links` e `scope` anche
> con l'AI accesa; `minRelevance` opt-in continua a potare; best-first e cache invariati);
> reveal + nav-plan restano AI. **`targeted`+`noAi` è rifiutato forte e sincrono**:
> `crawlDocs` lancia con la spiegazione, la CLI mostra il motivo senza stack, il server
> UI risponde 400 col messaggio, e nella UI il bottone "Only what the task asks" si
> disabilita da solo (tooltip col perché) tornando a complete. Mode sconosciuto → errore,
> mai coercizione silenziosa. CLI `--mode` (help + esempi); UI: segmento sempre visibile
> _"What to extract: ⦿ Everything · the whole site ○ Only what the task asks"_ (default
> complete, persistito in localStorage, la UI non manda MAI `'auto'`), hint per-mode e
> task dichiaratamente opzionale in complete (placeholder dinamici). Tipi: `CrawlMode` +
> `mode` + `noAi` (quest'ultimo mancava da #19) in index.d.ts; README (tabella opzioni,
> sinossi CLI) e ARCHITECTURE (diagramma §3 + dispatch §5) aggiornati.
>
> **Verificato** ([test/mode.test.mjs](test/mode.test.mjs), 12 test nuovi, 135 totali,
> offline): mapping `modeBehavior` (auto = storico); complete = zero chiamate gate contro
> uno stub che risponderebbe l'OPPOSTO (follow nothing) + `minRelevance` ancora attivo;
> targeted/auto consultano il gate e ne onorano il verdetto; dispatch reale via
> `crawlDocs` su stub-site locale (complete+task-menù → `docs:llms-full`; auto+menù →
> `agent`; targeted+task-docs → `agent`); complete+noAi = cella lecita della matrice
> (0 chiamate totali, pagine intere); i due rifiuti espliciti. UI provata dal vivo nel
> preview (interlock no-AI nei due sensi, POST `targeted`+`noAi` respinto 400, zero
> errori console). ⏳ **Dal vivo:** con AI accesa su un sito reference, confermare
> `byKind.links`/`byKind.scope` = 0 in complete e il calo dei token vs `'auto'`
> (harness #12), con set di pagine ≥ dell'attuale profilo docs.
>
> _Decisioni prese:_ (a) `complete` riusa il profilo docs così com'è, incluso lo
> scope-prefix dal primo segmento del path — per "tutto il sito" si punta alla root;
> (b) il rifiuto `targeted`+`noAi` è un **throw sincrono** di `crawlDocs` (fail fast per
> la libreria), incanalato pulito in CLI/UI; (c) la UI parte in `complete` di default
> (il valore del tool è la completezza; targeted è la scelta consapevole).

**Problema oggi.** La task fa due mestieri: istruzione semantica per l'AI E interruttore
nascosto — la regex `isDocsTask` ([src/lib/task.mjs](src/lib/task.mjs)) sniffa la prosa e
cambia strategia (profilo docs sitemap/llms-full + niente scoping). Interruttori invisibili
nel testo libero = comportamento imprevedibile, dipendente dalla lingua, non debuggabile
(viola la nuova regola #6). Inoltre "docs" è un caso speciale finto: è sempre stato
"crawl di completezza", valido per qualsiasi sito.

**Proposta.**
- Opzione **`mode: 'complete' | 'targeted' | 'auto'`** (default `'auto'`):
  - **`complete`** ("tutto il sito"): scorciatoie docs (llms-full.txt/sitemap) sempre
    tentate, pagine tenute INTERE, e — la vittoria di costo — **zero chiamate link-gate
    e zero scoping anche con l'AI accesa** (tenere/scartare non ha senso se l'utente ha
    chiesto tutto; l'AI resta solo dove serve: reveal + nav-plan). Sicuro PERCHÉ il
    mirror-dedup #7 è default-on (il follow-everything è esattamente ciò che contiene).
  - **`targeted`** ("solo ciò che chiede la task"): gate + scoping AI, la visione
    task-driven piena. **Richiede l'AI** → incompatibile con `noAi`.
  - **`auto`**: comportamento attuale (regex), SOLO retrocompatibilità per libreria/
    refdna/run salvate e resume. La UI non lo usa mai.
- **CLI** `--mode`; **UI**: segmento visibile _"Cosa estrarre: ⦿ Tutto il sito ○ Solo
  ciò che chiede il task"_; con no-AI attivo "Solo il task" si disabilita da sola e il
  campo task diventa dichiaratamente opzionale (ruoli residui: istruzione AI in
  targeted, nome del file output).
- La matrice delle visioni diventa auto-evidente: complete+AI (reveal AI, zero
  gate/scope) · complete+noAI (crawler classico + reveal euristico, zero chiamate) ·
  targeted+AI (la visione piena) · targeted+noAI (⛔ disabilitato).

**Criterio di accettazione.** In `complete` con AI: `byKind.links` e `byKind.scope` = 0,
set di pagine ≥ dell'attuale profilo docs (più completo: nessun filtro di genere), costo
token drasticamente più basso (misurare con #12). In `auto`: comportamento byte-identico
a oggi (test di regressione). `targeted`+`noAi` → errore/disabilitazione chiara, mai
silenzio. Libreria: opzione piana, default invariato.

**File:** `src/index.mjs` (dispatch profilo), `src/engine/crawl-page.mjs` (scope gate +
decideFollow), `src/lib/task.mjs` (resta solo per `auto`), `bin/cli.mjs`, `ui/index.html`,
README/ARCHITECTURE.

---

## #21 — Reveal a ciclo chiuso (misura, non giudizio)
**Effetto:** precisione reveal — la missione · **Sforzo:** Medio-Alto · **Stato:** ✅ FATTO (2026-07-03)

> **Implementato**, tutti e quattro i pezzi, più un bug reale trovato dai test:
> - **(a) Consenso meccanico + multilingue.** Split sensore/decisione: perceive
>   ([perceive.mjs](src/engine/perceive.mjs)) MISURA (bottoni visibili in overlay vero —
>   fixed/sticky/dialog/aria-modal — con label, area, testo dell'overlay), il nuovo modulo
>   puro [consent.mjs](src/engine/consent.mjs) DECIDE: overlay riconosciuto consent dal suo
>   testo (`cookie|consent|gdpr|privacy|rgpd|dsgvo`) → micro-lessico ~40 stem multilingue
>   (17 lingue, legge il BANNER non il sito) con **reject preferito** su accept, poi
>   dismiss, poi **bottone primario per geometria** (solo dentro banner consent); overlay
>   NON-consent (newsletter/interstitial) → solo dismiss/close, MAI l'azione primaria di
>   un modal arbitrario. Evento `action: dismiss overlay` per l'osservabilità.
> - **(b) Triage arbitrato dalla misura.** perceive misura per candidato lo
>   `hiddenPayload` (testo del target `aria-controls` invisibile / sibling nascosto /
>   `<details>` chiuso) + `expanded` (aria-expanded). In [reveal.mjs](src/engine/reveal.mjs):
>   un "no" del modello (anche cachato cross-page) è SCAVALCATO da payload ≥ 200 char
>   (`PAYLOAD_MIN`); senza giudice (no-AI/outage) si approva TUTTO (ogni candidato ha già
>   passato il vaglio meccanico di perceive) e l'ORDINAMENTO misurato (`revealPriority`:
>   aria-expanded=false > payload pesato > kind specifico > hint label) decide chi prende
>   il budget. `DISCLOSURE_LABEL` inglese declassato a hint di ordinamento — via il gap
>   lessicale del caso "Servizi".
> - **(c) Load-more comportamentale.** Un controllo in-place che ha AGGIUNTO contenuto,
>   esiste ancora e ha fatto CRESCERE la pagina (append, non swap) viene ricliccato fino a
>   saturazione (il dedup del BlockAccumulator ferma i toggle open/close dopo un probe da
>   ~1s — prezzo accettato). `LOADMORE` inglese resta solo fast-path di efficienza.
> - **(d) Audit del residuo = uscita misurata.** perceive misura `hiddenResidualChars`
>   (testo nascosto nel main content, elemento nascosto più esterno, esclusi
>   template/script/style/aria-hidden, briciole <40 char ignorate; sostituisce il mai
>   consumato `hiddenCount`). All'uscita del loop: numero in `page.meta.revealResidualChars`
>   (0 = drenaggio misurato), accumulo in `scan.stats.revealResidual {pages, chars}` (+
>   run-level, + replay resume), warning advisory `reveal-residual` ("~N words…", suggerisce
>   --max-actions se hitCap) sopra 1200 char — mai bloccante. Metrica pura `revealResidual`
>   in [src/eval/metrics.mjs](src/eval/metrics.mjs), riga "(a) reveal residual" nel report
>   #12. Tipi (`PageMeta.revealResidualChars`, `Stats.revealResidual`) e README aggiornati.
> - **🐛 Bug reale trovato dal test (anche in AI mode):** `aiPlanNavigation` leggeva la
>   risposta documentata `{"direction":null}` come **direction=0** (`Number(null)===0`,
>   [decide.mjs](src/engine/decide.mjs)) → il loop RISERVAVA il primo controllo approvato a
>   un walk mai eseguito e **non lo cliccava mai** (contenuto perso in silenzio). Fix
>   null-safe + guardia in reveal.mjs (un piano senza target = nessun piano) + regression
>   test dedicato.
>
> **Verificato** ([test/consent.test.mjs](test/consent.test.mjs) 9 test multilingua:
> IT/DE/FR/RU/ZH chiusi, reject preferito, newsletter mai "Subscribe", link policy mai
> cliccati; [test/reveal-loop.test.mjs](test/reveal-loop.test.mjs) 6 test col loop VERO su
> FakePage senza browser: 'Mehr anzeigen' esaurito per comportamento, "Servizi"
> listener-only cliccato per primo in no-AI, "no" AI scavalcato dal payload E "no" senza
> payload onorato, residuo ritornato+warning, residuo 0 silenzioso; 151/151 verdi).
> ⏳ **Dal vivo:** A/B `revealCoverage` AI-on vs no-AI su siti reference (il no-AI non deve
> perdere contenuto noto); banner reali non-inglesi; residuo≈0 sulle pagine reference; la
> misura in-page di payload/residuo gira solo nel browser vero → da osservare su un crawl
> reale. _Regola d'oro confermata:_ ogni gap futuro diventa un segnale MECCANICO nuovo,
> non una parola in più nel lessico.

**Problema oggi.** Il loop di reveal esce quando "non trova più controlli approvati" —
un giudizio (dell'AI o dell'euristica), non una prova. E tre lessici English-only
minano l'universalità: `CONSENT_RE` (un banner "Accetta tutti"/"Zustimmen" NON viene
chiuso **nemmeno in modalità AI** — l'overlay può coprire la pagina e rovinare tutto),
`LOADMORE`, `DISCLOSURE_LABEL` (in no-AI un div "Servizi" con listener ma senza ARIA
non viene cliccato). Principio guida (dalla sessione 2026-07-02): **non indovinare
dalle parole (infinite) — misurare il comportamento (universale)**: un elemento ha un
listener o no; del testo è nascosto o no; un click aggiunge contenuto o no.

**Proposta (quattro pezzi, stesso file).**
- **(a) Consenso meccanico + multilingue** — URGENTE, bug anche in AI mode: candidato =
  bottone in overlay vero (già richiesto: fixed/modal) + token "cookie"/"consent" nel
  testo dell'overlay (quasi universali) + bottone primario per geometria; micro-lessico
  accept/reject multilingue (~40 parole, legge il BANNER non il sito → ammesso). Nel
  dubbio preferire il reject (chiude ugualmente, più rispettoso).
- **(b) Triage arbitrato dalla misura**: un "no" (dell'AI O dell'euristica) viene
  scavalcato quando dietro il controllo c'è **payload nascosto misurabile** (target di
  `aria-controls` invisibile con massa di testo, pannelli-sibling nascosti). L'errore
  del giudice diventa innocuo. In no-AI: approvare TUTTI i candidati meccanicamente
  plausibili, ordinati per segnali misurati (aria-expanded=false, payload, kind) — un
  click sprecato costa ~1s, contenuto perso è irrecuperabile (regola #1).
- **(c) Load-more comportamentale**: un controllo in-place che ha AGGIUNTO contenuto ed
  esiste ancora → ricliccato fino a saturazione (bounded da maxActions/ADV_CAP, il
  dedup del BlockAccumulator ferma i cicli A↔B). Via la dipendenza dalla label inglese;
  `LOADMORE` resta solo come hint di efficienza.
- **(d) Audit del residuo nascosto = condizione di uscita**: a ogni giro misurare il
  testo ancora nascosto nel main content (escludendo `<template>`/aria-hidden
  boilerplate); il loop esce quando **residuo ≈ 0 O budget esaurito**. Il residuo finale
  va in `page.meta`, `scan.stats` e in un evento → **garanzia di completezza
  machine-readable, per pagina, anche via libreria**; warning col numero quando resta
  massa non rivelata ("~3.000 parole dietro controlli non raggiunti — alza
  --max-actions"). Advisory, mai bloccante (i falsi positivi da boilerplate non
  bloccano il crawl).

**Criterio di accettazione.** A/B con #12 (`revealCoverage`) su siti reference AI-on vs
no-AI: il no-AI non perde contenuto noto (paga solo click in più); banner non-inglesi
chiusi (fixture offline multilingua); residuo=0 sulle pagine reference; ogni gap trovato
dal vivo diventa un nuovo segnale MECCANICO, non una nuova parola in un lessico.
_Estensione futura (parcheggiata):_ hover e digitazione nei campi (search/filter) come
interazioni di reveal — imparentata con #9.

**File:** `src/engine/perceive.mjs`, `src/engine/reveal.mjs`, `src/engine/actions.mjs`,
`src/eval/` (metrica residuo), test offline con fixture multilingua.

---

## #22 — Tier embeddings (`embedModel`) — ranking semantico multilingua
**Effetto:** qualità ranking + Reshape · **Sforzo:** Medio · **Stato:** ✅ FATTO (2026-07-03)

> **Implementato**, tutti e quattro i pezzi della proposta (e l'upgrade lessicale
> n-gram/IDF NON rifatto, come da decisione — del lessicale solo il fix Unicode):
> - **`embed(llm, texts)` nel transport** ([llm.mjs](src/lib/llm.mjs)): Ollama
>   `/api/embed` + OpenAI-compat `/v1/embeddings`, stesso seam provider del chat —
>   limiter per-provider, timeout, vettori in ordine d'input, metering `byKind.embed`
>   (input tokens, output 0). `resolveLlm` porta `embedModel` nel descrittore; con
>   `noAi` il descrittore 'none' NON lo porta e `embed()` rifiuta comunque (doppia
>   garanzia regola #6: zero chiamate a QUALSIASI modello).
> - **Scorer semantico per-scan** (nuovo [semantic.mjs](src/lib/semantic.mjs),
>   `createScorer`): task embeddato una volta, link unici embeddati in batch da 64 e
>   cachati per scan (testo = label + heading vicino + path decodificato); cosine
>   clampato [0,1] = score. Regole di precisione nel codice: ORDINA sempre, taglia solo
>   su `minRelevance` opt-in; task generico (zero topic-term) → tutti 1 e ZERO chiamate;
>   backend rotto → UN warning (`reason: 'embed'`) e pavimento lessicale, mai silenzio.
>   Consumatori in [crawl-page.mjs](src/engine/crawl-page.mjs): `decideFollow`
>   (ordinamento best-first + pruning minRelevance), route budget #16 (`budgetRoutes`
>   accetta una score-map opzionale; le route si embeddano SOLO quando il budget
>   taglierebbe davvero).
> - **Retrieval Reshape semantico**: `selectRelevant` ([retrieve.mjs](src/lib/retrieve.mjs))
>   accetta un `sectionScore` esterno (sostituisce il punteggio lessicale, boost
>   documento-nominato e packing invariati; niente più fallback 'head' quando il
>   semantico discrimina); `semanticSectionScores` embedda ogni sezione per GIST
>   (heading + primi 300 char — costo limitato) e `aiReshape` lo usa solo quando le
>   fonti sforano il budget. Richiesta cross-lingua → sezioni giuste.
> - **Fix Unicode del lessicale** ([relevance.mjs](src/lib/relevance.mjs) `tokenize`):
>   split Unicode-aware + diacritici FOLDED via NFKD ("menù"↔"menu",
>   "documentación"↔"documenta…"), cirillico/greco come parole, run CJK a bigrammi
>   (提取价格 ↔ 价格表 si incontrano su 价格) — l'ASCII-only li DISTRUGGEVA. Vale anche
>   per il retrieval del Reshape (tokenize/termHit condivisi). ASCII invariato
>   (suite pre-esistente verde). Aggiunto 'everything' alle stopword request-framing.
> - **Superficie**: opzione piana `embedModel` (default undefined = lessicale), CLI
>   `--embed-model` (crawl E reshape), UI campo "Embedding model (optional)" in
>   Advanced (persistito, non inviato se vuoto), tipi (`CrawlOptions.embedModel`,
>   byKind 'embed'), README (tabella + nota).
>
> **Verificato** ([test/embed.test.mjs](test/embed.test.mjs), 15 test, 166 totali,
> offline — stub OpenAI-compat che mappa keyword→vettori): fixture d'accettazione
> task-IT/sito-DE (lessicale 0 a tutto, semantico ordina Preise>Kontakt); cache
> per-scan (zero embed ripetuti); task generico zero chiamate; noAi zero chiamate;
> failure → un warning e pavimento lessicale; decideFollow pruning semantico
> PRIMA del gate e nessun drop di default (solo ordering); budgetRoutes con
> score-map + guardia no-varianza intatta; retrieval cross-lingua ('dammi i
> prezzi' → sezione Pricing EN, 'head'→'retrieval'); metering byKind.embed;
> tokenize su 4 script. UI provata dal vivo (campo, persistenza, console pulita).
> ⏳ **Dal vivo:** `ollama pull nomic-embed-text` e un crawl reference con
> `--embed-model` — confermare ordering migliore su sito multilingua reale e costo
> `byKind.embed` trascurabile rispetto al chat (harness #12).

**Problema oggi.** Tutto il ranking task→link è lessicale ([src/lib/relevance.mjs](src/lib/relevance.mjs)):
cieco tra lingue (task "estrai i prezzi" su sito tedesco: "Preise" score 0) e sui
sinonimi ("listino", "tariffe"); il tokenizzatore è ASCII-only (accenti/cirillico/CJK
distrutti). Riguarda: ordine del frontier, route budget #16, `minRelevance`, e il
retrieval del Reshape (#11, `termHit` condiviso).

**Proposta.**
- **`embed(llm, texts)` nel transport** ([src/lib/llm.mjs](src/lib/llm.mjs)): Ollama
  `/api/embed` + OpenAI-compat `/v1/embeddings` — stesso seam a provider del chat.
  Nuova opzione **`embedModel`** (es. `nomic-embed-text` 270MB, o `bge-m3` per il
  multilingue spinto); CLI `--embed-model`, campo UI (advanced).
- **Backend semantico di `scoreLink`**: task embeddato una volta per scan, link unici
  embeddati in batch e cachati per scan (pattern `_followCache`); cosine = score.
  Alimenta frontier, route budget, `minRelevance` e il retrieval del Reshape.
- **Regola di precisione**: gli embeddings **ordinano sempre, tagliano solo su
  `minRelevance` opt-in** (i punteggi sono relativi, non assoluti). L'AI-gate resta il
  giudice in targeted; niente allucinazioni possibili (emettono numeri, non testo).
- **Fallback**: senza `embedModel` (o modello irraggiungibile → warn una-tantum,
  pattern `checkModel`) resta il lessicale come pavimento, col SOLO fix minimo
  Unicode (accenti/cirillico/CJK a bigrammi — serve anche al Reshape).
- **Vincolo (regola #6): con `noAi` gli embeddings sono SPENTI** — zero chiamate totali.

**Decisione presa (2026-07-02, non rifare):** l'upgrade lessicale sofisticato
(similarità n-gram, pesi IDF auto-calibranti) è stato valutato e **BOCCIATO** — non
supera il criterio "miglioramento significativo" (non risolve sinonimi/cross-lingua,
che è il problema reale); gli embeddings sono l'alternativa migliore. Del lessicale si
tiene solo il fix Unicode.

**Criterio di accettazione.** Su fixture multilingua (task IT, sito DE/EN): ordering
corretto (pagine on-task prime) dove il lessicale dà 0 a tutto; `byKind` mostra costo
embeddings trascurabile rispetto al chat; con `noAi` zero chiamate (test); il retrieval
del Reshape seleziona le sezioni giuste cross-lingua. Nessun link scartato di default.

**File:** `src/lib/llm.mjs`, `src/lib/relevance.mjs`, `src/lib/retrieve.mjs`,
`src/engine/crawl-page.mjs`, `bin/cli.mjs`, `ui/index.html`, README.

---

## #23 — No-AI: la task non ha NESSUN ruolo + default `mode: complete`
**Effetto:** coerenza regola #6 (niente testo che pilota) · **Sforzo:** Basso · **Stato:** ✅ FATTO (2026-07-03)

**Problema (feedback utente, 2026-07-03).** Con `--no-ai` la task faceva ancora tre
cose: (a) ordinava i link lessicalmente (`scoreLink`), (b) dava il nome al file di
output (`taskToName`), (c) senza `--mode` esplicito veniva letta dalla regex docs del
legacy `auto`. Regola #6 portata in fondo: la task parla SOLO all'AI — se l'AI non
c'è, la task non deve fare niente, nome del file compreso.

**Implementato.**
- **Core** ([src/index.mjs](src/index.mjs)): con `noAi`, una task esplicita
  (opzione O per-target) è **rifiutata forte** (stesso stile di `targeted`+`noAi`);
  idem `minRelevance > 0` (il suo punteggio È rilevanza-alla-task). La task di
  default viene azzerata: niente ordinamento lessicale (task vuota → `scoreLink`
  dà 1 a tutti = zero discriminazione), niente naming. I run **ripresi** (`__resume`)
  sono esenti dal rifiuto (opzioni salvate prima del contratto): le loro task
  vengono azzerate in silenzio.
- **Naming dal sito** ([src/lib/layout.mjs](src/lib/layout.mjs)): scan senza task →
  file e titolo derivati dall'host (`docs.example.com` → `docs-example-com.md`),
  anche nell'index per-documento.
- **Default `mode`: `'auto'` → `'complete'`.** Lo sniffing "documentazione" sparisce
  dall'esperienza di default su OGNI superficie; `auto` resta solo per chi lo chiede
  per nome (vecchi script) e per i run salvati/ripresi (che portano il loro mode).
- **CLI** ([bin/cli.mjs](bin/cli.mjs)): help aggiornato (`--no-ai` non suggerisce più
  `--min-relevance`; `--task` e `--min-relevance` dichiarano il rifiuto con no-AI).
- **UI** ([ui/index.html](ui/index.html)): con "Crawl without AI" i campi task
  (per-riga e shared), "Focus on task" ed "Embedding model" si spengono visibilmente
  (title con il perché) e i loro valori residui NON vengono inviati; hint aggiornato.
  Bonus: campo embedding con datalist dei modelli del provider (embed-named primi).

**Criterio di accettazione.** `noAi`+task (opzione o target) → throw sincrono con
messaggio chiaro; `noAi`+`minRelevance` → throw; `noAi` senza task → crawl ok, file
nominato dall'host; resume di un run no-AI salvato con task → NON rifiutato, task
inerte; default mode = complete (nessuna chiamata links/scope senza `--mode`).

**File:** `src/index.mjs`, `src/lib/layout.mjs`, `bin/cli.mjs`, `ui/index.html`,
`index.d.ts`, README, test.

---

## #24 — Fedeltà di layout dell'.md (varianti in posizione, link esterni, indentazione)
**Effetto:** precisione output — leggibilità · **Sforzo:** Medio · **Stato:** ✅ FATTO (2026-07-04)

**Problema (feedback utente, 2026-07-04, run Vuetify).** L'.md non rispecchiava il
layout della pagina: (a) le varianti dei tab (pnpm/yarn/npm/bun) venivano catturate
ma **appese in fondo al documento**, staccate dalla loro sezione, con marker
`<!-- variant: … -->` invisibile nel rendering — "la cosa più importante non la fa";
(b) la lista di link esterni (siti ufficiali dei package manager) veniva **cancellata**
dal pruning per densità di link (#8), e la cascata di sicurezza non poteva vederlo
perché `contentWordLen` ignora il testo dei link per design; (c) l'indentazione dei
blocchi di codice (e delle liste annidate) veniva **schiacciata** da una regex globale
`[ \t]{2,}→' '`; (d) la barra dei tab serializzava come testo spazzatura
("pnpmyarnnpmbun"); (e) H1 doppio per pagina; (f) card pubblicitaria ("ads via …")
nell'output.

**Implementato (tutto universale, zero regole per-sito).**
- **Merge ancorato** ([src/extract.mjs](src/extract.mjs) `BlockAccumulator.add`): un
  blocco nuovo si inserisce PRIMA del blocco già noto che lo segue nello stato
  catturato (la sua posizione nell'ordine di lettura di quello stato); solo il
  contenuto veramente appeso (load-more) finisce in coda. Le varianti tab atterrano
  accanto al fratello che sostituiscono: pnpm → yarn → npm → bun, nella sezione giusta.
- **Marker visibile**: `**yarn:**` (l'etichetta del tab, in grassetto) al posto del
  commento HTML che spariva in ogni rendering.
- **Barra tab = chrome**: `[role=tablist]`/`[role=tab]` in `CHROME_SELECTORS` — i
  PANNELLI (`role=tabpanel`) restano, l'etichetta sopravvive nel marker.
- **Pruning site-aware** (`pruneNavByLinkDensity(content, host)`): la navigazione
  naviga il SITO → un contenitore link-denso si prune solo se i link restano
  overwhelmingly sull'host (relativi = interni); una lista che punta fuori sito è
  riferimenti = contenuto. Senza `baseUrl` decide la sola densità (come prima).
- **Cleanup fence-aware** (`cleanupLines`): gli spazi si collassano solo FRA le parole
  e mai dentro i fence ``` — l'indentazione del codice e delle liste annidate è
  struttura; righe orfane `[`/`]`/`!` da card rotte eliminate.
- **Ad card senza classe stabile**: etichetta convenzione-Carbon "ads via <sponsor>"
  (elemento corto, solo-label) → si rimuove la card cliccabile intera; la prosa che
  MENZIONA gli ads sopravvive (bounded ≤30 char).
- **Header per-pagina senza H1 doppio** ([src/lib/layout.mjs](src/lib/layout.mjs)):
  se il corpo della pagina apre già con un `# `, il consolidato emette solo la riga
  `_Source: url_`; il titolo strutturale resta per le pagine senza H1 proprio.

**Verificato dal vivo** (run 20260704-002553 sulla stessa pagina Vuetify della
segnalazione): lista pnpm/yarn/npm/bun presente, 4 varianti in posizione con marker
visibili, indentazione intatta, zero junk tab-bar, zero ad, zero H1 doppi.
193 test offline verdi.

**File:** `src/extract.mjs`, `src/lib/layout.mjs`, test (`extract.test.mjs`,
`layout.test.mjs`).

---

## #25 — App incorporate: viste raggiunte, budget protetto, liste/tabelle leggibili
**Effetto:** precisione reveal + leggibilità output · **Sforzo:** Medio · **Stato:** ✅ FATTO (2026-07-04)

**Problema (feedback utente, 2026-07-04, demo "Vuetify Gallery" sulla home).** (a) Le
viste Analytics/Chat della demo non venivano MAI estratte: il drawer della demo è un
`<nav>` (landmark) e la regola anti-chrome di perceive lo scartava — giusta per la
navigazione del sito, sbagliata per la navigazione INTERNA di un'app dentro il
contenuto. (b) Il budget azioni (40) si dissanguava su decine di righe-DATI con
listener (card, righe tabella, chip — ripple framework), ognuna cliccata a effetto
zero. (c) L'output era illeggibile: liste d'app frantumate un-campo-per-paragrafo,
tabella GFM sfasciata dalle celle multi-linea, `!` orfani dagli avatar lazy-load che
rompevano anche la dedup (tabella ripetuta 3×).

**Implementato (tutto universale, misurato-non-giudicato).**
- **perceive** ([src/engine/perceive.mjs](src/engine/perceive.mjs)): dentro un main
  container REALE (≠ body), un landmark annidato appartiene al contenuto — un
  CONTROLLO JS (listener sniffato, tag/ruolo interattivo, mai un `<a>`: resta link
  per il gate) sopravvive al check chrome. Col fallback body la regola landmark resta
  sovrana (lì il nav è davvero del sito).
- **Futility guard** ([src/engine/reveal.mjs](src/engine/reveal.mjs)): controlli che
  condividono la FORMA (role|kind|classe) vengono sondati; dopo `SHAPE_DEAD`=3 click
  consecutivi senza alcun effetto (0 blocchi, fingerprint fermo, no navigazione) i
  sosia restanti sono silenziati per la pagina (evento `skip` trasparente). Un solo
  membro efficace riarma la forma (i giorni di calendario restano vivi). Costo max
  per forma inutile: 3 click invece di N.
- **Marker visibili estesi**: non solo i tab — anche control/dropdown con etichetta
  corta (≤32) marcano i blocchi che il loro click ha aggiunto (`**Chat:**`,
  `**Settings:**`, `**Security:**`…): si vede QUALE stato ha prodotto cosa.
- **extract** ([src/extract.mjs](src/extract.mjs)): (1) liste ARIA
  (`role=list/listitem`) → un item = un bullet; (2) righe ripetute SENZA ruolo
  (≥3 div fratelli stessa classe base, testo breve, niente blocchi pesanti, mai
  dentro td/th) → stesso trattamento — le transazioni diventano
  `- JL John Leider 21 Mar 8:00PM +$36.11`; (3) celle di tabella GFM appiattite a
  una riga (pipe escapati) — la tabella non si sfascia più; (4) lookbehind sul
  cleanup permalink: `![](src)` non perde più il suo `[](src)` (niente `!` orfani);
  (5) identità di dedup dei blocchi: ignora le immagini decorative alt-vuoto
  (lazy-load ≠ blocco nuovo) e per le TABELLE ordina le righe nella sola CHIAVE —
  il click su un header di sort non duplica più la tabella (il blocco salvato resta
  verbatim, primo visto).

**Verificato dal vivo** (run 20260704-092622, home vuetifyjs.com): Dashboard,
Analytics (7D/30D/90D), Chat, e una vista Settings con tab Profile/Security/
Notifications prima invisibili — tutte estratte, etichettate e leggibili; tabelle
una sola volta; `skip muting 5 look-alike control(s)` in azione. 197 test verdi.

**File:** `src/engine/perceive.mjs`, `src/engine/reveal.mjs`, `src/extract.mjs`,
`test/extract.test.mjs`.

---

## #26 — Recupero heading per peso visivo (scheletro dell'.md, deterministico)
**Effetto:** precisione output — struttura, abilita meglio il reshape · **Sforzo:** Medio · **Stato:** ✅ FATTO (2026-07-04)

**Problema (discussione utente, 2026-07-04).** L'.md verbatim è ANCHE l'input del
reshape: se la base è piatta, la Fase 2 eredita l'ambiguità. E la base è piatta non
perché la pagina non avesse struttura, ma perché **la buttiamo via in Fase 1**. Le app
marcano i titoli VISIVAMENTE, non semanticamente. Misurato dal vivo sul dashboard demo
di vuetifyjs.com/en (probe `getComputedStyle`):

| Titolo nel dashboard | Nel DOM | Nell'.md oggi |
|---|---|---|
| "Component Gallery" | `<h4>` 32px/700 | `#### Component Gallery` ✅ |
| "Summary" / "Transactions" / "Recent Orders" | `<div class="v-card-title">` 22px/400 (font body = 16px) | testo piatto ❌ |

Turndown si fida solo di `<h1>`–`<h6>`/`role=heading`, quindi ogni titolo di card/sezione
marcato con font più grande diventa una riga anonima. Il dashboard perde lo scheletro.

**La regola di confine (perché è Fase 1 e non reshape).** Struttura che ESISTEVA nella
pagina (heading visivi, card, sezioni, liste, tabelle) = FEDELTÀ → Fase 1, deterministica,
gratis, per tutti, anche `--no-ai`. Struttura che NON esisteva (dire "questi 4 numeri sono
KPI", raggruppare per significato) = INVENZIONE → Fase 2/reshape, AI, opzionale, verificata.
#26 sposta il confine dove deve stare: TUTTA la struttura recuperabile dal DOM va in Fase 1.
Risolve entrambi i "ma" dell'utente: (1) non è opzionale → chi salta il reshape la ottiene
comunque; (2) dà al reshape uno scheletro vero da cui partire.

**Design proposto (universale, zero AI, misurato-non-giudicato).**
- **DOVE**: al momento della cattura, in `perceive`/`captureHtml` (browser, dove
  `getComputedStyle` è disponibile) — NON in Node (node-html-parser non ha gli stili
  calcolati). Marca gli elementi heading-per-vista con un attributo
  (`data-crawldna-heading="2|3"`) che `extract.mjs` poi converte in `##`/`###` con una
  regola turndown, come già si fa per `data-crawldna-hidden`.
- **SEGNALE (rapporto, mai una classe)**: un elemento è heading visivo se il suo testo è
  CORTO (≤ ~60 char, una riga), NON dentro `<a>`/`<button>`/cella-tabella/codice, e ha un
  SALTO netto rispetto al corpo attorno — `fontSize ≥ 1.15× del font body locale` OPPURE
  (`fontWeight ≥ 600` E `fontSize ≥ body`). Il livello si mappa dal rapporto in bucket
  (es. ≥1.8→h2, ≥1.35→h3, resto→h4), COERENTE con gli `<h*>` semantici già presenti (non
  scavalcare: se un `<h2>` reale vale 32px, un card-title da 22px deve diventare h3/h4, non
  h1). Considera di calcolare il "font body locale" dal testo di paragrafo più vicino, non
  dal solo `body`, così un blocco tutto grande non promuove tutto.
- **CONSERVATIVO (regola #1, asimmetria)**: meglio un heading di troppo che perdere lo
  scheletro. Ma limitare i falsi positivi: escludere blocchi lunghi (paragrafi in grassetto,
  pull-quote), elementi con molti figli di testo, e ciò che è già dentro liste/tabelle
  (#25). Nessun contenuto viene MAI rimosso o riscritto: si aggiunge solo il livello `#`.
- **INTERAZIONE con #24/#25**: gira PRIMA della conversione markdown; i marker di variante
  (`**Chat:**`) e i bullet delle liste restano. Un card-title dentro una vista reveal
  diventa un heading nella sezione di quella vista.

**Criterio di accettazione.** Sul dashboard demo: "Summary"/"Transactions"/"Recent Orders"
diventano heading (`##`/`###`) sopra il loro contenuto, SENZA scavalcare gli `<h4>` reali
("Component Gallery"). Un paragrafo introduttivo in grassetto NON diventa heading. Zero
contenuto perso (diff del testo non-heading invariato). Funziona identico in `--no-ai`
(zero chiamate modello). Test offline in `test/extract.test.mjs` con HTML che porta gli
stili inline (il path browser va verificato dal vivo con un probe, come #25).

**Limite onesto (resta reshape).** Dove la pagina NON ha alcun titolo (4 card di statistiche
senza etichetta di gruppo), la Fase 1 tiene il raggruppamento (bordo card, #25) ma non può
inventare l'etichetta "KPI". Quell'ultimo miglio semantico è Fase 2.

**Fatto (2026-07-04).** Come da design, con queste decisioni:
- **DOVE**: `markVisualHeadings()` vive in `engine/perceive.mjs` (auto-contenuta) e viene
  INLINED via `toString()` nell'evaluate di `captureHtml` (reveal.mjs) — stessa passata
  atomica di `data-crawldna-hidden` (marca → serializza → smarca), evaluate in forma
  STRINGA così non c'è eval annidato che una CSP possa bloccare. In più un GEMELLO Node in
  `extract.mjs` applica le stesse regole agli stili INLINE: copre il path statico e rende
  l'euristica testabile offline (i due gemelli vanno tenuti in sync, è scritto nei commenti).
- **SEGNALE** (oltre la spec): testo ≤60 char con almeno UNA lettera (numeri/prezzi nudi
  = dati, mai titoli — così "$44.99"/"42" delle stat card non diventano h2); blocco
  non-inline (il wrapper `<div>` di uno `<span>` grande viene marcato lui); salto =
  fontSize ≥1.15× il body LOCALE (dominante del testo circostante — un hero tutto-grande
  non si auto-promuove) oppure bold ≥600 a fontSize ≥ body locale; mai sotto il font body
  della PAGINA; blocchi a taglie miste esclusi (min ≥0.75×max: valore-stat + caption non è
  un titolo); FRATELLI RIPETUTI stessa shape (tag + primo token di classe, ≥3 — lo stesso
  segnale di shapedRowItem #25) esclusi: una riga di transazione col nome in bold non
  diventa mai h4, resta bullet.
- **LIVELLI / "coerente coi reali"**: rapporto vs body di pagina (≥1.8→h2, ≥1.35→h3,
  resto h4), mai h1. "Non scavalcare" = i `<h*>` semantici non vengono MAI toccati o
  ri-livellati (il `<h4>` da 32px resta `####`, non diventa `##`) e i visivi non prendono
  mai h1 — NON una monotonia stretta di font vs ogni h* reale: sul caso reale (h4@32px)
  quella avrebbe forzato i card-title da 22px a h5, perdendo proprio lo scheletro cercato.

**Verificato dal vivo** (probe + run 20260704-100625, home vuetifyjs.com, `--no-ai`):
"Summary"/"Transactions"/"Recent Orders" → `###` sopra le loro tabelle/bullet;
`#### Component Gallery` e tutti gli h4 reali intoccati; i titoli delle card galleria
("Misty Mountains"…) → h4 via bold-rule (titoli veri, conservativo nel verso giusto);
bullet #25 e tabelle GFM invariati; passata di marcatura ~5ms. 207 test verdi (10 nuovi
#26: card-title 22px→`###`, 30px→`##`, label bold→`####`, paragrafo bold lungo NO,
dentro link/bottoni/liste/celle NO, hero NO, prezzi/stat-card NO, righe ripetute NO,
marker browser→`##` senza stili, wrapper con span grande→`###`; e il diff del testo
non-heading è byte-identico — regola #1).

**File:** `src/engine/perceive.mjs` (marcatura in-browser), `src/engine/reveal.mjs`
(inline atomico in captureHtml), `src/extract.mjs` (gemello Node + regola turndown),
`test/extract.test.mjs`.

**Correzione (2026-07-04, feedback utente sull'ordine).** Due difetti trovati sulla
run successiva e corretti insieme:
1. **Bug #26 introdotto**: il marcatore di heading scattava DENTRO le righe ripetute
   che #25 appiattisce a bullet (tile della gallery, stat card, swatch colore),
   producendo `- #### Misty Mountains` o `### 24.5K` a metà riga. Il controllo
   sui fratelli guardava solo l'elemento stesso, ma il titolo è spesso un
   title-wrapper ANNIDATO nella card. Fix: `isShapedRow` alzato a scope di modulo
   (una sola definizione condivisa da shapedRowItem e dal marcatore) e il candidato
   ora esclude sé stesso E gli antenati che sono righe-appiattite (in entrambi i
   path). Summary/Transactions/Recent Orders sopravvivono (le loro card hanno una
   tabella/lista o <3 fratelli same-shape). Bug secondario risolto lungo la strada:
   node-html-parser usa `tagName`, non `nodeName` → `isShapedRow` falliva su TUTTI i
   nodi del path statico; introdotto `tagOf()` che copre entrambi i DOM (turndown/
   domino ha nodeName, node-html-parser ha tagName).

## #27 — Ordine di rappresentazione dell'.md (viste app in ordine di pagina, base per prima)
**Effetto:** precisione output — struttura/leggibilità, migliore input per il reshape · **Sforzo:** Medio · **Stato:** ✅ FATTO (2026-07-04)

**Problema (feedback utente).** In un'app incorporata le viste (Dashboard/Analytics/
Chat/Settings) si scambiano NELLO STESSO pannello: condividono solo la cornice attorno,
non contenuto tra loro. Il merge ancorato di #24 (che allinea le varianti tab pnpm/yarn
perché condividono i blocchi attorno) le impilava invece in ordine di CLICK, e la vista
di default (Dashboard, quella più vicina al link base) finiva ULTIMA. Misurato sulla run
20260704-101234: Analytics → Chat → Settings → Dashboard. L'utente: l'ordine deve essere
per PROSSIMITÀ al link base e per ordine di RAPPRESENTAZIONE.

**Fix (deterministico, zero AI).**
- **`order` per stato** = posizione verticale ASSOLUTA del controllo che rivela la vista
  (`top` = `rect.top + scrollY`, aggiunto ai revealer in perceive; passato da reveal a
  `capture()` → `BlockAccumulator.add`). La barra di navigazione di un'app va
  Dashboard→Analytics→Chat→Settings dall'alto in basso, quindi le viste escono in
  quell'ordine invece che nell'ordine di click. Le strip di tab orizzontali condividono
  `top` → mantengono l'ordine di scoperta (stabile). Baseline e scroll pigro = 0.
- **`_spliceByOrder`**: dentro uno stesso slot (ancora condivisa) i gruppi si ordinano per
  `order` (stabile). NON cambia nulla con tutti order 0 (path tab/load-more): il sort si
  attiva solo per un order positivo → retro-compatibile al byte.
- **Ancore deboli saltate**: una riga orizzontale (`---`) o uno stub ≤2 char è un divisore
  di cornice che RICORRE identico in ogni vista; ancorare una vista scambiata su di esso la
  fa cadere SOPRA il contenuto della vista di default (che sta appena sotto lo stesso
  divisore). Il merge ora salta le ancore deboli e si aggancia al primo blocco DISTINTIVO
  (es. "Sponsors & Backers"), così le viste rivelate atterrano DOPO la base, in ordine di
  pagina. Questo è ciò che ha spostato Dashboard in prima posizione.

**Verificato dal vivo** (run finale, home vuetifyjs.com, `--no-ai`, dump ordine blocchi):
Component Gallery → **Dashboard (base): stat card, Recent Orders, Transactions, Summary** →
Analytics (Top Pages) → Settings (Security/Notifications) → Chat → Settings (Profile) →
Sponsors & Backers → resto marketing. La base è prima, le viste seguono in ordine di
nav-rail, il marketing resta al suo posto. 213 test offline verdi (6 nuovi #26/#27:
tile annidata resta bullet, stat-value con unità niente `###`, viste mutuo-esclusive in
ordine di pagina base-prima, ancora debole saltata, gruppo multi-blocco contiguo,
order-0 = merge legacy invariato). Limite onesto: il contenuto Settings può spezzarsi se
rivelato da controlli a `top` diversi (gear nav vs strip di tab) — cosmetico; la struttura
di sezione è corretta.

**File:** `src/engine/perceive.mjs` (`top` sui revealer), `src/engine/reveal.mjs`
(`order` in `capture`), `src/extract.mjs` (`add` order-aware + `_spliceByOrder` +
`isWeakAnchor`), `test/extract.test.mjs`.

---

## #28 — Copertura totale dei cliccabili: controlli JS nella chrome (nav/header/footer)
**Effetto:** precisione reveal — nessun cliccabile perso · **Sforzo:** Basso-Medio · **Stato:** ✅ FATTO (2026-07-04)

**Problema (feedback utente).** "Voglio la copertura massima sugli elementi cliccabili,
che non ne manchi nessuno — prima mancava il nav." La percezione limitava i candidati
reveal al SOLO contenuto principale (`mainEl.querySelectorAll`) ed escludeva la site chrome
(`isChrome`), con la sola eccezione #25 dei landmark ANNIDATI in un main reale. Un nav di
alto livello (SPA top-nav / app rail in un `<nav>`/`<header>` FUORI dal main) i cui pulsanti
scambiano la vista in-place SENZA URL non veniva né iterato né cliccato → ogni vista
non-default silenziosamente persa (regola #1).

**Fix (universale, misurato, identico in `--no-ai`).**
- **Due liste sullo stesso setaccio, main-first** (perceive): pass 1 = contenuto principale,
  pass 2 = tutto il body per i suoi CONTROLLI JS di chrome (`considered` deduplica la
  sovrapposizione, quindi il main è processato una volta, per primo). Un `<a href>` di nav
  resta un LINK (raccolto e crawlato come pagina propria), mai un revealer. Un controllo JS
  di chrome (o una disclosure MISURATA: `aria-expanded`/`aria-controls`, es. un `<details>`
  di footer) viene tenuto e marcato `chrome`.
- **Penalità `chrome` in `revealPriority`** (reveal): il contenuto prende SEMPRE il budget
  d'azione per primo; la chrome lo scavalca solo con prova MISURATA forte (payload reale /
  disclosure chiusa), mai su un semplice indizio di kind/label. Onora la vecchia filosofia
  "budget sul contenuto, non sulla nav globale" pur coprendo la nav.
- **`chrome` = solo VERA site chrome**: un elemento annidato in un main reale NON è marcato
  (preserva #25 esattamente, senza penalità); la chrome vera è ciò che sta FUORI dal main
  (o l'intera pagina col fallback `<body>`).
- **Riuso id consent↔revealer**: ora che pass 2 scandaglia tutta la pagina, un pulsante di
  header sticky / banner può essere sia consentCandidate sia revealer; il revealer RIUSA
  l'id già stampato dal blocco consent invece di sovrascriverlo → la dismissione cookie non
  si rompe e la copertura sticky è preservata.

Le guardie del ciclo chiuso già esistenti (shape-muting dopo 3 click a vuoto, ordinamento
per payload misurato, il triage AI che scarta la nav pura) limitano il rumore di chrome —
in `--no-ai` tutti approvati, ma l'ordinamento misurato + il muting bloccano lo spreco.

**Verificato:** 215 test offline verdi (2 nuovi in reveal-loop: penalità chrome vs gemello
di contenuto, con la prova misurata che vince comunque; no-AI che copre un view-switcher di
chrome MA clicca prima il controllo di contenuto). ⏳ Da confermare dal vivo su una SPA con
top-nav JS (il nav che prima mancava ora compare tra i controlli cliccati).

**File:** `src/engine/perceive.mjs` (due liste main-first, keep-chrome dei controlli JS,
flag `chrome`, riuso id), `src/engine/reveal.mjs` (`revealPriority` penalità chrome),
`test/reveal-loop.test.mjs`.

---

## #29 — Reveal "compatto ma strutturato" + record fedele per-stato
**Effetto:** precisione output — nessuna perdita di struttura/contesto tra stati · **Sforzo:** Medio · **Stato:** ✅ FATTO (2026-07-04)

**Problema (feedback utente).** Quando un click cambia solo una parte della pagina, il
`BlockAccumulator` fondeva tutti gli stati in un unico elenco deduplicato. Sul caso
`A,b,c → A,b,d → r,b,d` l'output diventava `A, b, c, d, r`: `d` ed `r` **orfani**, persa la
co-occorrenza (cosa stava insieme sullo schermo), e — peggio — lo snapshot dello stato
veniva **buttato al merge**, quindi "stato 3 = r,b,d" non era ricostruibile **nemmeno dopo**
(contro regola #1 mai perdere / #3 Fase 1 verbatim). Scelta utente (AskUserQuestion): vista
di default **"compatta ma strutturata"** — cornice condivisa una volta, frammenti che
cambiano raggruppati per stato ed etichettati — **più** gli stati interi salvati a parte.

**Fix (deterministico, zero AI, dentro il `BlockAccumulator`).**
- **Ritenzione degli stati**: `add()` non fonde più incrementalmente — salva il testo di
  ogni blocco una volta (`store`) e **pusha lo snapshot ordinato** di ogni cattura
  (`_states`). Ritorna ancora il conteggio dei blocchi mai visti (`added` per la loop di
  reveal invariato). Vista e record sono **derivati a read-time**.
- **`toMarkdown()` compatto-strutturato**: `frame` = blocchi presenti in OGNI stato VARIANTE
  (mutuo-esclusivo, ha nascosto un blocco del baseline) + baseline → cornice una volta. Ogni
  stato variante emette i suoi blocchi non-frame come **UN gruppo contiguo etichettato**
  (`**label:**`), ripetendo il contesto condiviso (è ciò che dà senso a `d`/`r`). Gli stati
  **ACCRETIVI** (load-more/accordion che solo AGGIUNGE — non nasconde nulla) contribuiscono
  solo i blocchi first-seen, una volta: **niente blow-up del load-more** (il difetto reale
  del modello a intersezione pura, corretto qui). Ancoraggio + salto ancore deboli (`---`) +
  ordinamento per `order` = generalizza #24/#27 (tab/viste app invariati).
- **`states()` — record FEDELE per-stato**: ogni snapshot ricostruito verbatim dallo store.
  Esposto su `revealAll` → `page.states` (solo se >1 stato) → scritto su disco in
  `states/<pagina>.md` (una sezione `## State: <label>` per stato) via `assembleStates`
  (layout.mjs/output.mjs). Fuori dal manifest; layout di default invariato quando non ci
  sono pagine multi-stato.

**Verificato:** 222 test offline verdi (7 nuovi: esempio esatto `A,b,c/A,b,d/r,b,d` →
frame `b` una volta + gruppi etichettati; `states()` ritorna i 3 snapshot interi; load-more
a 3 stati senza duplicati; `assembleStates` scrive solo pagine multi-stato / verbatim; +2
dedup — catture byte-identiche collassate ma distinti tenuti / pagina sottile → nessun file).
I test esistenti di #24/#27 (tab adiacenti, order, ancora debole, load-more) passano
**invariati**. ✅ **Confermato dal vivo (2026-07-05)** su vuetifyjs.com (run no-AI): il
consolidato è compatto e corretto (`# useGoTo API` una volta pur con 29 catture); le varianti
VERE (carousels/date-pickers) restano intere.

**Follow-up dedup `states/` (2026-07-05).** La verifica dal vivo ha scoperto l'incrocio
#28×#29: i click di chrome (#28 — tema/login/tab che aprono solo un menu) catturano stati
EGUALI al base; `states()` li registrava TUTTI → i file `states/` erano al **90% duplicati**
(11.824 sezioni → 1.184 uniche; 280 file su 500 con stati tutti identici; 78 MB), e il gate
`>1` scriveva un file anche per pagine a stato-di-contenuto singolo. Fix deterministico (zero
AI, nessun contenuto perso): `states()` collassa gli snapshot **byte-identici** (firma = lista
ordinata di key-hash di contenuto) tenendo il primo → i gate `>1` in crawl-page/layout
diventano "distinti >1". Il click resta comunque in `activity.json`; il consolidato (`_render`)
e il loop di reveal NON sono toccati. **Ri-verificato dal vivo** (run `20260704-231000`, no-AI):
500→**212** file, 11.824→**842** sezioni (**0 ridondanti**), 78→**4,6 MB**, `en-api-use-go-to.md`
non più generato. File: `src/extract.mjs` (`states()`), `src/lib/layout.mjs` (header "distinct"),
commenti in `reveal.mjs`/`crawl-page.mjs`, `test/extract.test.mjs`.

**File:** `src/extract.mjs` (`BlockAccumulator`: `_states`/`store`, `add`, `_render`,
`toMarkdown`, `states`), `src/engine/reveal.mjs` (ritorna `states`), `src/engine/crawl-page.mjs`
(`page.states`), `src/lib/layout.mjs` (`assembleStates`), `src/lib/output.mjs` +
`src/lib/runs.mjs` (scrittura `states/`), `index.d.ts` (`RevealState`, `Page.states`),
`test/extract.test.mjs` + `test/layout.test.mjs`.

---

## Riferimenti (ricerca)

- Crawl4AI — Adaptive Crawling: https://docs.crawl4ai.com/core/adaptive-crawling/
- Focused crawling (PDD, arXiv): https://arxiv.org/pdf/1411.4366
- Near-duplicates (Manku, Google): https://research.google.com/pubs/archive/33026.pdf
- Trafilatura evaluation: https://trafilatura.readthedocs.io/en/latest/evaluation.html
- Web content extraction comparison (SIGIR 2023): https://dl.acm.org/doi/pdf/10.1145/3539618.3591920
- browser-use — interactive element detection: https://deepwiki.com/browser-use/browser-use/5.3-interactive-element-detection
- Skyvern — vision perception: https://www.skyvern.com/blog/how-skyvern-reads-and-understands-the-web/
- Ollama structured outputs: https://www.glukhov.org/llm-performance/ollama/llm-structured-output-with-ollama-in-python-and-go/
- Anthropic prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Google — HTTP caching: https://developers.google.com/search/blog/2024/12/crawling-december-caching
- Firecrawl FIRE-1: https://www.firecrawl.dev/blog/launch-week-iii-day-2-announcing-fire-1
- Jina ReaderLM-v2: https://jina.ai/news/readerlm-v2-frontier-small-language-model-for-html-to-markdown-and-json/
- Context7 (concorrente refdna, MCP docs): https://github.com/upstash/context7
- RAG chunking best practices (Weaviate): https://weaviate.io/blog/chunking-strategies-for-rag
- RAGAS — faithfulness / context recall: https://www.confident-ai.com/blog/rag-evaluation-metrics-answer-relevancy-faithfulness-and-more
- Estimating Absolute Web Crawl Coverage (arXiv): https://arxiv.org/html/2603.15416
- Small vs large LLM (classification): https://arxiv.org/html/2510.21443v1
- llms.txt — stato adozione 2025: https://llms-txt.io/blog/is-llms-txt-dead
- Firecrawl /extract (task-driven, schema/prompt): https://www.ycombinator.com/launches/Mcn-extract-by-firecrawl-get-structured-website-data-with-just-a-prompt
- ScrapeGraphAI (LLM scraping da prompt): https://github.com/ScrapeGraphAI/Scrapegraph-ai
- SWDE — benchmark estrazione strutturata cross-sito: https://github.com/EleutherAI/lm-evaluation-harness/blob/main/lm_eval/tasks/swde/README.md
- Task Mode — filtraggio task-specifico (arXiv): https://arxiv.org/pdf/2507.14769

---

_Ultimo aggiornamento: 2026-07-04 — #29 reveal "compatto ma strutturato" + record
fedele per-stato FATTO: il `BlockAccumulator` non fonde più gli stati in un elenco
piatto (che orfanava `d`/`r` e buttava lo snapshot). Ora conserva ogni stato,
`toMarkdown` rende la cornice condivisa una volta + i frammenti che cambiano
raggruppati ed etichettati per stato (accretive/load-more senza duplicati), e
`states()` espone il record FEDELE per-stato (verbatim) scritto su disco in
`states/<pagina>.md`. Deterministico, zero AI, #24/#27 invariati (220 test verdi).
In precedenza, stesso giorno: #28 copertura totale dei cliccabili FATTO:
i controlli JS della site chrome (nav/header/footer) — un SPA top-nav o app rail
che scambia la vista senza URL, "prima mancava il nav" — sono ora percepiti
(perceive scandaglia il body dopo il main, main-first) e cliccati, restando
UNIVERSALE e identico in `--no-ai`; il contenuto prende sempre il budget per primo
(penalità `chrome` in `revealPriority`), i `<a href>` di nav restano link, e il
riuso id consent↔revealer evita di rompere la dismissione cookie (215 test verdi).
In precedenza, stesso giorno: #26 recupero heading per peso visivo FATTO:
i titoli che le app marcano solo VISIVAMENTE (card/sezioni con font più grande o
bold, mai `<h*>`) diventano `##`/`###`/`####` deterministicamente — marcatura
in-browser (computed styles, atomica con data-crawldna-hidden in captureHtml) +
gemello Node sugli stili inline per il path statico, segnale a rapporto di font
(mai una classe), h* reali mai toccati, zero chiamate modello (identico in
`--no-ai`). Verificato dal vivo su vuetifyjs.com/en: "Summary"/"Transactions"/
"Recent Orders" → `###`, `#### Component Gallery` intatto, bullet e tabelle #25
invariati (207 test verdi). Prima, stesso giorno: #24 fedeltà di layout dell'.md
+ #25 app incorporate (feedback run Vuetify): merge ancorato delle varianti
reveal (in posizione, marker visibili), pruning link-density site-aware, cleanup
fence-aware, nav-in-main per le viste delle app (Analytics/Chat/Settings
raggiunte), futility guard misurata sul budget, liste ARIA/shaped-row a bullet,
tabelle GFM a riga singola con dedup order-insensitive (verificato dal vivo).
In precedenza: 2026-07-03 — sessione Gruppo D completata: #20 `mode`
esplicito, #21 reveal a ciclo chiuso, #22 tier embeddings e #14 politeness+anti-bot
TUTTI FATTI (176 test offline verdi). La task non pilota più il motore, il reveal
esce su una MISURA, il ranking è semantico/multilingua con `embedModel` (zero
chiamate con noAi), e una pagina-sfida non finisce mai nell'output. Bug reali
corretti lungo la strada: `direction:null→0` in aiPlanNavigation, shadowing TDZ in
fetchText. Item aperti rimasti: #6 crawl incrementale → #18 packaging npm → #9
accessibility-tree. In precedenza: 2026-07-02 sessione architetturale — regola #6,
no-AI #19 — e revisione ingegneristica #13–#18.
crawldna è uno strumento GENERALE (refdna è solo un consumatore) — vedi
"Posizionamento". Aggiorna lo "Stato" (☐ → ✅) man mano che implementi, e segna le
decisioni prese sotto ogni item._
