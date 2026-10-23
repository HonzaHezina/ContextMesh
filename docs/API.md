# API v1

Všechny `/v1/*` endpointy vyžadují `Authorization: Bearer TOKEN`.
Scope určuje server, request žádný scope/group/tenant nepřijímá.
Úplné request schema se generuje z implementace na `/openapi.json`.

| Endpoint | Právo | Význam |
|---|---|---|
| GET `/ui` (též `/ui/review`) | žádné (statický shell bez dat) | jedna stránka s menu: Konverzace (výchozí), Ke schválení, Graf, Témata, Návrhy vazeb, Časová osa; token se zadává jednou a drží jen v paměti záložky (přepínání pohledů ho neztratí, obnovení stránky ano); přísné CSP |
| GET `/v1/conversations` | read | živé konverzace (nejnovější první), kurzor, počty návrhů podle stavu |
| GET `/v1/conversations/{source_system}/{conversation_id}` | read | zprávy jedné konverzace a co z každé vzniklo (`derived`: návrh, stav, citace); smazaný zdroj zmizí |
| POST `/v1/conversations/{source_system}/{conversation_id}/reprocess` | admin | pošle zprávy uživatele (bez vlastní dodané extrakce) modelu znovu; přírůstkové, stávající kandidáti a jejich stavy se nemění; 202 `{queued, user_messages}`; 409 bez nastaveného modelu nebo s Graphiti projekcí |
| DELETE `/v1/conversations/{source_system}/{conversation_id}` | admin | smaže všechny zprávy konverzace jako `DELETE /v1/episodes/{id}` po jedné (odvozené položky stojící jen na nich zmizí); není atomické, při 503 zopakovat |
| GET `/healthz` | žádné | proces žije |
| GET `/readyz` | žádné | journal a graph backend dostupné; neověřuje dostupnost modelu |
| POST `/v1/episodes` | write | queued ingest, 202, episode_id + duplicate |
| GET `/v1/episodes/{id}` | read | přesná původní zpráva |
| POST `/v1/search` | read | active items; volitelně Graphiti inferred facts |
| POST `/v1/context` | read | vybraný reviewed kontext s citacemi |
| GET `/v1/map?limit=500` | read | uzly, vazby a `clusters` (skupiny uzlů spojené potvrzeným ALIAS_OF); počet a truncated flag |
| GET `/v1/whoami` | libovolný platný token | `client_id` a `permissions` presentovaného tokenu (UI podle toho nabízí akce; server vynucuje vždy) |
| GET `/v1/events` | read | verzovaný veřejný log událostí, filtry, kurzor; viz [EVENTS.md](EVENTS.md) |
| GET `/v1/candidates` | read | stránkovaná fronta kandidátů (uzly/vazby) s evidencemi, původem příspěvků a stavem auditu |
| GET `/v1/candidates/{node\|link}/{id}` | read | jeden kandidát (po rozhodnutí slouží k ověření stavu) |
| POST `/v1/nodes/{id}/review` | admin | confirmed/rejected; volitelné `expected_status` (jiný aktuální stav → 409); opakované stejné rozhodnutí nic nemění a nezapíše událost |
| POST `/v1/links` | admin | kandidát vazby s citací ve zdroji |
| POST `/v1/links/{id}/review` | admin | review vazby (confirmed/rejected; odmítnutý návrh se znovu nenavrhne) |
| GET `/v1/links?status=&relation=` | read | vazby s krátkým popisem konců, citacemi a u návrhů `proposal` (skóre, signály, důvod, metoda) |
| POST `/v1/maintenance/propose` | admin | AM-003: vygeneruje candidate návrhy ALIAS_OF/SUPERSEDES (a s judge SUPPORTS/REFINES/CONTRADICTS); nic nepotvrzuje ani neslučuje |
| GET `/v1/jobs` | read | posledních 100 jobs, status a redigovaná chyba |
| POST `/v1/jobs/{episode_id}/retry` | admin | znovu pouze failed job |
| POST `/v1/maintenance/consolidate` | admin | přepočet četnosti a aktivity |
| DELETE `/v1/episodes/{id}` | admin | live-store delete; při Graphiti rebuild přeživších zdrojů |
| GET `/v1/export` | admin | canonical live raw messages + active graph, schema_version=1 |

