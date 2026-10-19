# Nasazení

## Lokální Docker

Po `uv run active-memory init` existuje `config/clients.json`. `.env.example` zkopíruj do `.env`.
`docker compose up -d --build` spustí reference režim. Port 8080 je bindovaný pouze na loopback.
API běží jako UID 10001, persist volume vlastní tento UID. Klientská konfigurace je read-only mount.

S Neo4j: nastav dlouhé náhodné `MEMORY_NEO4J_PASSWORD` a použij overlay `compose.graph.yaml`.
Neo4j 7474/7687 nejsou publikované. Do `.env` není potřeba měnit URI: overlay ji nastaví interně.
Neo4j používá user `neo4j`; pokud ho měníš, změň také NEO4J_AUTH v Compose.

## Hetzner / Coolify

Po úspěšném vytvoření GitHub repa:
1. V Coolify vytvoř resource z tohoto repa a `compose.coolify.yaml`.
2. Nastav `MEMORY_API_KEY` (min. 24 náhodných znaků), `MEMORY_NEO4J_PASSWORD`.
3. Scope ponech `personal:owner` nebo jednoznačný vlastní `personal:ID`.
4. Nastav HTTPS doménu **jen službě memory, port 8080**. Neo4j doménu ani veřejný port nedostane.
5. První boot udělej s model calls=false a provided extraction. Ověř readyz, auth a demo.
6. Vytvoř backup, potom případně povol model/provider extrakci.
7. Pro připojené asistenty vytvoř read/write klíče, ne sdílený owner token. V Coolify default fallback
   používá jeden owner token; pro další klíče nastav trvalý mount clients.json a jeho cestu.

Zkušenosti z prvního nasazení (2026-10-19):
- `memory` padá s `ValueError: configure clients.json or a MEMORY_API_KEY of at least 24 characters`, když je `MEMORY_API_KEY` v Coolify prázdný,
  kratší než 24 znaků nebo se nedostal do kontejneru za běhu (zkontroluj, že není jen build proměnná, a že hodnota nemá mezeru ani uvozovky).
- Neo4j warningy `UnknownPropertyKeyWarning` (`scope`, `payload`, `am`) v logu `memory` u prázdné databáze jsou normální; po prvním zápisu zmizí.
- Na `/` aplikace nic nemá (`{"detail":"Not Found"}`); UI je na `/ui`, kontrola na `/readyz` a `/healthz`. Přihlášení: token = hodnota `MEMORY_API_KEY`.
- Data ze svého počítače nahraješ skripty v `scripts/` s `MEMORY_API_URL=https://<doména>` a `MEMORY_CLIENT_API_KEY=<token>` (viz INTEGRATIONS.md).
  Změny UI se na serveru projeví až po commitu, pushi a redeployi v Coolify.
- Při `MEMORY_EXTRACTION_MODE=provided` se zprávy ukládají jako zdroje, ale uzly a návrhy z nich nevzniknou; k tomu je potřeba zapnout model.
- Testovací data: `examples/conversations.jsonl` přes `scripts/import_jsonl.py` (označena `synthetic-demo`); na ostrý server raději jen skutečná data.

Coolify služby sdílejí svoji Compose síť; není vyžadována externí síť jménem `coolify` ani janAGI.
Pokud použiješ odlišné routování/proxy labels ve své instalaci, přidej je lokálně podle ní.
Reverzní proxy má limitovat request body, request rate a timeout; před veřejným provozem dodělat
aplikační limity a IAM z backlogu. API payload limit je 50 000 znaků content, nikoli globální body limit.

## Modely a embeddings

| Nastavení | Význam |
|---|---|
| MEMORY_EXTRACTION_MODE=provided | žádné automatické LLM návrhy |
| MEMORY_EXTRACTION_MODE=llm | user message → active-map návrhy |
| MEMORY_ALLOW_MODEL_CALLS=true | explicitně zapne možnost posílat data modelu |
| MEMORY_GRAPHITI_ENABLED=true | user source → Graphiti temporal fact graph |
| MEMORY_MODEL_BASE_URL / API_KEY / NAME | inference i reranking |
| MEMORY_EMBEDDING_BASE_URL / API_KEY / MODEL / DIM | samostatný embedding provider |

