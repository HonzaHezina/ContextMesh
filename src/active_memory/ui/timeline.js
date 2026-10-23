// Timeline view: recent events from the public events endpoint, newest first. Only what the log
// records is shown; unknown event types are shown as an envelope.
(function () {
  "use strict";
  const R = window.AMReview;
  const S = window.AMShell;
  const $ = (id) => document.getElementById(id);
  const state = { events: [], cursors: [null], page: 0, more: false };
  const PAGE = 30;

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

  async function load() {
    const p = new URLSearchParams({ order: "desc", limit: String(PAGE), expand: "subject" });
    if (state.cursors[state.page]) p.set("cursor", state.cursors[state.page]);
    const days = parseInt($("period").value, 10);
    if (days) p.set("from", new Date(Date.now() - days * 86400000).toISOString());
    const page = await S.call("GET", "/v1/events?" + p);
    state.events = page.events; state.more = page.has_more;
    if (page.next_cursor) state.cursors[state.page + 1] = page.next_cursor;
  }

  function goToPage(n) {
    state.page = n;
    load().then(() => { render(); window.scrollTo(0, 0); }).catch((e) => S.say(e.message, true));
  }

  function restart() { state.cursors = [null]; state.page = 0; return load(); }

  function render() {
    const list = $("timeline");
    list.replaceChildren();
    $("timeline-info").textContent = S.connected
      ? "Událost se zapíše až po skutečném dokončení operace. Nejnovější nahoře."
      : "Připojte se tokenem – bez něj se nic nezobrazí.";
    for (const event of state.events) {
      const row = R.eventRow(event);
      const css = event.type.replace("candidate.", "t-").replace("context.assembled", "t-context").replace("source.deleted", "t-deleted");
      const view = event.subject_view;
      const open = view && view.available && (event.subject.kind === "node" || event.subject.kind === "link")
        ? el("button", { type: "button", class: "link", onclick: () => S.show("review", { focus: { kind: event.subject.kind, id: event.subject.identifier } }) }, "Otevřít návrh")
        : null;
      list.append(el("li", { class: row.known ? css : "t-unknown" },
        el("div", { class: "when" }, row.when),
        el("div", {}, el("strong", {}, row.label), " · ", row.subject),
        el("div", {}, row.summary),
        open,
        el("details", { class: "tech" }, el("summary", {}, "Technické údaje"),
          el("div", {}, "Vznik: " + row.occurred + " · zapsal: " + row.actor + (row.sources ? " · " + row.sources : "")),
          el("div", {}, "Pořadí " + event.sequence + " · " + event.event_id))));
    }
    // The events API has no total, so the pager shows the page number and whether a next page exists.
    S.pager($("timeline-pager"), { page: state.page, total: 0, size: PAGE, hasNext: state.more }, goToPage);
  }

  S.register("timeline", {
    async load() { await restart(); },
    show() { render(); },
    clear() { state.events = []; state.cursors = [null]; state.page = 0; state.more = false; render(); },
  });
  $("period").addEventListener("change", () => restart().then(render).catch((e) => S.say(e.message, true)));
})();
