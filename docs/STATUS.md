# Stav dodaného základu · 2026-10-14

Poslední milník: jednostránkové UI (konverzace, fronta ke schválení, graf, témata, časová osa s filtrem období, nastavení modelu), rady modelu,
předvolby poskytovatelů a tři cesty, jak dostat konverzace dovnitř: vložení textu, MCP nástroj `memory_save_conversation` a skript pro export ChatGPT.
Dříve: kontrakt událostí v1 ([EVENTS.md](EVENTS.md)), fronta kandidátů a časová osa.
Dříve: AM-004 UI hotové (`/ui`); AM-001 stack test připraven (Neo4j lokálně ověřen, Docker/Graphiti čeká na CI/klíče); AM-002 hotovo (dataset + baseline, [EVALUATION.md](EVALUATION.md)); AM-003 implementováno a testováno s deterministickými/mockovanými signály, **kvalita embeddingů a judge na češtině neměřena**.

## Implementace

| Oblast | Stav |
|---|---|
| Nezávislý Python projekt, public REST, Python SDK | implementováno |
| MCP stdio read tools + write opt-in | implementováno, discovery test; wire smoke viz VALIDATION |
| Raw zdroje a idempotence, queue/retry, audit, export | implementováno |
| Reference persistent graf | implementováno, behavior testy |
| Neo4j native active-map adapter | implementováno; živý Neo4j roundtrip prošel v GitHub Actions |
| Graphiti adapter 0.30.2, oddělený model/embedder | implementováno; constructor/contract test; stack test (ingest→UUID→search→restart→delete/rebuild) napsán, **nespuštěn s modelem** |
| Stack integrační test (Neo4j, bez modelu) | prošel lokálně proti reálnému API procesu + Neo4j 5.26.31; Compose varianta jen v CI (zatím nespuštěna) |
| User LLM structured extraction, přesné citace | implementováno; lokální mocked failure/success testy; kvalita modelu neměřena |
| Theme recurrence, exact identity, activity/decay | implementováno |
| Pevný CZ eval dataset + baseline (48 scénářů) | implementováno (AM-002); LLM režim evalu nespuštěn |
| Návrhy ALIAS_OF/SUPERSEDES, lexikální + grafové signály, candidate se zdroji | implementováno (AM-003); offline baseline: 2 návrhy, oba správné, recall 2/17 |
| Návrhy přes embeddingy a LLM soudce (SUPPORTS/REFINES/CONTRADICTS) | implementováno za `similarity_mode=embedding` / `judge_enabled`; testováno jen s fake embedderem/soudcem a mockem HTTP; **reálná kvalita neměřena** |
| Potvrzený alias: seskupení (`clusters`) bez slučování uzlů, vratné | implementováno, testováno |
| Review kandidátů a explicitní temporal intervals | implementováno, current/historical test |
| SUPPORTS/REFINES/CONTRADICTS/SUPERSEDES | explicitní link API; automatické odvozování a interval closure v backlogu |
| Kontext s reviewed sources a budgetem znaků | implementováno; zatím lexical + 1-hop active graph |
| Full hybrid context assembly | Graphiti facts separátně v search; společný context v backlogu AM-011 |
| Deterministická konsolidace counts/activity | implementováno |
| Autonomní dreaming/semantic clustering | backlog AM-005; není hotové |
| Kontrakt událostí v1 nad provozním auditem, `GET /v1/events`, MCP `memory_list_events` | implementováno; append-only přes službu + SQLite triggery; **graf a SQLite nejsou atomické** (viz EVENTS.md) |
| Rady modelu u návrhů (AM-021): `POST /v1/recommendations/run`, událost `candidate.recommended`, filtr a panel ve frontě | implementováno: jen rada (stav nikdy nemění), důvod mimo log a mazaný se zdrojem, zastaralost při nové evidenci, měření shody s člověkem; ověřeno testy a v Chrome proti **falešnému** poskytovateli; **kvalita rad skutečného modelu neměřena** |
| Předvolby poskytovatelů (Gemini, Mistral) s modely podle činnosti, embeddingy ve výchozím stavu u stejného poskytovatele a klíče, `advice_model`, záložní JSON režim | implementováno; názvy modelů a ceny z dokumentace poskytovatelů k 2026-10-13; **volání skutečných API nezkoušeno**, kompatibilita schématu a kvalita češtiny neověřeny |
| Nastavení modelu v UI (`/v1/settings`, pohled Nastavení), nápověda a uvítání | implementováno: admin, klíče write-only, souhlas s odesláním, test spojení s vymyšleným textem, perzistence; ověřeno testy a v headless Chrome proti **falešnému** poskytovateli; **skutečný Gemini/Mistral nezkoušen**, kvalita extrakce na češtině neměřena |
| Pohled Graf: 3D výchozí (3d-force-graph 1.80.1 / Three.js, WebGL, MIT, přibalený v `ui/`, bez CDN) a plošný Cytoscape.js 3.30.2 (přepínač; plošný i při chybějícím WebGL) | implementováno: jedna konverzace nebo téma, max. 60 uzlů, kandidáti žlutě / potvrzené zeleně (plošně čárkovaně); velikost uzlu podle počtu vazeb; najetí/výběr zvýrazní uzel a sousedy, zbytek ztlumí (3D i plošně); přetažený uzel v 3D zůstane; tlačítko Vystředit; filtry „Konverzace“ a „Jen potvrzené“; popisky jsou vlastní prvky s `textContent`, tooltip knihovny vypnut (vkládá HTML); vložení stylů knihovnou ve vendorované kopii vypnuto kvůli CSP; ověřeno v headless Chrome (swiftshader): kreslení, klik na uzel → detail, přepínání, mobilní šířka, konzole bez CSP chyb; vzhled a plynulost na skutečné GPU neposouzeny uživatelem; u velkého grafu jen zkrácený výběr |
| Jednostránkové UI s menu (Konverzace jako výchozí, Ke schválení, Graf, Témata, Návrhy vazeb, Časová osa) a propojením konverzace ↔ návrh ↔ mapa | implementováno; testy API, Node testy logiky, e2e v jsdom (přepínání pohledů, propojení, rozhodnutí); čtení konverzací je O(N) nad projekcí; **uživatelsky zkoušeno jen ručně v jednom prohlížeči, bez systematického testu** |
| Původ návrhu (dodaná extrakce / model / systém / ruční) | zaznamenán od zavedení auditu; starší kandidáti mají jen `candidate.snapshot` s neznámým původem |
| Webové UI pro myšlenkovou mapu (`/ui`) | implementováno (AM-004): témata, vývoj ve zdrojích, původní zpráva se zvýrazněnou citací, schvalování uzlů/vazeb, fronta návrhů; ověřeno jednotkovými testy logiky, testy hlaviček/CSP a e2e v jsdom; ověřeno v headless Chrome; uživatel ho ručně prohlížel a vyjádřil se k čitelnosti, systematický test použitelnosti neproběhl |
| JSONL import normalizovaných zpráv | implementováno |
| Vložení konverzace do UI (z Konverzací), MCP `memory_save_conversation` (stdio, jen s `MEMORY_MCP_ALLOW_WRITE=true`), skript `scripts/import_chatgpt_export.py` | implementováno; vložení ověřeno testy a v headless Chrome, MCP nástroj skutečným stdio klientem proti lokální instanci; skript jen na syntetickém souboru. **Přepis dělá model a nemusí být doslovný** (proto „přepsal asistent“ v názvu). Vzdálené MCP přes HTTPS pro webové chaty není (AM-025); s žádnou skutečnou chatovací aplikací to nezkoušeno |
| Vložení konverzace: značky z terminálu Claude Code (`> `, `● `), ruční rozdělení textu bez značek po odstavcích, vyprázdnění formuláře po odeslání | implementováno 2026-10-19; Node testy logiky; **v prohlížeči nezkoušeno, na serveru až po novém buildu/deployi**; automatické rozdělení textu bez značek nejde (nejsou signály), šum zkopírovaný z chatu („Ran a command“) se nefiltruje |
| Vložení/nahrání JSON exportu v UI (ChatGPT `conversations.json`, claude.ai `conversations.json`, Google Takeout Gemini „My Activity“, pole zpráv OpenAI/Anthropic/Gemini API) a testovací konverzace (`scripts/make_test_conversations.py` → `examples/test-conversations/`) | implementováno 2026-10-23; Node testy na syntetických souborech; **tvary formátů jsou ze znalosti struktury, ne z reálných exportů** (Gemini Takeout nemá id konverzace, seskupuje se po dnech; názvy polí mohou vendoři změnit); **v prohlížeči a na serveru nezkoušeno**; odešle se vše bez výběru konverzací |
| Konverzace v UI: „Znovu projít modelem“ (`POST /v1/conversations/{zdroj}/{id}/reprocess`, admin) a „Smazat konverzaci“ (`DELETE` téhož, admin, dvojí klik) | implementováno 2026-10-23, testy API (fake extraktor, oprávnění, smazání odvozených položek); **v prohlížeči nezkoušeno, skutečný model neměřen**. Znovu se projdou jen zprávy uživatele bez vlastní dodané extrakce (importy a vložení ji nemají); přírůstkové: stávající kandidáti a jejich stavy se nemění, přibudou jen nové; s Graphiti projekcí odmítnuto (409); bez nastaveného modelu 409. Smazání jede po zprávách (není atomické jako celek, při selhání zopakovat) |
| Import sessions Claude Code (`scripts/import_claude_code.py`, JSONL z `~/.claude/projects`) | implementováno; bere jen text uživatele a asistenta, bez tool calls; ověřeno suchým během (`--dry-run`) na skutečných souborech tohoto stroje, **nahrání na server nezkoušeno**; formát může Claude Code změnit; bez `--project`/`--all` nic neimportuje |
| Originální chatbot export connectors (Claude, Gemini, Mistral) jako skripty | backlog AM-010 / AM-023; v UI je import JSON (viz výše), Mistral export neznáme |
| Docker/Compose/Coolify/CI | Compose validace a image build prošly v CI; **první Coolify deploy na Hetzner proběhl 2026-10-19** (API i Neo4j nastartovaly, UI přístupné, vložení konverzace fungovalo); zálohy, limity proxy a model calls na serveru neověřeny. Nálezy viz DEPLOYMENT.md |
| Enterprise IAM/multi-tenant/security hardening | mimo základ; IAM interface/backlog zachováno |

