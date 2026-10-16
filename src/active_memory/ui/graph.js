// Graph view: a read-only picture of one conversation or theme (never the whole memory at once).
// 3D (WebGL, graph3d.js) is the default; Cytoscape draws the flat version, also used without WebGL.
// Both draw on a canvas, so no server text is ever parsed as HTML; details are built as text.
// Candidate relations are dashed, confirmed ones solid. A text overview below stays the accessible
// equivalent of the picture.
(function () {
  "use strict";
  const R = window.AMReview;
  const L = window.AMLogic;
  const G = window.AMGraph;
  const S = window.AMShell;
  const $ = (id) => document.getElementById(id);
  const state = { map: null, scope: null, graph: null, cy: null, g3: null, mode: "3d", selected: null, filters: { conversations: true, onlyConfirmed: false } };

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

  const SHAPE = { Theme: "hexagon", Goal: "diamond", Decision: "rectangle", Question: "tag", Fact: "round-rectangle", Thought: "ellipse", Conversation: "barrel" };
  const relationText = (relation) => (L.RELATION_LABEL[relation] || relation);

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function stylesheet() {
    const fg = css("--fg"), card = css("--card"), line = css("--line"), accent = css("--accent");
    const cand = css("--cand"), ok = css("--ok"), muted = css("--muted"), accentBg = css("--accent-bg");
    return [
      { selector: "node", style: { label: "data(label)", "font-size": 13, color: fg, "text-wrap": "wrap", "text-max-width": 130, "text-valign": "bottom", "text-margin-y": 5, "background-color": card, "border-width": 2, "border-color": line, width: "data(size)", height: "data(size)", shape: "data(shape)", "text-background-color": card, "text-background-opacity": 0.85, "text-background-padding": 2 } },
      { selector: 'node[status = "candidate"]', style: { "border-color": cand, "border-style": "dashed" } },
      { selector: 'node[status = "confirmed"]', style: { "border-color": ok, "border-style": "solid" } },
      { selector: 'node[type = "conversation"]', style: { "background-color": accentBg, "border-color": accent, "border-style": "solid", width: 38, height: 30 } },
      { selector: 'node[kind = "Theme"]', style: { "font-weight": "bold" } },
      { selector: ".dim", style: { opacity: 0.15, "text-opacity": 0.3 } },
      { selector: "edge", style: { width: 2, "line-color": line, "target-arrow-color": line, "target-arrow-shape": "triangle", "curve-style": "bezier", "font-size": 11, color: muted, "text-background-color": card, "text-background-opacity": 0.9, "text-background-padding": 2 } },
      { selector: 'edge[type = "relation"][status = "candidate"]', style: { "line-style": "dashed", "line-color": cand, "target-arrow-color": cand } },
      { selector: 'edge[type = "relation"][status = "confirmed"]', style: { "line-style": "solid", "line-color": ok, "target-arrow-color": ok } },
      { selector: 'edge[relation != "ABOUT"][type = "relation"]', style: { label: "data(text)", width: 3 } },
      { selector: 'edge[type = "origin"]', style: { "line-style": "dotted", width: 1.5, "target-arrow-shape": "none", "line-color": muted } },
      { selector: ":selected", style: { "overlay-color": accent, "overlay-opacity": 0.2, "border-width": 4 } },
    ];
  }

  function elements(graph) {
    const degree = G.degrees(graph);
    const size = (n) => (n.type === "conversation" ? 34 : (n.kind === "Theme" ? 40 : 30) + 5 * Math.min(degree.get(n.id) || 0, 6));
    const nodes = graph.nodes.map((n) => ({ data: { id: n.id, label: n.label, type: n.type, kind: n.kind, status: n.status, size: size(n), shape: SHAPE[n.kind] || "ellipse" } }));
    const edges = graph.edges.map((e) => ({ data: { id: e.id, source: e.source, target: e.target, type: e.type, relation: e.relation, status: e.status, text: relationText(e.relation) } }));
    return nodes.concat(edges);
  }

  function labelOf(id) {
    const n = state.graph.nodes.find((x) => x.id === id);
    return n ? n.label : "?";
  }

  // -- detail ------------------------------------------------------------------------------
  function evidenceBlock(e) {
    return el("blockquote", { class: "quote" }, el("q", {}, e.quote),
      el("footer", { class: "meta" }, (R.ROLE[e.role] || e.role || "role neznámá") + " · " + R.when(e.occurred_at) + " · konverzace „" + e.conversation_id + "“ ",
        el("button", { type: "button", class: "link", onclick: () => S.show("conversations", { source_system: e.source_system, conversation_id: e.conversation_id, highlight: e.episode_id }) }, "otevřít konverzaci")));
  }

  // replaceChildren would stringify arrays and nulls, so detail content goes through el().
  function setPane(pane, ...children) { pane.replaceChildren(el("div", {}, children)); }

  function showDetail(id) {
    state.selected = id;
    const pane = $("graph-detail");
    const node = state.graph.nodes.find((n) => n.id === id);
    const edge = state.graph.edges.find((e) => e.id === id);
    if (node && node.type === "conversation") {
      setPane(pane, el("h3", {}, "Konverzace „" + node.conversation_id + "“"), el("div", { class: "meta" }, node.source_system),
        el("p", {}, el("button", { type: "button", onclick: () => S.show("conversations", { source_system: node.source_system, conversation_id: node.conversation_id }) }, "Otevřít konverzaci")),
        el("p", {}, el("button", { type: "button", onclick: () => select({ kind: "conversation", source_system: node.source_system, conversation_id: node.conversation_id }) }, "Zobrazit graf této konverzace")));
      return;
    }
    if (node) {
      const full = state.map.nodes.find((n) => n.id === id);
      setPane(pane, 
        el("div", { class: "kindline" }, R.KIND[node.kind] || node.kind, " ", el("span", { class: "badge " + node.status }, R.STATUS[node.status] || node.status)),
        el("h3", { class: "title" }, node.label),
        full && full.summary ? el("p", {}, full.summary) : null,
        full ? (full.evidence || []).slice(0, 3).map(evidenceBlock) : null,
        el("div", { class: "more-links" },
          el("button", { type: "button", class: "link", onclick: () => S.show("review", { focus: { kind: "node", id } }) }, "Ve frontě ke schválení"), " · ",
          el("button", { type: "button", class: "link", onclick: () => S.show("map", { tab: "themes", focusNode: id }) }, "Na mapě témat"),
          node.kind === "Theme" ? [" · ", el("button", { type: "button", class: "link", onclick: () => select({ kind: "theme", id }) }, "Zobrazit graf tématu")] : null));
      return;
    }
    if (edge) {
      const full = (state.map.edges || []).find((e) => e.id === id);
      setPane(pane, 
        el("div", { class: "kindline" }, "Vazba ", el("span", { class: "badge " + edge.status }, R.STATUS[edge.status] || edge.status)),
        el("h3", { class: "title" }, labelOf(edge.source) + " – " + relationText(edge.relation) + " – " + labelOf(edge.target)),
        edge.type === "origin" ? el("p", { class: "meta" }, "Uzel vznikl z této konverzace.") : null,
        full ? (full.evidence || []).slice(0, 3).map(evidenceBlock) : null,
        edge.type === "relation" ? el("div", { class: "more-links" }, el("button", { type: "button", class: "link", onclick: () => S.show("review", { focus: { kind: "link", id } }) }, "Ve frontě ke schválení")) : null);
    }
  }

  // -- drawing -----------------------------------------------------------------------------
  function clearDrawing() {
    if (state.cy) { state.cy.destroy(); state.cy = null; }
    if (state.g3) { window.AMGraph3D.destroy(state.g3); state.g3 = null; }
  }

  // Flat version of "keep the node and its neighbours bright, dim the rest".
  function emphasize(id) {
    if (!state.cy) return;
    state.cy.elements().removeClass("dim");
    const node = id ? state.cy.getElementById(id) : null;
    if (!node || !node.isNode || !node.isNode() || node.empty()) return;
    state.cy.elements().not(node.closedNeighborhood()).addClass("dim");
  }

  const NOTHING_SELECTED = "Klikněte na uzel nebo vazbu.";

  function draw() {
    const box = $("graph-canvas");
    clearDrawing();
    state.selected = null;
    const built = G.buildGraph(state.map, state.scope);
    state.graph = G.filterGraph(built, state.filters);
    const g = Object.assign({}, state.graph, { shown: built.shown, truncated: built.truncated, total: built.total });
    const want3d = state.mode === "3d" && window.AMGraph3D && window.AMGraph3D.available();
    $("graph-info").textContent = !g.nodes.length ? "V tomto výběru není nic k zobrazení."
      : "Zobrazeno uzlů: " + g.shown + (g.truncated ? " z " + g.total + " (zobrazeno jen " + G.MAX_NODES + " nejsilnějších – zúžte výběr)" : "") + ", vazeb: " + g.edges.filter((e) => e.type === "relation").length + "."
        + (state.mode === "3d" && !want3d ? " 3D zobrazení tento prohlížeč nezvládá (chybí WebGL), kreslím plošně." : "");
    $("graph-detail").replaceChildren(el("p", { class: "empty" }, NOTHING_SELECTED));
    $("graph-3d-hint").hidden = !want3d || !g.nodes.length;
    box.classList.toggle("is3d", want3d);
    for (const button of document.querySelectorAll("[data-graph-mode]")) button.setAttribute("aria-pressed", String(button.dataset.graphMode === (want3d ? "3d" : "2d")));
    renderOverview();
    if (!g.nodes.length) return;
    if (want3d) {
      try {
        state.g3 = window.AMGraph3D.render(box, g, {
          onNode: showDetail, onLink: showDetail,
          onBackground: () => $("graph-detail").replaceChildren(el("p", { class: "empty" }, NOTHING_SELECTED)),
        });
        return;
      } catch (error) {
        clearDrawing();
        box.classList.remove("is3d");
        $("graph-3d-hint").hidden = true;
        $("graph-info").textContent += " 3D se nepodařilo spustit, kreslím plošně.";
      }
    }
    if (typeof window.cytoscape !== "function") return;
    state.cy = window.cytoscape({
      container: box, elements: elements(g), style: stylesheet(), minZoom: 0.3, maxZoom: 2.5, wheelSensitivity: 0.3,
      layout: { name: "cose", animate: false, nodeRepulsion: 40000, idealEdgeLength: 140, nodeOverlap: 30, padding: 40, randomize: true, componentSpacing: 120, numIter: 1500 },
    });
    state.cy.on("mouseover", "node", (event) => emphasize(event.target.id()));
    state.cy.on("mouseout", "node", () => emphasize(state.selected));
    state.cy.on("tap", "node, edge", (event) => { showDetail(event.target.id()); emphasize(event.target.id()); });
    state.cy.on("tap", (event) => { if (event.target === state.cy) { state.selected = null; emphasize(null); $("graph-detail").replaceChildren(el("p", { class: "empty" }, NOTHING_SELECTED)); } });
  }

  function renderOverview() {
    const list = $("graph-overview");
    list.replaceChildren();
    const g = state.graph;
    const nodes = g.nodes.filter((n) => n.type === "node");
    const rel = g.edges.filter((e) => e.type === "relation");
    list.append(el("li", {}, el("strong", {}, "Uzly (" + nodes.length + ")")));
    for (const n of nodes) {
      list.append(el("li", {}, el("button", { type: "button", class: "link", onclick: () => { showDetail(n.id); if (state.cy) { state.cy.elements().unselect(); state.cy.getElementById(n.id).select(); } if (state.g3) window.AMGraph3D.focus(state.g3, n.id); } }, n.label),
        " · " + (R.KIND[n.kind] || n.kind) + " · " + (R.STATUS[n.status] || n.status)));
    }
    list.append(el("li", {}, el("strong", {}, "Vazby (" + rel.length + ")")));
    for (const e of rel) {
      list.append(el("li", {}, el("button", { type: "button", class: "link", onclick: () => showDetail(e.id) }, labelOf(e.source) + " – " + relationText(e.relation) + " – " + labelOf(e.target)),
        " · " + (R.STATUS[e.status] || e.status)));
    }
  }

  function scopeKey(scope) {
    return scope.kind === "conversation" ? "conversation|" + scope.source_system + "|" + scope.conversation_id : scope.kind === "theme" ? "theme|" + scope.id : "all";
  }

  function fillPicker() {
    const picker = $("graph-scope");
    picker.replaceChildren();
    const group = (label, items) => { const g = el("optgroup", { label }); for (const [value, text] of items) g.append(el("option", { value }, text)); picker.append(g); };
    group("Konverzace", G.conversations(state.map).map((c) => [scopeKey({ kind: "conversation", source_system: c.source_system, conversation_id: c.conversation_id }), c.conversation_id + " (" + c.count + ")"]));
    group("Témata", G.themes(state.map).map((t) => [scopeKey({ kind: "theme", id: t.id }), t.label]));
    group("Celá paměť", [["all", "Nejsilnější uzly (omezeno na " + G.MAX_NODES + ")"]]);
    picker.value = scopeKey(state.scope);
  }

  function select(scope) {
    state.scope = scope;
    fillPicker();
    draw();
  }

  function fromPicker(value) {
    if (value === "all") return { kind: "all" };
    const [kind, a, b] = value.split("|");
    return kind === "conversation" ? { kind, source_system: a, conversation_id: b } : { kind: "theme", id: a };
  }

  S.register("graph", {
    async load() {
      state.map = await S.call("GET", "/v1/map?limit=5000");
      if (!state.scope) {
        const first = G.conversations(state.map)[0];
        state.scope = first ? { kind: "conversation", source_system: first.source_system, conversation_id: first.conversation_id } : { kind: "all" };
      }
    },
    show(params) {
      if (!state.map) { $("graph-info").textContent = "Připojte se tokenem – bez něj se nic nezobrazí."; return; }
      if (params && params.scope) state.scope = params.scope;
      fillPicker();
      draw();
    },
    clear() {
      clearDrawing();
      state.map = null; state.scope = null; state.graph = null;
      $("graph-scope").replaceChildren(); $("graph-detail").replaceChildren(); $("graph-overview").replaceChildren();
      $("graph-info").textContent = "Připojte se tokenem – bez něj se nic nezobrazí.";
    },
  });
  $("graph-scope").addEventListener("change", (e) => select(fromPicker(e.target.value)));
  for (const button of document.querySelectorAll("[data-graph-mode]")) {
    button.addEventListener("click", () => { state.mode = button.dataset.graphMode; if (state.map) draw(); });
  }
  $("graph-fit").addEventListener("click", () => {
    if (state.g3) window.AMGraph3D.fit(state.g3);
    if (state.cy) { state.selected = null; emphasize(null); state.cy.animate({ fit: { padding: 40 } }, { duration: 300 }); }
  });
  $("graph-show-conv").addEventListener("change", (e) => { state.filters.conversations = e.target.checked; if (state.map) draw(); });
  $("graph-only-ok").addEventListener("change", (e) => { state.filters.onlyConfirmed = e.target.checked; if (state.map) draw(); });
})();