Předvolby v UI (`PRESETS` v `settings.py`) byly 2026-10-19 porovnány s dokumentací. Gemini: adresa a modely (`gemini-3.5-flash-lite`, `gemini-3.8-flash`,
`gemini-embedding-001`) odpovídají; dokumentace nově uvádí i `gemini-4-argon` a `gemini-embedding-2-preview` (rozměr neuveden). Mistral: adresa a podpora
`json_schema` odpovídají, ale dokumentace u aktuálních modelů (Small 4 v26.03, Medium 3.5 v26.04, Large 4 v26.10, Mistral Embed v23.12) neuvádí přesné API názvy
ani rozměr embeddingu; `mistral-small-2603`, `mistral-medium-3-5` a `mistral-embed-2312` jsou odvozené a **neověřené**. Ověř je výpisem `GET /v1/models` se svým klíčem.

Local nebo hosted OpenAI-compatible endpoint lze nakonfigurovat. Graphiti adapter používá
OpenAIGenericClient, nikoli endpoint-specifický OpenAI Responses klient.
Active extractor vyžaduje JSON-schema structured output; pokud model neumí schema, job selže a
nevymyslí fallback fakta. Rozšíření kompatibility `json_object` se validací je úkol AM-007.
OpenRouter/Kimi/Qwen/GLM apod. nejsou v tomto balíčku kvalitou ani cenou ověřené.
Konfiguruj je až s konkrétním modelem, endpointem, strukturou a eval testem.

Při enabled Graphiti musí být nainstalované extra `graphiti`. Docker image jej obsahuje.
Graphiti telemetry je vypnutá. Concurrency SEMAPHORE_LIMIT=3 je startovní limit, ne záruka ceny/latence.
LLM i embeddings mohou odesílat části zpráv do různých služeb, podle uvedené konfigurace.

## Kapacita a versioning

Pro první instanci začni orientačně 4 vCPU, 8 GB RAM a SSD; změř RAM, ingest a retrieval na
svých objemech. Není to benchmark ani garantovaný sizing. Heap/pagecache zde mají startovní 1+1 GB.
Balíček obsahuje přesné direct verze, `uv.lock` pro dev a hashovaný `requirements.lock` pro Docker.
Base images mají konkrétní tagy, nikoli digest lock. Před provozním nasazením ověř existenci,
security updates, kompatibilitu a případně pin digest v daném registru.
Nespouštěj více API/worker procesů nad stejnou memory. Snapshot backend by přepisoval změny.
Neškáluj horizontálně před AM-006.

## Třetí strany v UI

`src/active_memory/ui/cytoscape.min.js` je přibalený Cytoscape.js 3.30.2 (licence MIT, text v `cytoscape.LICENSE`).
Nenačítá se z CDN (CSP povoluje jen `'self'`). Aktualizace: stáhnout konkrétní verzi z npm balíčku `cytoscape`,
nahradit soubor i licenci a spustit `pytest` a Node testy.

`src/active_memory/ui/3d-force-graph.min.js` je přibalený 3d-force-graph 1.80.1 (MIT, `3d-force-graph.LICENSE`; obsahuje Three.js a d3-force-3d, vše MIT/ISC).
Je to soubor `dist/3d-force-graph.min.js` z npm balíčku, **s jednou úpravou**: tři vložení inline `<style>` (`"undefined"!=typeof document){var i=document.head`
→ `0){var i=document.head`), protože CSP inline styly zakazuje; potřebná pravidla jsou v `app.css`. Při aktualizaci úpravu zopakuj (hlídá ji `tests/test_ui.py`).
Balík také obsahuje engine ngraph, který používá `new Function`; UI ho nikdy nevybírá (výchozí je d3), proto CSP bez `unsafe-eval` stačí.

## Připojení chatovacích aplikací

Dnes funguje jen lokální MCP most (stdio) a REST. Webové chaty (ChatGPT, Claude.ai) by potřebovaly vzdálený MCP přes HTTPS s vlastním
tokenem jen pro zápis a čtení (nikdy `admin`); ten zatím není implementován (AM-025). Které aplikace a tarify vzdálený MCP podporují, nebylo ověřeno.
