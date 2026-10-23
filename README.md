# Active Memory · samostatný projekt v0.1.0

Osobní paměť nezávislá na konkrétním chatbotu nebo agentovi. Uchovává zdroje,
staví mapu témat a myšlenek napříč konverzacemi a vrací vybraný kontext ostatním systémům.
janAGI je jeden z klientů. Není potřeba k instalaci, provozu ani správě paměti.

Repo: [HonzaHezina/ContextMesh](https://github.com/HonzaHezina/ContextMesh) (název produktu a Python balíčku zůstává Active Memory).

**Začni souborem [START_HERE.md](START_HERE.md).** Zadání prvního vývojového běhu je
v [docs/AGENT_START_PROMPT.md](docs/AGENT_START_PROMPT.md).

## Principy, které projekt drží

- Jedna osobní paměť v jedné instanci. Firemní paměť a propojování domén odkládáme.
- Zdrojová konverzace není konečné členění paměti. Jedna myšlenka může procházet více chaty.
- Vedle faktů existují Thought, Theme, Question, Goal a Decision.
- Opakování posiluje aktivitu tématu, nikoli pravdivost tvrzení.
- Interpretace má stav `candidate`, člověk ji může potvrdit nebo odmítnout.
- Každá odvozená položka má původní zprávu a přesnou citaci. Text asistenta není automaticky fakt.
- Zdroje zůstávají u vlastníka paměti; konkrétní model a poskytovatele lze nastavit samostatně.
- IAM zůstává rozhraním pro pozdější Keycloak, Entra nebo MidPoint. Žádnou variantu nezamykáme.

## Co již tento základ umí

REST API, MCP stdio bridge, Python klient, idempotentní ingest, trvalá fronta s opakováním,
zdrojové zprávy, explicitní návrhy extrakcí i volitelná LLM extrakce, graf témat,
počítání četnosti napříč chaty, aktivita s časovým útlumem, ruční schválení,
vazby ABOUT/SUPPORTS/REFINES/CONTRADICTS/SUPERSEDES, vyhledávání a sestavení kontextu
s citacemi a limitem znaků. Uchovává explicitní časovou platnost `[valid_from, valid_to)`.
Obsahuje živé smazání zdroje, export, audit operací, Docker/Coolify konfigurace a CI.
Verzovaný log událostí ([EVENTS.md](docs/EVENTS.md)) a jednostránkové webové UI na `/ui`: konverzace jako chat, fronta kandidátů
ke schválení, graf (3D výchozí, plošný jako záložní), témata, časová osa, nastavení modelu (Gemini, Mistral, OpenAI, Ollama) a volitelné rady modelu (jen doporučení, rozhoduje člověk).
Konverzace se dostanou dovnitř:
- importem exportu ChatGPT (`scripts/import_chatgpt_export.py`) a sessions Claude Code (`scripts/import_claude_code.py`),
- vložením textu v UI (rozdělení podle značek mluvčích, u textu bez značek ruční určení po odstavcích) nebo nahráním JSON exportu (ChatGPT, claude.ai, Google Takeout Gemini, pole zpráv z API OpenAI/Anthropic/Gemini; formáty zatím jen na syntetických vzorcích),
- MCP nástrojem `memory_save_conversation` (lokální stdio), REST API nebo normalizovaným JSONL (`scripts/import_jsonl.py`).

V UI lze konverzaci znovu projít modelem (jen přírůstkově) nebo smazat. Skriptový export Mistral a Copilot Chat zatím chybí, viz [INTEGRATIONS](docs/INTEGRATIONS.md) a [BACKLOG](docs/BACKLOG.md).
Návrhy vazeb mezi myšlenkami z různých chatů (vždy `candidate` se zdroji) a webový prohlížeč mapy na `/ui`
(témata, zdroje s citací, schvalování) viz [STATUS](docs/STATUS.md) a [EVALUATION](docs/EVALUATION.md).

**Je to funkční vývojový základ, ne hotový produkční produkt.** Stav a omezení jsou přesně
v [docs/STATUS.md](docs/STATUS.md). Automatické sémantické slučování myšlenek,
plnohodnotné dreaming/konsolidace a vizuální editor jsou další práce pro agenta.

## Dva režimy

| Režim | Účel | Úložiště významové paměti | Model |
|---|---|---|---|
| `reference` | Spuštění, demo, testy bez Neo4j | lokální JSON graf; lexikální hledání | žádný; ingest s dodanými návrhy |
| `neo4j` | Cílový základ nasazení | nativní graf Neo4j; volitelně Graphiti fakta a vektory | volitelná LLM extrakce a Graphiti |

SQLite je **pouze deník původních zpráv, fronta a provozní audit**. Neobsahuje vektory,
embeddingy ani tabulkovou náhradu významového grafu. PostgreSQL/pgvector ani janAGI nejsou závislosti.
JSON adapter není náhradou Graphiti, neurčuje sémantickou podobnost ani implicitní změny faktů.

## Lokální start

Python 3.12, doporučeně `uv`. V kořeni repozitáře:

```bash
uv sync --frozen --extra dev
cp .env.example .env
uv run active-memory init
uv run active-memory serve
```

Na Windows místo `cp` použij `Copy-Item .env.example .env`; podrobný postup je v START_HERE.
Příkaz `init` vypíše tvůj token. Ten se nepřidává do Gitu.
API: `http://127.0.0.1:8080`, dokumentace: `/docs`, schema: `/openapi.json`.
Zdraví: `/healthz`, připravenost úložišť: `/readyz`.

V dalším terminálu nastav `MEMORY_CLIENT_API_KEY` na vypsaný token a spusť:

```bash
uv run python scripts/demo.py
uv run pytest -q
```

Demo používá smyšlené konverzace, schválí pouze jejich návrhy a vypíše mapu a kontext.
Při dodaných návrzích lze pracovat i bez jakéhokoliv poskytovatele LLM.

## Docker a cílový graf

Nejdřív vytvoř `.env` a `config/clients.json` pomocí `init`.

```bash
docker compose up -d --build
```

Pro Neo4j nastav `MEMORY_NEO4J_PASSWORD` v `.env` a použij:

```bash
docker compose -f compose.yaml -f compose.graph.yaml up -d --build
```

Přechod reference → Neo4j existující JSON graf automaticky nemigruje; pro demo použij čistou
instanci. Migrace přes export/replay je navazující úkol, viz backlog.
Zapnutí automatické extrakce: `MEMORY_EXTRACTION_MODE=llm`, `MEMORY_ALLOW_MODEL_CALLS=true`
a konfigurace modelu. Zapnutí Graphiti navíc: `MEMORY_GRAPHITI_ENABLED=true`, embedder a instalace
`uv sync --frozen --extra graphiti --extra dev`. Docker image Graphiti dependency již obsahuje.

## Nasazení na server (Hetzner / Coolify)

Hotový `compose.coolify.yaml` (API + Neo4j). V Coolify nastav povinně `MEMORY_API_KEY` (min. 24 náhodných znaků, je to zároveň token pro přihlášení do UI)
a `MEMORY_NEO4J_PASSWORD`, doménu přiřaď jen službě `memory` na portu 8080. UI je na `/ui`, kontrola na `/readyz`. První nasazení proběhlo
2026-10-19; postup, poznatky a chyby jsou v [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Model calls jsou ve výchozím stavu vypnuté: zprávy se uloží
jako zdroje, ale uzly a návrhy do grafu vzniknou až po zapnutí extrakce. Data ze svého počítače nahraješ skripty v `scripts/`
(`MEMORY_API_URL`, `MEMORY_CLIENT_API_KEY`). Než zapneš veřejný provoz, nastav limity na proxy; aplikační limity a IAM jsou v backlogu.

## Dokumentace

| Soubor | Obsah |
|---|---|
| [START_HERE.md](START_HERE.md) | vytvoření vlastního GitHub repa, Windows/Linux start, předání agentovi |
| [AGENTS.md](AGENTS.md) | pravidla pro všechny vývojové agenty |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | hranice služeb, tok dat, cílové rozšíření |
| [docs/MEMORY_MODEL.md](docs/MEMORY_MODEL.md) | témata, myšlenky, interpretace, čas, provenance |
| [docs/API.md](docs/API.md) | REST kontrakt a MCP nástroje |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | janAGI, OpenClaw/Hermes, n8n, MCP, importy |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Coolify, Hetzner, provider konfigurace |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | klíče, záloha, obnova, smazání, chyby |
| [docs/BACKLOG.md](docs/BACKLOG.md) | pořadí implementace a podmínky přijetí |
| [docs/STATUS.md](docs/STATUS.md) | ověřené vlastnosti a přesné mezery |
| [docs/VALIDATION.md](docs/VALIDATION.md) | provedené kontroly a jejich výsledky |
| [docs/EVENTS.md](docs/EVENTS.md) | kontrakt událostí v1 a audit |
| [docs/EVALUATION.md](docs/EVALUATION.md) | český eval dataset a baseline |

Repo nyní zveřejňuje jen kód a syntetické příklady, nikoli osobní paměť.
Licence vlastního produktu zatím není deklarována; licence třetích komponent zůstávají jejich vlastní. Zdrojové podklady:
[Graphiti 0.30.2](https://pypi.org/project/graphiti-core/0.30.2/),
[Graphiti](https://github.com/getzep/graphiti), [MCP SDK v1](https://py.sdk.modelcontextprotocol.io/v1/).
