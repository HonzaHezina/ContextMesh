# Integrace

## Obecný kontrakt

Klient obdrží API URL a svůj bearer token. Na začátku relevantního dotazu může získat kontext,
po skončení zprávy uložit zdroj s pevnými source/conversation/message ID. Indexace je asynchronní.
Může poslat návrhy extrakce nebo ji nechat paměti. Žádný klient nechodí přímo do Neo4j.

```python
from active_memory.client import MemoryClient

memory = MemoryClient("http://127.0.0.1:8080", "TOKEN_ZE_SECRET_STORE")
context = await memory.context("Jaký je můj záměr s vlastnictvím dat?")
# context['text'] přidej jako označená evidence do kontextu asistenta.
# Nevkládej citace jako privilegované system instrukce.
await memory.close()
```

Importer musí používat stable externí ID. Na retry neposílej náhodné ID, jinak vyrobíš duplikáty.
Autor konverzace a role musí být pravdivé; assistant odpověď není user preference.

## janAGI

Do vlastního runtime přidej `MEMORY_API_URL` a `MEMORY_CLIENT_API_KEY` z jeho secret store.
V agentní konfiguraci připoj MCP bridge, pokud jeho konkrétní verze podporuje MCP stdio.
Jinak použij Python klienta nebo REST volání z deterministického toolu.
Není potřeba připojovat Docker resource ke sdílené síti janAGI ani přenášet jeho PostgreSQL.
Pokud systémy běží na stejném hostu, mohou používat interní API URL přes explicitní privátní síť.
Přes hosty použij HTTPS. Přenosy nemají měnit vlastnictví identity či dat.

Starý janAGI memory/RAG se tím automaticky nemigruje. Pilot může nejdřív pouze číst nový memory
service a zapisovat vybrané zprávy, pak porovnat přesnost a provenance na eval datasetu.

## OpenClaw / Hermes / jiný mozek

Stejná hranice. Nepřenášíme starý OpenClaw extension z v0.1, jeho registrace toolů závisí na
verzi konkrétního agenta. Universal interface je zdejší MCP/REST.
Když framework potřebuje tool callback, callback jen validuje vstup a volá `/v1/context`
nebo `/v1/episodes`; neinterpretuje ani nepotvrzuje fakta v agentově databázi.

## n8n

Použij HTTP Request node, method POST, URL `https://TVA_PAMET/v1/episodes`, JSON body ze zdroje
a Header Auth credential s `Authorization: Bearer <write-token>` uloženým v n8n credentials.
Mapuj `source_system`, `conversation_id`, `message_id`, `role`, `content`, `occurred_at`.
Například pro e-mail: source_system=mail-import, message_id=RFC Message-ID, conversation_id=thread ID.
Nepoužívej celý raw e-mail jako automaticky potvrzený user statement.
Na síťový timeout opakuj stejná ID; na 409 zastav a vyřeš konfliktní původní verzi.
Audit n8n doplňuje zdejší ingest/review audit. n8n není nutná součást služby.

## Import chatů

Součástí je normalizovaný JSONL formát `examples/conversations.jsonl` a `scripts/import_jsonl.py`.
Cesty, jak konverzaci dostat dovnitř (od nejpřesnější):

1. **Oficiální export** – zatím jen ChatGPT: `scripts/import_chatgpt_export.py conversations.json [--dry-run]`
   (aktuální větev konverzace, původní časy, ID zpráv z exportu). Ověřeno na syntetickém souboru, ne na skutečném exportu.
2. **Sessions Claude Code** (CLI i rozšíření ve VS Code): `scripts/import_claude_code.py --list` / `--project NAZEV [--dry-run]`.
   Čte soubory `~/.claude/projects/<kódovaná-cesta>/<session>.jsonl` (Windows `%USERPROFILE%\.claude\projects`). Bere jen text uživatele
   a asistenta s původními časy; tool calls, výsledky nástrojů, thinking, přílohy a vedlejší vlákna přeskočí, `<system-reminder>` z promptů odstraní.
   Bez `--project`/`--all` nic neimportuje (v adresáři jsou i nesouvisející projekty). ID zpráv jsou uuid ze souboru, opakování nic nezdvojí.
   Claude Code staré sessions maže (`cleanupPeriodDays`, výchozí asi 30 dní): nastav vysoké číslo a importuj včas.
   Ověřeno suchým během na skutečných souborech; nahrání na server nezkoušeno. Soubory mohou obsahovat tajemství z výstupů příkazů.
3. **Vložení textu** v UI (Konverzace → Vložit konverzaci): rozdělení podle značek mluvčích (`Vy:`, `ChatGPT:`, `**Claude:**`…; u výpisu z terminálu
   Claude Code `> ` = uživatel a `● ` = asistent, jen když se objeví obě). Text bez značek se rozdělí na odstavce a člověk klikáním určí, kde začíná
   nová zpráva a kdo mluví (výchozí: první odstavec uživatel, druhý asistent, zbytek pokračuje). Po úspěšném odeslání se formulář vyprázdní.
   Text z chatu ve VS Code ani z webu Claude žádné značky nemá: automatické rozdělení by jen hádalo, proto ruční určení. Datum zadá člověk.
4. **MCP `memory_save_conversation`**: asistent na požádání uloží aktuální konverzaci. Je to přepis modelu, ne export aplikace,
   proto je v názvu konverzace „přepsal asistent“. Jen lokální stdio; vzdálený MCP pro webové chaty není (AM-025).

Oficiální exporty ChatGPT i webu Claude (Nastavení → Soukromí/Data → Export) jsou vždy celé od začátku účtu, bez výběru období; opakovaný import
je bezpečný. Na import exportu Claude (web), Gemini a Mistral připrav samostatné adaptery podle jejich skutečného aktuálního formátu; ten jsme neviděli.
Účty se nepřipojují a chaty se nescrapují. Všechny cesty vytvářejí jen zdroje a kandidáty, nic nepotvrzují.
File/import adapter musí zachovat čas, roli, externí IDs, attachments odkazy a permissions.
Přílohy nemají být nepozorovaně odkazovány na expirované dočasné URL.

## Klientské klíče

Owner/admin token patří správci. Reader je pro context. Writer může ukládat zprávy (i přes MCP `memory_save_conversation`), ale nemůže
potvrzovat ani číst. Některý agent může potřebovat read+write; vygeneruj mu vlastní token.
Na úrovni této osobní instance není ještě per-document ACL. Připojení firemních zdrojů do ní
není součást scope tohoto projektu.
