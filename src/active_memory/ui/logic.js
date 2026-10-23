// Pure view-model helpers: no DOM, no network. Shared by the browser UI and the Node unit tests.
(function (root) {
  "use strict";

  const STATUS_LABEL = { candidate: "kandidát", confirmed: "potvrzeno", rejected: "odmítnuto" };
  const KIND_LABEL = {
    Theme: "Téma",
    Thought: "Myšlenka",
    Fact: "Fakt",
    Question: "Otázka",
    Goal: "Cíl",
    Decision: "Rozhodnutí",
  };
  const RELATION_LABEL = {
    ABOUT: "patří k tématu",
    SUPPORTS: "podporuje",
    REFINES: "zpřesňuje",
    CONTRADICTS: "je v rozporu s",
    SUPERSEDES: "nahrazuje",
    ALIAS_OF: "je totéž jako",
  };

  function indexNodes(map) {
    const byId = new Map();
    for (const node of map.nodes) byId.set(node.id, node);
    return byId;
  }

  function matchesFilter(node, filter) {
    if (filter.status === "active") { if (node.status === "rejected") return false; }
    else if (filter.status && filter.status !== "all" && node.status !== filter.status) return false;
    if (filter.kind && filter.kind !== "all" && node.kind !== filter.kind) return false;
    if (filter.text) {
      const hay = (node.label + " " + node.summary).toLocaleLowerCase("cs");
      if (!hay.includes(filter.text.toLocaleLowerCase("cs"))) return false;
    }
    return true;
  }

  // Themes that recur across more chats first (that is what the memory is for), then the most active;
  // ties are broken by label so the order is stable.
  function themeRows(map, filter) {
    const clusterOf = new Map();
    for (const cluster of map.clusters || []) {
      for (const member of cluster.members) clusterOf.set(member, cluster);
    }
    return map.nodes
      .filter((n) => n.kind === "Theme" && matchesFilter(n, filter || {}))
      .sort((a, b) => (b.conversation_count || 0) - (a.conversation_count || 0) || (b.activity || 0) - (a.activity || 0) || a.label.localeCompare(b.label, "cs"))
      .map((node) => ({ node, cluster: clusterOf.get(node.id) || null }));
  }

  // Everything linked to a theme through ABOUT edges, grouped by kind. Rejected edges are hidden
  // unless asked for, but never silently turned into confirmed ones.
  function relatedItems(map, themeId, options) {
    const showRejected = Boolean(options && options.showRejected);
    const byId = indexNodes(map);
    const groups = {};
    for (const edge of map.edges) {
      if (edge.relation !== "ABOUT" || edge.target_id !== themeId) continue;
      if (edge.status === "rejected" && !showRejected) continue;
      const node = byId.get(edge.source_id);
      if (!node || (node.status === "rejected" && !showRejected)) continue;
      (groups[node.kind] = groups[node.kind] || []).push({ node, edge });
    }
    for (const kind of Object.keys(groups)) {
      groups[kind].sort((a, b) => lastSeen(b.node) - lastSeen(a.node));
    }
    return groups;
  }

  function lastSeen(node) {
    return node.last_seen ? Date.parse(node.last_seen) : 0;
  }

  // Evidence ordered in time = how the idea showed up across chats.
  function timeline(node) {
    return node.evidence
      .slice()
      .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  }

  function conversationsOf(node) {
    const keys = new Set(node.evidence.map((e) => e.source_system + " / " + e.conversation_id));
    return Array.from(keys).sort();
  }

  // Non-ABOUT edges touching a node, with the other end resolved.
  function linksOf(map, nodeId) {
    const byId = indexNodes(map);
    const out = [];
    for (const edge of map.edges) {
      if (edge.relation === "ABOUT") continue;
      let direction = null;
      let other = null;
      if (edge.source_id === nodeId) [direction, other] = ["out", byId.get(edge.target_id)];
      else if (edge.target_id === nodeId) [direction, other] = ["in", byId.get(edge.source_id)];
      if (other) out.push({ edge, direction, other });
    }
    return out;
  }

  function describeLink(edge, direction) {
    const label = RELATION_LABEL[edge.relation] || edge.relation;
    if (edge.relation === "SUPERSEDES") return direction === "out" ? "nahrazuje" : "je nahrazeno";
    if (edge.relation === "REFINES") return direction === "out" ? "zpřesňuje" : "je zpřesněno";
    if (edge.relation === "SUPPORTS") return direction === "out" ? "podporuje" : "je podporováno";
    return label;
  }

  function formatValidity(node) {
    if (!node.valid_from && !node.valid_to) return "platnost neuvedena";
    const day = (v) => (v ? v.slice(0, 10) : "…");
    return "platí " + day(node.valid_from) + " – " + day(node.valid_to) + " (konec je vyloučen)";
  }

  // Splits a source text into plain and quoted segments so the UI can mark the exact quote
  // without ever treating message text as markup.
  function quoteSegments(content, quote) {
    const at = quote ? content.indexOf(quote) : -1;
    if (at < 0) return [{ text: content, mark: false }];
    const parts = [];
    if (at > 0) parts.push({ text: content.slice(0, at), mark: false });
    parts.push({ text: quote, mark: true });
    if (at + quote.length < content.length) {
      parts.push({ text: content.slice(at + quote.length), mark: false });
    }
    return parts;
  }

  function proposalCard(link) {
    const p = link.proposal || {};
    return {
      id: link.id,
      relation: link.relation,
      relationText: describeLink(link, "out"),
      status: link.status,
      source: link.source,
      target: link.target,
      score: typeof p.score === "number" ? p.score : null,
      method: p.method || null,
      reason: p.reason || "",
      signals: p.signals || {},
      origin: link.origin || "manual",
      quotes: (link.evidence || []).map((e) => ({ episode_id: e.episode_id, quote: e.quote })),
    };
  }

  function summary(map, links) {
    const nodes = map.nodes;
    return {
      nodes: nodes.length,
      themes: nodes.filter((n) => n.kind === "Theme").length,
      candidates: nodes.filter((n) => n.status === "candidate").length,
      // Same rule as the proposals list: the links that put a node under a theme (ABOUT) are not proposals.
      openProposals: (links || []).filter((l) => l.status === "candidate" && l.relation !== "ABOUT").length,
      truncated: Boolean(map.truncated),
    };
  }

  // Paging of a list: which slice is shown and what the pager says. `page` is 0-based and is kept inside
  // the valid range, so a list that shrank (a deleted item, a new filter) never shows an empty page.
  function pageInfo(total, page, size) {
    const pages = Math.max(1, Math.ceil(total / size));
    const current = Math.min(Math.max(0, page | 0), pages - 1);
    const from = total ? current * size + 1 : 0;
    const to = Math.min(total, (current + 1) * size);
    return { page: current, pages, from, to, total, size, start: current * size, end: to, hasPrev: current > 0, hasNext: current < pages - 1 };
  }

  const api = {
    pageInfo,
    STATUS_LABEL,
    KIND_LABEL,
    RELATION_LABEL,
    themeRows,
    relatedItems,
    timeline,
    conversationsOf,
    linksOf,
    describeLink,
    formatValidity,
    quoteSegments,
    proposalCard,
    summary,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AMLogic = api;
})(typeof window !== "undefined" ? window : globalThis);
