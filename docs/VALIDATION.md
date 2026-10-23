# Ověření před předáním · 2026-10-13

Provedeno v čisté projektové venv vytvořené pomocí `uv sync --frozen --extra dev --extra graphiti`.
Bez skutečných osobních dat a bez placených modelových volání.

| Kontrola | Výsledek |
|---|---|
| Zamčená instalace + editable build projektu | prošla |
| Ruff lint a format | prošly |
| Pytest behavior/contract suite | 19 passed, 2 skipped (live Neo4j/Graphiti) |
| Skutečný TCP start API, embedded worker, syntetický ingest | prošel |
| Demo mapa | 3 epizody ve 3 konverzacích, 3 uzly, 2 ABOUT vazby |
| Reviewed kontext | 3 položky, 2303 znaků, úplné citace |
| Export API | 3 živé zdroje |
| MCP stdio initialize + tools/list + tools/call přes oficiální klienta | prošlo, 4 read nástroje, context 3 položky |
| Graphiti 0.30.2 constructor + valid group ID + create-before-UUID-update | prošlo bez sítě, mock/contract test |
| LLM output quote validation | success i unsupported-quote failure ověřeny mockem |
| YAML/JSON syntax a interní markdown odkazy | staticky zkontrolováno |
| Git bundle a první commit | připraveno, bundle integrity verified |

Behavior testy zahrnují raw text včetně whitespace, idempotenci, změněný payload, role/práva,
scope injection rejection, přesné citace, candidate/rejected exclusion, znakový budget,
cross-conversation recurrence, různé claims se stejným labelem, current/historical validity,
source deletion, tombstone, restart s pending jobem, retry po backend failure a scope binding.

## Doplnění po nahrání do GitHubu