## Rozdíl mezi implementací a cílem (2026-10-13)

Cíl: aktivní myšlenková mapa, kde se stejná myšlenka z různých chatů spojí i při jiném vyjádření, s dohledatelným zdrojem a lidským schválením. Dnes:

- Offline (bez modelu) se spojí jen téměř shodná formulace; parafráze vyžadují embeddingy a judge, které jsou implementované, ale na českých datech neprošly měřením (chybí klíče). Práh 0.6 pro embeddingy není kalibrován.
- Automatické typy SUPPORTS/REFINES/CONTRADICTS vznikají jen přes judge; SUPERSEDES i bez modelu z přesně navazujících intervalů.
- Kontext je lexical + 1-hop; neobsahuje důvod výběru ani Graphiti fakta (AM-011). `as_of` filtruje jen platnost tvrzení, ne to, co už uživatel v dané době napsal (14 takových položek v baseline).
- Dreaming je jen deterministická aktivita + návrhy vazeb (AM-005 neimplementováno). Graf (AM-015) je jen pohled na jednu konverzaci nebo téma, nejvýše 60 uzlů, bez vývoje v čase.
- Graphiti 0.30.2 s reálným modelem nebyl dosud spuštěn.

## Události a audit: přesné mezery

- Admin token neprokazuje, že rozhodl člověk (`actor.assurance=bearer_token`); jiné ověření neexistuje.
- Mezi změnou grafu a zápisem události není společná transakce. Selhání zápisu po potvrzení grafu se projeví jako `audit.consistent=false`
  a 503; opravu zapíše pravdivou událost ze záměru při startu, před dalším rozhodnutím a v nečinnosti workeru (`event_intents`). Bez záměru zbývá `candidate.snapshot`/`reconciliation`. Společná transakce grafu a SQLite stále není (AM-019 zbytek). Záměr kryje review uzlů i vazeb a ruční vazby (`candidate.created`); i automatické návrhy vazeb. Zpracování zdrojů záměr nepoužívá: graf se commituje první a události s označením hotového jobu jdou v jedné SQLite transakci; při selhání se job opakuje a idempotentní kontrola doplní chybějící události. Ověřeno testy s vynuceným selháním; pád procesu skutečně nezkoušen.
