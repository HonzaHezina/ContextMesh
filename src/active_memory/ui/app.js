// Browser UI. Every piece of server data is inserted with textContent; nothing is ever parsed as
// HTML, because retrieved memory is untrusted. The bearer token lives in this tab only.
(function () {
  "use strict";
  const L = window.AMLogic;
  const S = window.AMShell;
  const state = {
    map: null,
    links: [],
    tab: "themes",
    filter: { status: "active", kind: "all", text: "" },
    linkFilter: { status: "candidate", relation: "all" },
    selectedTheme: null,
    selectedNode: null,
    source: null,
  };

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === "class") node.className = value;
      else if (key === "onclick") node.addEventListener("click", value);
      else if (key === "onchange") node.addEventListener("change", value);
      else if (key === "oninput") node.addEventListener("input", value);
      else if (value !== null && value !== undefined) node.setAttribute(key, value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function clear(node) {
    node.replaceChildren();
    return node;
  }

  const say = (text, isError) => S.say(text, isError);
  const call = (...args) => S.call(...args);

  async function load() {
    const [map, links] = await Promise.all([call("GET", "/v1/map?limit=5000"), call("GET", "/v1/links?limit=2000")]);
    state.map = map;
    state.links = links.links;
    render();
  }

  // Opens a node in the theme view: a theme directly, anything else through its ABOUT edge.
  function focusNode(nodeId) {
    const node = state.map.nodes.find((n) => n.id === nodeId);
    if (!node) { say("Uzel už na mapě není (nebo je mapa zkrácena limitem).", true); return; }
    if (node.kind === "Theme") { state.selectedTheme = node.id; state.selectedNode = null; }
    else {
      const about = state.map.edges.find((e) => e.relation === "ABOUT" && e.source_id === node.id);
      state.selectedTheme = about ? about.target_id : null;
      state.selectedNode = node.id;
      if (!about) say("Tento uzel zatím nepatří k žádnému tématu.", true);
    }
    state.filter.status = "all"; state.source = null;
  }

  function badge(status) {
    return el("span", { class: "badge " + status }, L.STATUS_LABEL[status] || status);
  }

  function renderSummary() {
    const box = clear(document.getElementById("summary"));
    if (!state.map) return;
    const s = L.summary(state.map, state.links);
    box.append(
      `${s.nodes} uzlů · ${s.themes} témat · ${s.candidates} kandidátů`,
      s.truncated ? " · mapa je zkrácena limitem" : ""
    );
    document.getElementById("proposal-count").textContent = s.openProposals ? "(" + s.openProposals + ")" : "";
  }

  function select(options, current, onchange) {
    const node = el(
      "select",
      { onchange: (e) => onchange(e.target.value) },
      options.map(([value, text]) => el("option", { value, selected: value === current ? "selected" : null }, text))
    );
    node.value = current;
    return node;
  }

  function renderThemes() {
    const pane = clear(document.getElementById("pane-list"));
    const statusOptions = [["active", "bez odmítnutých"], ["all", "všechny stavy"], ["candidate", "kandidáti"], ["confirmed", "potvrzené"], ["rejected", "odmítnuté"]];
    pane.append(
      el(
        "div",
        { class: "filters" },
        select(statusOptions, state.filter.status, (v) => { state.filter.status = v; render(); }),
        el("input", {
          type: "search",
          placeholder: "Hledat v tématech",
          value: state.filter.text,
          oninput: (e) => { state.filter.text = e.target.value; renderThemeList(list); },
        })
      )
    );
    const list = el("ul", { class: "cards" });
    pane.append(list);
    renderThemeList(list);
  }

  function renderThemeList(list) {
    clear(list);
    const rows = L.themeRows(state.map, { status: state.filter.status, text: state.filter.text });
    if (!rows.length) list.append(el("li", { class: "empty" }, "Žádná témata neodpovídají filtru."));
    for (const { node, cluster } of rows) {
      const card = el(
        "li",
        {
          class: "card " + node.status + (state.selectedTheme === node.id ? " selected" : ""),
          tabindex: "0",
          role: "button",
          onclick: () => { state.selectedTheme = node.id; state.selectedNode = null; state.source = null; render(); },
        },
        el("div", { class: "title" }, node.label, " ", badge(node.status)),
        el(
          "div",
          { class: "meta" },
          `${node.conversation_count || 0} chatů · ${node.strength || 0} zdrojů · aktivita ${(node.activity || 0).toFixed(2)}`
        ),
        cluster ? el("div", { class: "meta cluster" }, "alias skupina: " + cluster.labels.join(" ≈ ")) : null
      );
      card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") card.click(); });
      list.append(card);
    }
  }

  async function review(kind, id, status) {
    try {
      const path = kind === "node" ? `/v1/nodes/${id}/review` : `/v1/links/${id}/review`;
      await call("POST", path, { status });
      say(status === "confirmed" ? "Potvrzeno." : "Odmítnuto.");
      await load();
    } catch (error) {
      say(error.message, true);
    }
  }

  function reviewButtons(kind, record) {
    return el(
      "span",
      { class: "actions" },
      el("button", { type: "button", class: "ok", disabled: record.status === "confirmed" ? "disabled" : null, onclick: () => review(kind, record.id, "confirmed") }, "Potvrdit"),
      el("button", { type: "button", class: "no", disabled: record.status === "rejected" ? "disabled" : null, onclick: () => review(kind, record.id, "rejected") }, "Odmítnout")
    );
  }

  function quoteBlock(evidence) {
    return el(
      "blockquote",
      { class: "quote" },
      el("q", {}, evidence.quote),
      el(
        "div",
        { class: "meta" },
        `${evidence.role || "?"} · ${window.AMReview.when(evidence.occurred_at)}`,
        evidence.conversation_id ? ` · konverzace „${evidence.conversation_id}“ ` : " ",
        evidence.conversation_id
          ? el("button", { type: "button", class: "link", onclick: () => S.show("conversations", { source_system: evidence.source_system, conversation_id: evidence.conversation_id, highlight: evidence.episode_id }) }, "otevřít konverzaci")
          : null,
        evidence.conversation_id ? " · " : "",
        el("button", { type: "button", class: "link", onclick: () => openSource(evidence) }, "zobrazit zprávu")
      )
    );
  }

  async function openSource(evidence) {
    try {
      const data = await call("GET", "/v1/episodes/" + evidence.episode_id);
      state.source = { data, quote: evidence.quote };
      renderSource();
    } catch (error) {
      say("Zdroj nelze zobrazit: " + error.message, true);
    }
  }

  function renderSource() {
    const pane = clear(document.getElementById("pane-source"));
    if (!state.source) return;
    const { data, quote } = state.source;
    pane.append(
      el("h3", {}, "Původní zpráva"),
      el("div", { class: "meta" }, `${data.role} · ${data.occurred_at} · ${data.source_system} / ${data.conversation_id} / ${data.message_id}`),
      el("div", { class: "meta" }, "ID epizody: " + data.episode_id),
      el(
        "p",
        { class: "source-text" },
        L.quoteSegments(data.content, quote).map((part) => (part.mark ? el("mark", {}, part.text) : part.text))
      ),
      el("button", { type: "button", class: "link", onclick: () => { state.source = null; renderSource(); } }, "zavřít")
    );
  }

  function nodeDetail(node) {
    const links = L.linksOf(state.map, node.id);
    return el(
      "article",
      { class: "node " + node.status },
      el("h3", {}, L.KIND_LABEL[node.kind] || node.kind, ": ", node.label, " ", badge(node.status)),
      node.status === "candidate" ? el("p", { class: "note" }, "Kandidát: strojový návrh podložený citacemi níže. Není potvrzený fakt.") : null,
      el("p", {}, node.summary),
      el("div", { class: "meta" }, L.formatValidity(node), " · jistota modelu ", Math.round((node.confidence || 0) * 100) + " %"),
      el("div", { class: "meta" }, "Chaty: " + L.conversationsOf(node).join("; ")),
      reviewButtons("node", node),
      el("h4", {}, "Vývoj ve zdrojích"),
      L.timeline(node).map(quoteBlock),
      links.length ? el("h4", {}, "Vazby na jiné uzly") : null,
      links.map(({ edge, direction, other }) =>
        el(
          "div",
          { class: "link-row " + edge.status },
          `${L.describeLink(edge, direction)} → `,
          el("button", { type: "button", class: "link", onclick: () => { state.selectedNode = other.id; render(); } }, other.label),
          " ",
          badge(edge.status),
          edge.origin === "proposal" ? el("span", { class: "meta" }, " (návrh, skóre " + ((edge.proposal || {}).score ?? "?") + ")") : null,
          reviewButtons("link", edge)
        )
      )
    );
  }

  function renderThemeDetail() {
    const pane = clear(document.getElementById("pane-detail"));
    if (state.tab !== "themes") return;
    const theme = state.map.nodes.find((n) => n.id === state.selectedTheme);
    if (!theme) {
      pane.append(el("p", { class: "empty" }, "Vyberte téma vlevo."));
      return;
    }
    const groups = L.relatedItems(state.map, theme.id);
    pane.append(nodeDetail(theme));
    pane.append(el("h3", {}, "Co k tématu patří"));
    const kinds = Object.keys(groups);
    if (!kinds.length) pane.append(el("p", { class: "empty" }, "Zatím nic nepatří k tomuto tématu."));
    for (const kind of kinds) {
      pane.append(
        el("h4", {}, (L.KIND_LABEL[kind] || kind) + " (" + groups[kind].length + ")"),
        el(
          "ul",
          { class: "cards" },
          groups[kind].map(({ node }) =>
            el(
              "li",
              { class: "card " + node.status + (state.selectedNode === node.id ? " selected" : ""), tabindex: "0", role: "button", onclick: () => { state.selectedNode = node.id; render(); } },
              el("div", { class: "title" }, node.label, " ", badge(node.status)),
              el("div", { class: "meta" }, L.formatValidity(node) + " · " + node.strength + " zdrojů")
            )
          )
        )
      );
    }
    const chosen = state.map.nodes.find((n) => n.id === state.selectedNode);
    if (chosen) pane.append(el("hr"), nodeDetail(chosen));
  }

  function renderProposals() {
    const pane = clear(document.getElementById("pane-list"));
    const detail = clear(document.getElementById("pane-detail"));
    const relations = [["all", "všechny typy"], ...Object.keys(L.RELATION_LABEL).filter((r) => r !== "ABOUT").map((r) => [r, r])];
    pane.append(
      el(
        "div",
        { class: "filters" },
        select([["candidate", "čekající"], ["confirmed", "potvrzené"], ["rejected", "odmítnuté"]], state.linkFilter.status, (v) => { state.linkFilter.status = v; render(); }),
        select(relations, state.linkFilter.relation, (v) => { state.linkFilter.relation = v; render(); }),
        el("button", { type: "button", onclick: proposeNow }, "Navrhnout nové vazby")
      ),
      el("p", { class: "note" }, "Návrhy vznikají z podobnosti napříč chaty. Rozhodnutí patří vám; odmítnutý návrh se nevrátí.")
    );
    const cards = state.links
      .filter((l) => l.relation !== "ABOUT" && l.status === state.linkFilter.status && (state.linkFilter.relation === "all" || l.relation === state.linkFilter.relation))
      .map(L.proposalCard);
    if (!cards.length) detail.append(el("p", { class: "empty" }, state.linkFilter.status === "candidate"
      ? "Žádné čekající návrhy vazeb. Tlačítko „Navrhnout nové vazby“ hledá podobné myšlenky z různých konverzací; bez zapnutého modelu najde jen téměř shodné formulace."
      : "Žádné vazby v tomto stavu."));
    for (const card of cards) {
      detail.append(
        el(
          "article",
          { class: "proposal " + card.status },
          el("h3", {}, card.source.label, " ", el("em", {}, card.relationText), " ", card.target.label, " ", badge(card.status)),
          el("div", { class: "meta" }, `${card.source.kind} → ${card.target.kind} · původ: ${card.origin}` + (card.method ? ` · metoda ${card.method}` : "") + (card.score !== null ? ` · skóre ${card.score}` : "")),
          card.reason ? el("p", {}, "Důvod: " + card.reason) : null,
          Object.keys(card.signals).length ? el("div", { class: "meta" }, "Signály: " + Object.entries(card.signals).map(([k, v]) => `${k} ${v}`).join(", ")) : null,
          card.quotes.map((q) => quoteBlock({ episode_id: q.episode_id, quote: q.quote })),
          reviewButtons("link", { id: card.id, status: card.status })
        )
      );
    }
  }

  async function proposeNow() {
    try {
      const report = await call("POST", "/v1/maintenance/propose");
      say(`Nových návrhů: ${report.proposed}. Žádný není potvrzený.`);
      await load();
    } catch (error) {
      say(error.message, true);
    }
  }

  function render() {
    if (!state.map) return;
    renderSummary();
    if (state.tab === "themes") { renderThemes(); renderThemeDetail(); }
    else renderProposals();
    renderSource();
  }

  S.register("map", {
    async load() { await load(); },
    show(params) {
      if (params && params.tab) state.tab = params.tab;
      if (params && params.focusNode && state.map) { state.tab = "themes"; focusNode(params.focusNode); }
      state.source = null;
      render();
    },
    clear() {
      state.map = null; state.links = []; state.selectedTheme = null; state.selectedNode = null; state.source = null;
      for (const id of ["pane-list", "pane-detail", "pane-source", "summary"]) document.getElementById(id).replaceChildren();
    },
  });
})();