[GitHub Actions run 38407785368](https://github.com/HonzaHezina/ActiveMemory/actions/runs/38407785368)
pro commit `ba466480c1675e7f6c47d9e01f06bdc92a1a9d14` úspěšně ověřil:

- zamčenou instalaci, lint, formát a 19 testů (2 live opt-in testy v běžné sadě přeskočené),
- `docker compose config` pro reference a Neo4j overlay,
- Docker image build `active-memory:ci`,
- samostatný native Neo4j integration test: **1 passed**, 1 Graphiti test deselected.

První běh CI odhalil chybějící `.env` pro Compose validaci. Workflow nyní před kontrolou
vytvoří neprodukční `.env` z `.env.example`; obsah není ukládán do Gitu.
Graphiti inference, provider matrix a skutečný Coolify deploy stále neproběhly.
Placený Graphiti test zůstává explicitně opt-in. Lokální pracovní prostředí Docker daemon nemá;
Docker a Neo4j kontroly proběhly na GitHub runneru.

Příklad spuštění live Neo4j testu v místě, kde běží vlastní čistý testovací Neo4j:

```bash
export MEMORY_TEST_NEO4J=true
export MEMORY_TEST_NEO4J_URI=bolt://localhost:7687
export MEMORY_TEST_NEO4J_PASSWORD='TESTOVACI_HESLO'
uv run pytest -q tests/test_live_graph.py -k native
```

Graphiti test navíc potřebuje `MEMORY_TEST_GRAPHITI=true`, `MEMORY_TEST_MODEL_KEY`,
`MEMORY_TEST_EMBEDDING_KEY` a případně TEST_MODEL_URL/TEST_EMBEDDING_URL.
Pracuje se samostatným náhodným test scope. Může vyvolat modelové náklady, proto neběží implicitně.

## Běh 2026-10-13 (druhý, Windows pracovní stanice)

Bez Dockeru a bez modelových klíčů. Neo4j 5.26.31 Community byl spuštěn lokálně z oficiálního zipu (JDK 21).

| Kontrola | Výsledek |
|---|---|
| uv sync --frozen, ruff, ruff format, pytest | prošly; 19 passed, 4 skipped (opt-in) |
| 3D graf: reálný server (jiný port, vlastní datový adresář) + `demo_review_queue.py`, headless Chrome (puppeteer-core, swiftshader): WebGL canvas, popisky, klik na uzel otevře detail, přepnutí na plošný pohled a zpět, mobilní šířka 390 px bez vodorovného posunu, **konzole bez CSP chyb** (před vypnutím vkládání stylů knihovnou jich bylo 6) | prošlo; skript není v repu; plynulost na skutečné GPU a s velkým grafem neměřena |
| Reálný `active-memory serve` + `init` + `scripts/demo.py` | prošlo: 3 epizody, 3 uzly, 2 vazby, kontext 3 položky |
| `tests/test_live_graph.py -k native` proti lokálnímu Neo4j | 1 passed |
| `tests/test_stack_integration.py` (bez modelu, API subprocess + Neo4j): ingest, hotové joby, zdrojové UUID v mapě, restart API, restart, smazání, purge z Neo4j | 1 passed |

**Neověřeno:** Docker Compose varianta stack testu (`MEMORY_TEST_DOCKER=true`, CI job `docker-stack`;
override používá `!override`, tedy Compose >= 2.24) a Graphiti varianta
(`MEMORY_TEST_DOCKER_GRAPHITI=true`, CI job `graphiti-live`) – chybí Docker daemon resp. modelové klíče.
Zbývající krok: nastavit repo secrets `MEMORY_TEST_MODEL_KEY`, `MEMORY_TEST_EMBEDDING_KEY`
(volitelně vars `MEMORY_TEST_MODEL_URL`/`_NAME`, `MEMORY_TEST_EMBEDDING_URL`/`_MODEL`/`_DIM`) a spustit
workflow ručně s `graphiti_live=true`. Graphiti-only aserce (Episodic UUID, scoped facts, cizí group_id
přežije rebuild, žádný text smazaného zdroje v odvozeném grafu) nebyly dosud vykonány.

### AM-003 / AM-004 (lokálně, tentýž běh)

| Kontrola | Výsledek |
|---|---|
| pytest celé sady proti lokálnímu Neo4j (`MEMORY_TEST_NEO4J`, `MEMORY_TEST_STACK_URI`) | 50 passed, 2 skipped (Graphiti live) |
| ruff lint + format | lint prošel; format kromě dřívějšího `scripts/import_claude_code.py` (2026-10-23) |
| Live Neo4j: uložení a načtení návrhových hran včetně `rejected` | prošlo (`test_native_neo4j_persists_proposals_and_tombstones`) |
| UI e2e v jsdom proti reálnému API se seedem z eval datasetu: připojení, 19 témat, kandidát označen, detail, zdroj se zvýrazněnou citací, potvrzení uzlu, fronta návrhů (2), žádný script/img z dat, 0 JS chyb | prošlo (jednorázově, skript není v repu) |
| Wheel obsahuje `ui/*` | ověřeno `uv build --wheel`; Docker image s UI neověřen (CI) |

**Neověřeno:** vzhled a ovládání ve skutečném prohlížeči, embedding/judge kvalita na češtině,
Compose a Graphiti stack testy, `docker build` s novým package-data.

## Kontrakt událostí, fronta kandidátů a časová osa (2026-10-13)

| Kontrola | Výsledek |
|---|---|
| ruff lint + format | prošly |
| pytest s lokálním Neo4j (`MEMORY_TEST_NEO4J`, `MEMORY_TEST_STACK_URI`) | 89 passed, 2 skipped (Graphiti live) |
| `tests/test_events.py` (32 testů): schéma, původ a provenance, rozhodnutí s předchozím/novým stavem, idempotence review/ingestu/restartu, `expected_status` 409, 401/403 a oddělení read/write/admin, append-only (API i SQLite triggery), filtry, interval `[from,to)`, kurzorové stránkování při přibývání událostí, kontext (vč. nevydání při selhání zápisu), selhání grafu, selhání zápisu události po commitu grafu + rekonciliace po restartu, smazání zdroje bez obsahu, historická data jen jako snapshot | prošly |
| Node testy `tests/ui/*.test.js` (logika UI: bezpečné URL, formulace původu, povolení akcí, ověření po rozhodnutí, časová osa, neznámé typy) | prošly (spouští je pytest, je-li dostupný `node`) |
| Reálný server + `scripts/demo_review_queue.py` dvakrát | 8 zpráv, 19 kandidátů; druhé spuštění 0 nových zpráv a beze změny sekvence událostí |
| e2e v jsdom proti reálnému serveru (jednorázově, skript není v repu): read-only token (tlačítka zablokovaná s vysvětlením), admin načte frontu, detail zdroje se zvýrazněnou citací, potvrzení i zamítnutí s ověřením v auditu, tlačítka zablokovaná během požadavku a dvojklik pošle jediný požadavek, konflikt z jiného klienta → obnova a srozumitelná zpráva, odpojení smaže data, špatný token → 401 zpráva, žádný script/img z dat, 0 JS chyb | prošlo |
| Wheel nainstalovaný do čistého venv (`python -I`), server z něj obsluhuje `/ui`, `/ui/review*` | prošlo |

| Skutečný Chrome (headless, puppeteer-core, jednorázově, skript není v repu) proti reálnému serveru: připojení, přepínání všech pohledů, konverzace → graf, klik na uzel v canvasu, graf tématu, žádné `[object …]` v textu, mobilní šířka 390 px bez vodorovného posunu, odpojení, **konzole bez chyb a varování (CSP)** | prošlo; našel dvě chyby, které jsme v jsdom neviděli (inline `<style>` knihovny vs. CSP, zřetězení vnořených polí), obě opravené |

**Neověřeno:** vzhled posouzený člověkem, přístupnost čtečkou obrazovky a klávesnicí, Firefox/Safari; Docker image obsahuje UI
soubory (nový CI krok `Installed image serves its UI files` zatím neběžel, Docker tu není);
Compose a Graphiti stack testy; chování událostí s Graphiti rebuildem při mazání.

## UI, nastavení modelu, rady a vkládání konverzací (2026-10-14)

| Kontrola | Výsledek |
|---|---|
| ruff lint + format | prošly |
| pytest (bez Neo4j) | 130 passed, 7 skipped (2026-10-23, po přidání reprocess, smazání, názvů konverzací a názvů v grafu); dříve 126 passed, 5 skipped |
| Node testy `tests/ui/*.test.js` | 46 passed (2026-10-23, včetně názvů v grafu a importu JSON exportů na syntetických vzorcích z `examples/test-conversations/`) |
| Headless Chrome (puppeteer-core) proti reálnému serveru s **falešným** poskytovatelem: nastavení a předvolby (Gemini, Mistral), rady a filtr, uložení a smazání klíče, klíč se nikdy nezobrazí, vložení konverzace (rozdělení, změna mluvčího, odmítnutí hesla, opakování = 0 nových), filtr časové osy, zvýraznění menu | prošlo; konzole bez chyb (jen očekávané 422 při odmítnutém „heslu“) |
| MCP `memory_save_conversation`: skutečný stdio klient proti lokální instanci, dvakrát stejná konverzace | uloženo, podruhé 0 nových |
| `scripts/import_chatgpt_export.py` | jen 2 testy na syntetickém souboru |
| `scripts/import_claude_code.py --dry-run` na skutečných sessions tohoto stroje | 5 sessions, 217 zpráv k nahrání, ~1 560 položek (tool calls apod.) přeskočeno; role, časy a názvy konverzací zkontrolovány ručně; nahrání na server a testy skriptu chybí |

**Neověřeno:** skutečné volání Gemini a Mistralu (přijetí schématu `json_schema`, záložní JSON režim, kvalita češtiny a rad, rozměr Mistral embed 1024,
název Gemini embeddingu), formát skutečného exportu ChatGPT, MCP s reálnou chatovací aplikací, vzdálený MCP, Firefox/Safari, čtečka obrazovky,
Docker image s novými UI soubory a CI po posledních commitech (nic nebylo pushnuto).
