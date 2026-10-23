// Review queue view. A client of the public REST API only: reads /v1/candidates, decides through
// /v1/nodes|links/{id}/review. All server data is inserted as text. The token lives in the shell.
(function () {
  "use strict";
  const R = window.AMReview;
  const S = window.AMShell;
  const $ = (id) => document.getElementById(id);
  const state = {
    filter: { kind: "main", status: "candidate", rec: "" },
    advice: null, advicePoll: null, confirmRun: false,
    items: [], total: 0, cursors: [null], page: 0, hasMore: false,
    busy: new Set(), expanded: new Set(), focus: null,
  };

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }
  const call = (...args) => S.call(...args);
  const say = (text, kind) => S.say(text, kind === "error");
  const idOf = (item) => item.subject.kind + ":" + item.subject.identifier;

  function queueQuery(cursor) {
    const p = new URLSearchParams(Object.assign({ status: state.filter.status, limit: "25" }, R.queueKind(state.filter.kind)));
    if (cursor) p.set("cursor", cursor);
    if (state.filter.rec) p.set("recommendation", state.filter.rec);
    return "/v1/candidates?" + p;
  }

  const PAGE = 25;
  const resetPaging = () => { state.cursors = [null]; state.page = 0; };

  async function load(params) {
    const focus = params && params.focus;
    if (focus) {
      state.focus = await call("GET", "/v1/candidates/" + focus.kind + "/" + focus.id);
      return;
    }
    state.focus = null;
    const page = await call("GET", queueQuery(state.cursors[state.page] || null));
    state.items = page.items;
    state.total = page.total; state.hasMore = page.has_more;
    if (page.next_cursor) state.cursors[state.page + 1] = page.next_cursor;
    // The last item of a page was decided: the page is empty but earlier ones exist.
    if (!state.items.length && state.page > 0) { state.page -= 1; await load(params); }
  }

  function goToPage(n) {
    state.page = n;
    load({}).then(() => { render(); window.scrollTo(0, 0); }).catch((e) => say(e.message, "error"));
  }

  async function refresh() {
    const focus = state.focus ? { kind: state.focus.subject.kind, id: state.focus.subject.identifier } : null;
    await load(focus ? { focus } : {});
    render();
    loadAdvice();
    S.refreshCount();
  }

  // -- rendering -------------------------------------------------------------------------
  function badge(status) { return el("span", { class: "badge " + status }, R.STATUS[status] || status); }

  function evidenceBlock(e) {
    const url = R.safeUrl(e.url);
    return el("blockquote", { class: "quote" },
      el("q", {}, e.quote),
      el("footer", { class: "meta" },
        (R.ROLE[e.role] || e.role || "role neznámá") + " · " + R.when(e.occurred_at) + " · konverzace „" + e.conversation_id + "“ ",
        el("button", { type: "button", class: "link", onclick: () => S.show("conversations", { source_system: e.source_system, conversation_id: e.conversation_id, highlight: e.episode_id }) }, "otevřít celou konverzaci"),
        " · ",
        el("button", { type: "button", class: "link", onclick: () => openSource(e) }, "zobrazit zprávu"),
        url ? [" · ", el("a", { href: url, rel: "noopener noreferrer", target: "_blank" }, "externí odkaz")] : null));
  }

  function technical(item) {
    const e = item.evidence[0];
    return el("details", { class: "tech" },
      el("summary", {}, "Technické údaje"),
      el("div", {}, "Identifikátor návrhu: " + item.subject.identifier + " (" + item.subject.kind + ")"),
      item.evidence.map((x) => el("div", {}, "Zdroj: zpráva " + x.message_id + ", konverzace " + x.conversation_id + " (" + x.source_system + "), epizoda " + x.episode_id)),
      e ? null : el("div", {}, "Žádná živá evidence."),
      item.audit ? el("div", {}, "Audit: událostí " + item.audit.events + ", poslední zaznamenaný stav " + (item.audit.last_recorded_state || "žádný")) : null);
  }

  function adviceBlock(item) {
    const a = item.recommendation;
    if (!a) return null;
    return el("div", { class: "advice " + a.recommendation + (a.stale ? " stale" : "") },
      el("div", { class: "advice-head" }, "Názor modelu – rada, ne rozhodnutí"),
      el("div", {}, R.adviceHead({ model: a.model, provider: a.provider, recommendation: a.recommendation, confidence: a.confidence })),
      el("div", { class: "advice-reason" }, a.reason),
      a.stale ? el("div", { class: "warn" }, "Rada je zastaralá: u návrhu mezitím přibyla evidence nebo se změnil. Nechte ji posoudit znovu.") : null,
      R.agreementText(item) ? el("div", { class: "meta" }, R.agreementText(item)) : null);
  }

  function itemCard(item) {
    const id = idOf(item);
    const decision = R.decisionState(item, S.canDecide);
    const busy = state.busy.has(id);
    const open = state.expanded.has(id);
    const shown = open ? item.evidence : item.evidence.slice(0, 1);
    const buttons = el("div", { class: "actions" },
      el("button", { type: "button", class: "ok", disabled: !decision.allowed || busy, onclick: () => decide(item, "confirmed") }, busy ? "Probíhá…" : "Potvrdit"),
      el("button", { type: "button", class: "no", disabled: !decision.allowed || busy, onclick: () => decide(item, "rejected") }, busy ? "Probíhá…" : "Zamítnout"));
    const inMap = item.subject.kind === "node"
      ? [el("button", { type: "button", class: "link", onclick: () => S.show("map", { tab: "themes", focusNode: item.subject.identifier }) }, "Ukázat na mapě témat"),
          item.evidence[0] ? [" · ", el("button", { type: "button", class: "link", onclick: () => S.show("graph", { scope: { kind: "conversation", source_system: item.evidence[0].source_system, conversation_id: item.evidence[0].conversation_id } }) }, "Graf konverzace")] : null]
      : null;
    return el("li", { class: "card item " + item.status + (busy ? " busy" : ""), "data-id": id },
      el("div", { class: "kindline" }, R.KIND[item.candidate_kind] || item.candidate_kind, " ", badge(item.status)),
      el("h3", { class: "title" }, R.title(item)),
      item.summary ? el("p", { class: "summary-text" }, item.summary) : null,
      item.proposal ? el("p", { class: "meta" }, "Skóre " + item.proposal.score + ": " + item.proposal.reason) : null,
      el("div", { class: "evidence" }, shown.length ? shown.map(evidenceBlock) : el("p", { class: "meta" }, "Žádná živá evidence.")),
      item.evidence.length > 1
        ? el("button", { type: "button", class: "link evidence-extra", onclick: () => { open ? state.expanded.delete(id) : state.expanded.add(id); render(); } },
            open ? "Skrýt ostatní citace" : "Zobrazit všech " + item.evidence.length + " citací")
        : null,
      adviceBlock(item),
      el("div", { class: "origin" }, item.contributions.length
        ? item.contributions.map((c) => el("div", {}, "Původ: " + R.originText(c)))
        : el("div", {}, "Původ není zaznamenán.")),
      !item.audit.consistent && item.status === "candidate" ? el("div", { class: "warn" }, "Audit nesouhlasí s aktuálním stavem.") : null,
      item.decision ? el("p", { class: "meta" }, "Rozhodl " + item.decision.actor.identifier + " (ověřeno tokenem) · " + R.when(item.decision.recorded_at)) : null,
      buttons,
      decision.allowed ? null : el("div", { class: "why" }, decision.reason),
      inMap ? el("div", { class: "more-links" }, inMap) : null,
      technical(item));
  }

  function render() {
    const list = $("queue");
    list.replaceChildren();
    const bar = $("focus-bar");
    if (!S.connected) {
      $("queue-info").textContent = "Připojte se tokenem – bez něj se nic nezobrazí.";
      $("queue-pager").hidden = true; bar.hidden = true; $("source-pane").replaceChildren();
      return;
    }
    if (state.focus) {
      bar.hidden = false; bar.replaceChildren(
        "Zobrazen jeden návrh (otevřeno z jiného pohledu). ",
        el("button", { type: "button", class: "link", onclick: () => { state.focus = null; refresh().catch((e) => say(e.message, "error")); } }, "Zpět na celou frontu"));
      $("queue-info").textContent = "";
      list.append(itemCard(state.focus));
      $("queue-pager").hidden = true;
      return;
    }
    bar.hidden = true;
    $("queue-info").textContent = "Celkem " + state.total + " položek.";
    if (!state.items.length) list.append(el("li", { class: "empty" }, "Žádní kandidáti v tomto filtru."));
    for (const item of state.items) list.append(itemCard(item));
    S.pager($("queue-pager"), { page: state.page, total: state.total, size: PAGE, hasNext: state.hasMore }, goToPage);
  }

  async function openSource(evidence) {
    const pane = $("source-pane");
    try {
      const data = await call("GET", "/v1/episodes/" + evidence.episode_id);
      pane.replaceChildren(
        el("h3", {}, "Původní zpráva"),
        el("div", { class: "meta" }, (R.ROLE[data.role] || data.role) + " · " + R.when(data.occurred_at) + " · konverzace „" + data.conversation_id + "“"),
        el("p", { class: "source-text" }, R.markQuotes(data.content, [evidence.quote]).map((s) => (s.mark ? el("mark", {}, s.text) : s.text))),
        el("button", { type: "button", class: "link", onclick: () => pane.replaceChildren() }, "zavřít"));
    } catch (error) {
      say("Zdroj nelze zobrazit: " + (error.status === 404 ? "byl smazán." : error.message), "error");
    }
  }

  // -- decisions ---------------------------------------------------------------------------
  async function decide(item, wanted) {
    const id = idOf(item);
    if (state.busy.has(id)) return;
    state.busy.add(id); render(); say("");
    const path = (item.subject.kind === "node" ? "/v1/nodes/" : "/v1/links/") + item.subject.identifier + "/review";
    try {
      await call("POST", path, { status: wanted, expected_status: item.status });
      const fresh = await call("GET", "/v1/candidates/" + item.subject.kind + "/" + item.subject.identifier);
      const problem = R.verifyDecision(fresh, wanted);
      say(problem || (wanted === "confirmed" ? "Potvrzeno. Rozhodnutí je zapsané v časové ose." : "Zamítnuto. Rozhodnutí je zapsané v časové ose."), problem ? "error" : "");
    } catch (error) {
      if (error.status === 409) say("Stav se mezitím změnil jinde (" + error.message + "). Data jsou obnovena; rozhodněte znovu, pokud je to potřeba.", "error");
      else if (error.status === 403) say("Rozhodnutí odmítnuto: token nemá oprávnění admin.", "error");
      else if (error.status === 404) say("Kandidát už neexistuje (zdroj mohl být smazán).", "error");
      else if (error.status !== 401) say("Rozhodnutí se nepodařilo potvrdit: " + error.message + " Data jsou obnovena; ověřte stav.", "error");
    } finally {
      state.busy.delete(id);
      if (S.connected) { try { await refresh(); } catch (error) { say("Obnovení selhalo: " + error.message, "error"); } }
    }
  }

  // -- model advice panel ----------------------------------------------------------------
  async function loadAdvice() {
    try { state.advice = await call("GET", "/v1/recommendations/summary"); } catch (error) { state.advice = null; }
    renderAdvice();
  }

  async function startRun() {
    state.confirmRun = false;
    try {
      await call("POST", "/v1/recommendations/run", { limit: Math.min(10, state.advice.max_per_run || 10) });
      poll();
    } catch (error) {
      say("Spuštění selhalo: " + error.message, "error");
      loadAdvice();
    }
  }

  function poll() {
    clearTimeout(state.advicePoll);
    state.advicePoll = setTimeout(async () => {
      if (!S.connected) return;
      await loadAdvice();
      if (state.advice && state.advice.run.running) poll();
      else { const r = state.advice && state.advice.run.report; await refresh(); if (r) say(r.error ? "Doporučování skončilo chybou (" + r.error + ")." : "Hotovo: potvrdit " + r.recommended.confirm + ", zamítnout " + r.recommended.reject + ", nejistých " + r.recommended.unsure + (r.failed ? ", selhalo " + r.failed : "") + (r.void_because_changed ? ", neplatných (mezitím změněno) " + r.void_because_changed : "") + ". Zbývá bez rady: " + r.still_without_advice + ".", r.failed ? "error" : ""); }
    }, 1200);
  }

  function renderAdvice() {
    const box = $("advice-panel");
    box.replaceChildren();
    if (!S.connected || !state.advice) return;
    const a = state.advice;
    if (!a.enabled) {
      box.append(el("div", { class: "meta" }, "Rady modelu jsou vypnuté. Model by u každého návrhu napsal „potvrdit / zamítnout“ s důvodem; rozhodujete pořád vy. ",
        S.canDecide ? el("button", { type: "button", class: "link", onclick: () => S.show("settings") }, "Zapnout v Nastavení") : "Zapnout může administrátor v Nastavení."));
      return;
    }
    const c = a.open_candidates, d = a.decided_with_advice;
    box.append(el("div", {}, el("strong", {}, "Rady modelu (" + a.model + ", " + a.provider + "): "),
      "potvrdit " + c.confirm + " · zamítnout " + c.reject + " · nejistých " + c.unsure + " · zastaralých " + c.stale + " · bez rady " + c.none));
    if (d.agreed + d.disagreed) box.append(el("div", { class: "meta" }, "U vámi rozhodnutých návrhů s radou: shoda " + d.agreed + ", jinak " + d.disagreed + ". Rada nikdy nic nerozhoduje."));
    if (a.run.running) { box.append(el("div", {}, "Model posuzuje… " + a.run.done + " z " + a.run.total)); return; }
    if (!S.canDecide) return;
    const waiting = c.none + c.stale;
    if (!waiting) { box.append(el("div", { class: "meta" }, "Všechny čekající návrhy mají aktuální radu.")); return; }
    const n = Math.min(10, a.max_per_run, waiting);
    if (state.confirmRun) {
      box.append(el("div", { class: "note" }, "Odešle citace až " + n + " návrhů poskytovateli " + a.provider + " (model " + a.model + "). Model jen poradí, nic nerozhodne. ",
        el("button", { type: "button", class: "primary", onclick: startRun }, "Odeslat"), " ",
        el("button", { type: "button", onclick: () => { state.confirmRun = false; renderAdvice(); } }, "Zrušit")));
    } else {
      box.append(el("button", { type: "button", disabled: a.max_per_run === 0, onclick: () => { state.confirmRun = true; renderAdvice(); } }, "Nechat model doporučit (až " + n + ")"));
    }
  }

  S.register("review", {
    async load(params) { await load(params); loadAdvice(); },
    async show(params) {
      if (params && params.focus) { await load(params); }
      else if (state.focus && !(params && params.focus)) { state.focus = null; await load({}); }
      render();
      if (S.connected) loadAdvice(); // settings may have changed since the last visit
    },
    clear() {
      state.advice = null; clearTimeout(state.advicePoll); state.confirmRun = false;
      state.items = []; state.total = 0; state.hasMore = false; state.focus = null; resetPaging();
      state.expanded.clear(); state.busy.clear(); render();
    },
  });

  $("reload").addEventListener("click", () => { state.focus = null; resetPaging(); refresh().catch((e) => say(e.message, "error")); });
  $("f-kind").addEventListener("change", (e) => { state.filter.kind = e.target.value; state.focus = null; resetPaging(); refresh().catch((x) => say(x.message, "error")); });
  $("f-rec").addEventListener("change", (e) => { state.filter.rec = e.target.value; state.focus = null; resetPaging(); refresh().catch((x) => say(x.message, "error")); });
  $("f-status").addEventListener("change", (e) => { state.filter.status = e.target.value; state.focus = null; resetPaging(); refresh().catch((x) => say(x.message, "error")); });
})();