## Ingest

```json
{
  "source_system": "custom-agent",
  "conversation_id": "conversation-42",
  "message_id": "msg-7",
  "role": "user",
  "content": "Chci mít svá data pod kontrolou.",
  "occurred_at": "2026-10-01T10:00:00Z",
  "extraction": {
    "items": [{
      "kind": "Goal",
      "label": "Kontrola vlastních dat",
      "summary": "Chci mít svá data pod kontrolou.",
      "quote": "Chci mít svá data pod kontrolou.",
      "themes": ["Vlastnictví dat"],
      "confidence": 0.9
    }]
  }
}
```

`extraction` je volitelná. V režimu `provided` bez ní uložíme raw zprávu, job dokončíme bez
výroby uzlů. V režimu `llm` se user zpráva extrahuje automaticky. Client-provided extraction
také zůstává candidate; nelze si v requestu poslat potvrzení.
Citace musí být přesný substring content. Neznámé properties odmítáme.

Identita epizody = server scope + source_system + conversation_id + message_id.
Stejný payload vrací stejný UUID a duplicate=true. Stejná identita s jinými daty vrací 409.
Opravená verze zprávy potřebuje nové message_id. Deleted identita se nepřijme znovu.

## Search a context

```json
{
  "query": "Vlastnictví dat",
  "limit": 12,
  "include_candidates": false,
  "as_of": "2026-10-01T00:00:00Z",
  "max_chars": 8000
}
```

`as_of` je volitelný, default je aktuální čas. Kontext budget je **znaky**, ne tokeny.
`used_chars` přesně odpovídá délce textu. Položka s příliš dlouhými zdroji se vynechá celá,
citace se neusekne. `truncated=true` oznamuje vynechané položky.
Active retrieval je zatím lexikální + 1-hop graf, Graphiti hybrid search vrací jen inferred facts
s živými zdrojovými UUID. Obě větve se neprezentují jako totožný vyhledávací engine.
Graphiti as_of je nyní post-filter nad omezenými výsledky; nezaručuje úplný historický recall.

HTTP kódy: 401 nepřihlášený, 403 právo chybí, 404 zdroj/uzel neexistuje,
409 konflikt identity/stavu jobu, 422 neplatný vstup, 503 backend/provider/delete unavailable.

## MCP

Lokální `active-memory-mcp` používá oficiální MCP Python SDK maintenance řady v1, zamčené 1.30.0.
Je to **stdio bridge**, nikoli remote HTTP MCP/OAuth server.

| Nástroj | Použití |
|---|---|
| memory_search | hledání; kandidáti jsou opt-in |
| memory_get_context | reviewed kontext včetně as_of a max_chars |
| memory_map | aktivní mapa |
| memory_get_source | původní epizoda |
| memory_add_message | jen při MEMORY_MCP_ALLOW_WRITE=true a API write právu |
| memory_save_conversation | jen při MEMORY_MCP_ALLOW_WRITE=true: asistent na požádání uloží celou konverzaci (název, zprávy `user`/`assistant`, volitelně `app` a `date`) jako zdroj `mcp-<app>`; ID z názvu, data a obsahu, takže opakování nic nezdvojí; zprávy s podezřením na heslo server odmítne a ostatní projdou. Je to **přepis od asistenta, ne export aplikace**: nemusí být doslovný, proto je to v názvu konverzace („přepsal asistent“). Nic neprohlásí za potvrzené |

Bridge nenabízí admin nástroje. Používej read token pro běžného asistenta.
Konkrétní aplikace musí umět MCP stdio nebo REST; podpora MCP není sama přístupem do všech chatbotů.

## Fronta ke schválení a události

