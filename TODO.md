# sagecrawl — TODO miglioramenti

> Backlog di miglioramenti **allineati alla filosofia del progetto**, pensato per
> essere lavorato un pezzo alla volta nelle sessioni future. In una nuova sessione
> basta dire: _"apri TODO.md e implementiamo il #N"_.
>
> Fonti: revisione approfondita (2026-06-30) di concorrenti (Crawl4AI, Firecrawl/
> FIRE-1, Skyvern, browser-use) + ricerca accademica, incrociata col nostro codice
> (item #1–#12); revisione ingegneristica integrale del codice (2026-07-02, Claude
> Fable) → correzioni applicate + item #13–#18 (vedi la sezione "Revisione
> ingegneristica completa — 2026-07-02").
> Vedi anche [ARCHITECTURE.md](ARCHITECTURE.md) e [build-spec.md](build-spec.md).

---

## Posizionamento (cosa È sagecrawl)

sagecrawl è uno **strumento generale e autonomo**, utile a chiunque — non un pezzo di
refdna. Il suo valore, per qualsiasi utente e qualsiasi sito:

1. **Estrae tutto, anche il nascosto/dinamico** (il reveal: tab, accordion, "load more",
   wizard, contenuto lazy). È il differenziatore.
2. **Segue una task generica QUALSIASI e la rispetta** ("la documentazione", "il menù
   delle pizze", "i prezzi", "gli orari") → tiene solo ciò che la task chiede.
3. **Output pulito, senza roba inutile**, e **fedele** (verbatim nel crawl; ogni
   trasformazione è Fase 2/reshape).

**refdna è SOLO UNO dei consumatori** (userà sagecrawl per il caso "documentazioni").
Le scelte di design vanno valutate sul tool **generale**, non su refdna. Differenza dai
concorrenti task-driven (Firecrawl `/extract`, ScrapeGraphAI): loro **trasformano** la
pagina nei campi di uno schema; sagecrawl tiene **tutto il pertinente, verbatim** — non
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
| 6 | Crawl incrementale (ETag / Last-Modified / lastmod) | consumi (enorme per refdna) | Medio | ☐ da fare |
| 7 | Dedup near-duplicate con SimHash | precisione output + consumi | Medio | ✅ fatto (2026-07-01, opt-in) |
| 8 | Estrazione stile Trafilatura (pruning per densità link) | precisione | Medio | ✅ fatto (2026-07-01) |
| 9 | Rinforzo reveal: accessibility-tree / Set-of-Marks | precisione (casi difficili) | Alto | ☐ da fare |

**Gruppo B — Rispetto della task & fruibilità dell'output (generale)**

| # | Titolo | Effetto | Sforzo | Stato |
|---|--------|---------|--------|-------|
| 10 | Output per-documento identificabile + metadata (opzione) | fruibilità | Medio | ✅ fatto (2026-07-01) |
| 11 | Reshape (Fase 2): fedeltà verificata | rispetto-task | Medio | ✅ fatto (2026-07-02) |
| 12 | Harness di misurazione (completezza / rispetto-task / token) | trasversale — abilita tutto | Medio | ✅ fatto (2026-07-01, da verificare dal vivo) |

**Gruppo C — Affidabilità & operazioni** (dalla revisione ingegneristica 2026-07-02)

| # | Titolo | Effetto | Sforzo | Stato |
|---|--------|---------|--------|-------|
| 13 | Persistenza incrementale + resume del crawl | affidabilità (crash ≠ perdita totale) | Medio-Alto | ☐ da fare |
| 14 | Politeness opt-in (delay per host + robots.txt) | affidabilità / reputazione | Basso-Medio | ☐ da fare |
| 15 | Render-wait: response-quiet al posto di `networkidle` | tempo (−secondi fissi per pagina) | Basso-Medio | ☐ da fare |
| 16 | Budget/ranking per le route minate dai JS | consumi (token gate `links`) | Basso | ☐ da fare |
| 17 | CI GitHub Actions (suite offline a ogni push) | qualità continua | Basso | ✅ fatto (2026-07-02) |
| 18 | Packaging npm (playwright peer-optional, metadata repo) | fruibilità libreria | Basso | ☐ da fare |

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
**Effetto:** consumi (enorme per refdna) · **Sforzo:** Medio · **Stato:** ☐

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
**Effetto:** precisione output + consumi · **Sforzo:** Medio · **Stato:** ✅ FATTO (2026-07-01, opt-in)

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
**Effetto:** precisione (casi difficili) · **Sforzo:** Alto · **Stato:** ☐

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
>   quote firmato sagecrawl, strippabile meccanicamente), `fidelity` per-file nel risultato/
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
> sul run Vuetify esistente (`sagecrawl reshape 20260701-095045-c57db0 --ask "dammi i props
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
   gli id `data-sagecrawl-id` ripartivano da 0 a ogni passata SENZA pulire quelli
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
**Effetto:** affidabilità (un crash non perde più nulla) · **Sforzo:** Medio-Alto · **Stato:** ☐

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
- `sagecrawl resume <runId>`: ricostruisce `visited` + dedup-hashes dalle pagine già
  salvate, ri-semina la frontiera (sitemap/entry) e completa il run.
- Il contratto libreria NON cambia: senza `save`/`cacheDir` tutto resta in memoria.

**Criterio di accettazione.** `kill -9` a metà di un crawl di riferimento → le pagine
già estratte sono su disco e leggibili; `resume` completa e l'output finale è
identico (stesso set di pagine) a un run mai interrotto. Zero scritture quando il
salvataggio è off.

**File:** `src/lib/runs.mjs`, `src/lib/output.mjs`, `src/index.mjs` (addPage/finally),
`bin/cli.mjs`, `ui/server.mjs` (esporre resume).

---

## #14 — Politeness opt-in (delay per host + robots.txt)
**Effetto:** affidabilità / reputazione · **Sforzo:** Basso-Medio · **Stato:** ☐

**Problema oggi.** Nessun rate-limit per host e nessuna lettura di robots.txt:
concurrency 4 × reveal martella qualsiasi sito. Per un tool pubblicato su npm è un
rischio doppio: ban/429 dal sito (= contenuto perso, contro la regola #1) e cattiva
reputazione del progetto.

**Proposta.** Due opzioni indipendenti, entrambe **opt-in** (il tool resta
user-directed come wget):
- `--delay <ms>`: distanza minima tra richieste allo STESSO host (frontiera e fetch).
- `--respect-robots`: legge `Disallow`/`Crawl-delay` e salta gli URL vietati **con
  warning** (mai in silenzio — il warning è il contratto).

**Criterio di accettazione.** Con delay attivo le richieste same-host distano ≥ delay
(misurabile dai log); con robots on gli URL disallowed compaiono come warning e non
come pagine; con entrambe off il comportamento è identico a oggi.

**File:** `src/index.mjs` (frontiera), `src/lib/fetcher.mjs`, nuovo `src/lib/robots.mjs`.

---

## #15 — Render-wait: response-quiet al posto di `networkidle`
**Effetto:** tempo (−secondi FISSI per pagina sui siti con analytics) · **Sforzo:** Basso-Medio · **Stato:** ☐

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
**Effetto:** consumi (token del gate `links`) · **Sforzo:** Basso · **Stato:** ☐

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
> `BogdanVasaiu/sagecrawl`; quando si configura il remote (vedi #18, repository/
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
**Effetto:** fruibilità come libreria · **Sforzo:** Basso · **Stato:** ☐

**Problema oggi.** `playwright` è in `optionalDependencies`: npm lo SCARICA comunque
(~50MB) a ogni `npm install sagecrawl`, anche per un consumer che usa solo la via
statica/llms-full. Mancano `repository`/`homepage` nel package.json (il remote GitHub
non è ancora configurato).

**Proposta.** Decisione di prodotto, due strade documentate:
- (a) passare a `peerDependencies` + `peerDependenciesMeta: { playwright: { optional:
  true } }` → install leggero, il README già spiega `npx playwright install chromium`;
- (b) restare così per l'esperienza out-of-the-box.
  In ogni caso aggiungere `repository`/`homepage`/`bugs` quando il repo è pubblico.

**Criterio di accettazione.** Un consumer statico installa sagecrawl senza scaricare
Playwright (se si sceglie (a)); `npm publish --dry-run` pulito.

**File:** `package.json`, README (sezione Install).

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

_Ultimo aggiornamento: 2026-07-02 (revisione ingegneristica: verbale correzioni +
item #13–#18). sagecrawl è uno strumento GENERALE (refdna è solo un consumatore) —
vedi "Posizionamento". Aggiorna lo "Stato" (☐ → ✅) man mano che implementi, e segna
le decisioni prese sotto ogni item._
