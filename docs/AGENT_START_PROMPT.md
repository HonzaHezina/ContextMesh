# Prompt k vložení programovacímu agentovi

> **Aktualizace 2026-10-14:** kroky 3–7 níže jsou z velké části hotové (AM-001 až AM-004, události, fronta kandidátů, UI, nastavení modelu,
> rady modelu, vložení konverzace a MCP `memory_save_conversation`). Skutečný stav a mezery jsou v `docs/STATUS.md`, další práce v `docs/BACKLOG.md`
> (AM-021 zbytek, AM-022 profily poskytovatelů a limity nákladů, AM-023/AM-025 konektory a vzdálené MCP, AM-019 zbytek). Neověřené zůstává:
> skutečné volání Gemini/Mistral a kvalita češtiny, Graphiti s modelem, Coolify nasazení. Pravidla jsou v `AGENTS.md`.
> **Aktualizace 2026-10-19:** proběhl první Coolify deploy na Hetzner (poznatky v `docs/DEPLOYMENT.md`), přibyl import sessions Claude Code
> (`scripts/import_claude_code.py`) a ruční rozdělení vloženého textu bez značek. Otevřené: nasazená instance má jen zdroje bez extrakce (model vypnutý),
> ověření API názvů Mistral modelů, export webu Claude, doladění vkládání (např. odstranění šumu z kopírovaného chatu), commit těchto změn není pushnutý.
> Text níže je původní zadání prvního běhu.

Pracuješ v novém samostatném repozitáři Active Memory. Načti AGENTS.md, README.md,
docs/ARCHITECTURE.md, docs/MEMORY_MODEL.md, docs/STATUS.md a docs/BACKLOG.md.

Cílem je vlastní osobní paměť napříč AI asistenty. Nemá nahrazovat chatboty ani být součástí janAGI.
janAGI, OpenClaw, Hermes a další systémy se připojují přes stejné REST/MCP rozhraní.
Osobní a firemní paměť zatím nepropojuj. IAM nech jako adapter boundary.

Nejdůležitější: konverzace se opakovaně vracejí ke stejným myšlenkám a tématům, i když lokálně
řeší něco jiného. Z těchto opakování má průběžně vznikat aktivní myšlenková mapa, která zachytí
myšlenky, témata, cíle, otázky, rozhodnutí, změny a vazby. Graf je hlavní reprezentace významu;
embeddingy pomáhají hledat podobnost. Zdrojová zpráva a citace se nesmí ztratit.

První běh:
Aktuální důkazy jsou v docs/VALIDATION.md: CI již ověřilo native Neo4j, Compose a Docker build.
Při nezměněném kódu je neopakuj bez důvodu; dokonči zejména neověřenou Graphiti/model část.
1. Ověř spuštění reference API a všechny testy, nic zbytečně nepřepisuj.
2. Zaznamenej rozdíl mezi implementací a cílem; vycházej ze STATUS.
3. Připrav a proveď skutečný integrační test v Dockeru s Neo4j a Graphiti 0.30.2:
   ingest → hotový job → zdrojové episode UUID → scoped hybrid search → restart → deletion/rebuild.
   Bez dostupných modelových klíčů spusť alespoň Neo4j native graph test a popiš chybějící krok.
4. Doplň tento test do CI jako volitelný/secrets-gated test, neposílej syntetická data placenému
   providerovi při každém PR. Bez klíčů musí běžná testovací sada zůstat lokální.
5. Teprve po této kontrole pokračuj AM-002: pevný eval dataset pro české konverzace a parapráze.
6. Pak AM-003: sémantická podobnost myšlenek/témat napříč chaty, aliases a proposals pro
   SUPPORTS/REFINES/CONTRADICTS/SUPERSEDES. Výsledky mají zdroje a stav candidate.
7. Pak AM-004: prohlížeč mapy s tématy, detaily zdrojů a schvalováním.

Neoznačuj LLM interpretaci za potvrzený fakt. Kontext má být malý, relevantní, časově správný,
s důvodem výběru a dohledatelnými zdroji. Dreaming nesmí z vlastní domněnky vytvořit pravdu
ani odstranit původní historii. Každý krok zakonči testy a aktualizací STATUS.

Postupuj po menších commitech. Průběžně uváděj, co jsi ověřil a co zatím stojí jen na návrhu.