`GET /v1/candidates?kind=node|link|all&status=candidate|confirmed|rejected|all&relation=&exclude_relation=&cursor=&limit=` (limit 1–100,
výchozí 25). Řazení je stabilní podle (pořadí první události, druh, id); `next_cursor` je neprůhledný řetězec,
`total` počet všech odpovídajících, `has_more` říká, zda existuje další stránka. Položka obsahuje přesné citace
(`evidence[]`: `quote`, `role`, `occurred_at`, `message_id`, `conversation_id`, `source_system`, `episode_id`,
`url` – vždy `null`, protože zprávy žádné externí URL nenesou), `contributions[]` (původ každého příspěvku z
událostí), poslední `decision` a `audit` (`consistent`, `last_recorded_state`). Stav je vždy z projekce;
`audit.consistent=false` znamená, že projekce a log nesouhlasí.

Hlavička `X-Correlation-Id` (volitelná) se přenese do události rozhodnutí, kontextu nebo smazání.
503 u rozhodnutí s textem „applied but … not recorded“ značí změnu bez zapsané události (viz EVENTS.md).

## Spuštění UI a dema

```bash
uv run active-memory init                 # vypíše owner token (read+write+admin)
uv run active-memory serve                # reference režim, bez LLM a Neo4j
# v druhém terminálu
export MEMORY_CLIENT_API_KEY='TOKEN'      # Windows: $env:MEMORY_CLIENT_API_KEY='TOKEN'
uv run python scripts/demo_review_queue.py
```
Otevři `http://127.0.0.1:8080/ui`, vlož token (jednou; menu nahoře přepíná pohledy beze ztráty připojení). Token s jen `read` smí prohlížet, tlačítka
Potvrdit/Zamítnout jsou pak zablokována. Demo používá fiktivní konverzace a extrakce dodané skriptem
(žádné volání modelu) a kandidáty nechá nerozhodnuté; opakované spuštění nic nepřidá.
Pro read-only pohled: `uv run active-memory init --client reader --permissions read`.

### Rady modelu (AM-021)

| Endpoint | Oprávnění | Poznámka |
|---|---|---|
| POST `/v1/recommendations/run` | admin | spustí na pozadí posouzení až `limit` návrhů bez aktuální rady (strop `max_recommend_calls`); vrací 202, při běžícím běhu 409 |
| GET `/v1/recommendations/status` | read | průběh posledního běhu (`running`, `done`, `total`, `failed`, `report`) |
| GET `/v1/recommendations/summary` | read | počty rad u čekajících návrhů, shoda s lidským rozhodnutím u rozhodnutých, zapnuto/vypnuto, model a poskytovatel |
| GET `/v1/candidates?recommendation=confirm\|reject\|unsure\|none\|stale` | read | filtr fronty podle rady |

Návrh ve `/v1/candidates` obsahuje `recommendation` (`recommendation`, `confidence`, `reason`, `model`, `provider`, `stale`) a po lidském
rozhodnutí `recommendation_agrees` (`true`/`false`, u `unsure` a zastaralé rady `null`). Rada **nikdy nemění stav**: potvrzení a zamítnutí
dál provádí jen `/review` s admin tokenem. Model dostane jen znění návrhu a jeho citace (nikoli celé konverzace), citace jsou v promptu
označené jako nedůvěryhodná data. Zapnutí vyžaduje souhlas s voláním modelu (`recommend_enabled`, Nastavení) a klíč.

### Nastavení modelu (LLM)

| Endpoint | Oprávnění | Poznámka |
|---|---|---|
| GET `/v1/settings` | admin | aktuální nastavení poskytovatelů; klíče se nikdy nevrací, jen `secrets: {…: true/false}` |
| PUT `/v1/settings/llm` | admin | částečná změna (chybějící pole beze změny, prázdný klíč `""` ho smaže); neplatná změna nezmění nic a vrátí důvod (422) |
| POST `/v1/settings/llm/test` | admin | jedno krátké volání poskytovatele s vymyšleným textem (`target`: `model` nebo `embedding`); vrací jen stav, ne tělo odpovědi |

**Poskytovatelé a modely (ověřeno v dokumentaci 2026-10-13, kvalita na češtině neměřena):** `GET /v1/settings` vrací `presets` s doporučenými
modely podle činnosti. Extrakce běží na každé zprávě (levný rychlý model), rady a posuzování vazeb jsou řidší (silnější model, pole `advice_model`).