- Triggery chrání před chybou aplikace, ne před správcem databáze. Audit není podepsaný ani externě kotvený.
- `target_assistant` kontextu je vždy neznámý. Odběr událostí je jen dotazováním kurzorem (žádné SSE/WebSocket).
- Fronta počítá pořadí z auditu na každý dotaz (O(N) nad počtem kandidátů); pro velké grafy viz AM-006.
- Zdrojové zprávy nemají externí URL, proto UI žádné externí odkazy neukazuje.

## Praktické limity

Jeden proces a jeden osobní scope. Read client má přístup k celému tomuto scope.
Snapshot active graph načítá celý graf a při každé změně přepisuje projekci; před velkým datasetem
nutné AM-006. Queue 30min lease je jednoduchá recovery, ne distribuovaný scheduler.
Audit není immutable. SQLite/Neo4j transakce nejsou společné. Secret filter je minimální pattern
detekce, není kompletní DLP ani anonymizace. Model calls dnes nemají měřený finanční budget.

Aktivita se přepočítá při ingestu nebo explicitní maintenance/consolidate; automatický noční
scheduler není přidaný. Node review nic automaticky nepovažuje za schválené propojení.
Explicitní as_of v active graph funguje, inferred Graphiti history potřebuje lepší search filters/eval.
Model-compatible URL neznamená univerzální podporu každého modelu nebo UI chatbota.
Neo4j nemá DB-level scope marker; používá serverový scope a journal guard. V první fázi instaluj
jednu osobní memory do jednoho data setu a vlastního Neo4j resource.

## Ověření

Přesné provedené kontroly a jejich výsledky jsou v [VALIDATION.md](VALIDATION.md).
Při dalších změnách tento soubor aktualizuj a neoznačuj návrhy za hotové funkce.