| Předvolba | Extrakce | Rady / posuzování vazeb | Embeddingy |
|---|---|---|---|
| Google Gemini (`…/v1beta/openai`, rozhraní OpenAI v beta stavu) | `gemini-3.5-flash-lite` (0,30 / 2,50 USD za M tokenů) | `gemini-3.8-flash` (0,75 / 3,75 USD do 31. 12. 2026, pak 1,50 / 7,50) | `gemini-embedding-001` (3072 rozměrů výchozí) |
| Mistral (`api.mistral.ai/v1`) | `mistral-small-2603` (Small 4; 0,15 / 0,6 USD) | `mistral-medium-3-5` (1,5 / 7,5 USD) | `mistral-embed-2312` (8k kontext, 0,1 USD; rozměr 1024 z běžně uváděné hodnoty, v načtené dokumentaci nepotvrzen) |

Embeddingy používají **stejného poskytovatele a stejný klíč jako model**, dokud nezadáte vlastní adresu (`embedding_base_url`) a vlastní klíč.
Klíč modelu se nikdy nepošle na jiný host než model: vlastní adresa embeddingů vyžaduje vlastní klíč. Strukturovaný výstup: nejdřív režim
`json_schema`; odmítne-li ho poskytovatel (HTTP 400/422), zkusí se jednou prostý JSON režim s popisem schématu a odpověď se vždy ověří lokálně.
Zda Gemini a Mistral přijmou naše schéma v režimu `json_schema`, **nebylo vyzkoušeno** (nemáme klíč); dokumentace Googlu uvádí jen podmnožinu JSON Schema.

Měnit lze: režim extrakce, souhlas s voláním modelu, adresu/model/klíč poskytovatele, embeddingy, hledání podobností, posuzování vazeb
a automatické návrhy. Backend, Neo4j, Graphiti a scope zůstávají nastavením nasazení. Pravidla jsou stejná jako u prostředí
(model vyžaduje výslovný souhlas a klíč). Hodnoty se ukládají do `data/settings.override.json` (klíče v čitelné podobě, soubor
má omezená práva, ale není šifrovaný) a při startu přepisují prostředí. Změna se zapíše do provozního auditu (názvy polí, ne hodnoty).
Adresa musí být http(s), bez přihlašovacích údajů a ne link-local. Poskytovatel Gemini a Mistral se zadává přes jejich rozhraní kompatibilní
s OpenAI (předvolby v UI); jejich podpora strukturovaného výstupu a kvalita češtiny **nejsou ověřeny**.

### Import vlastních konverzací

Stránka **Vložit konverzaci** přijme text zkopírovaný z jakéhokoli chatu: rozdělí ho podle značek mluvčích (`Vy:`, `You said:`, `ChatGPT:`, `Claude:` …), nechá opravit, kdo mluví, a odešle jako zdroj `pasted`. Vložený text nemá původní časy, použije se zadané datum a to je i v názvu konverzace; stejné vložení znovu nic nezdvojí. Server zprávy s podezřením na heslo nebo klíč odmítne, ostatní projdou.

`scripts/import_chatgpt_export.py conversations.json [--dry-run]` nahraje oficiální export z ChatGPT (aktuální větev každé konverzace, původní časy, ID zpráv z exportu, takže opakování je bezpečné; `--dry-run` jen spočítá). Ověřeno jen na syntetickém souboru podle dokumentované struktury, na skutečném exportu zatím ne.

`scripts/import_chats.py chats.json` nahraje konverzace z lokálního JSON souboru (formát je v záhlaví skriptu;
soubor s osobními daty necommituj). Zprávy dostanou id podle pořadí a čas `start` + 1 minuta na zprávu; pokud neznáš
původní časy, napiš to do `conversation_id`. Pole `items` jsou extrakce dodané autorem souboru (ne modelem) a zůstávají
kandidáty; citace se před odesláním ověří jako přesný text zprávy. Opakované spuštění nic nezdvojí.

`exclude_relation=ABOUT` vynechá vazby „patří k tématu“, které vznikají u každé myšlenky. Pohled Ke schválení je ve výchozím stavu vynechává (včetně čísla v menu), jsou dostupné volbou „zařazení k tématu“; rozhodování se nemění.
