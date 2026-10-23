// Conversations view: the messages as delivered, and under each one what was derived from it with
// links to the review queue and the topic map. Read-only; all text is inserted as text.
(function () {
  "use strict";
  const R = window.AMReview;
  const S = window.AMShell;
  const $ = (id) => document.getElementById(id);
  const state = { list: [], total: 0, matching: 0, cursors: [null], page: 0, more: false, sources: [], current: null, detail: null, highlight: null,
    q: "", source: "", sort: "added" };
  const PAGE = 20;

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
  // Readable name from the server (themes, else the start of the first message); the id is technical.
  const name = (c) => c.title || c.conversation_id;
  const same = (a, b) => a && b && a.source_system === b.source_system && a.conversation_id === b.conversation_id;

  // One page of the list. Search, source and sort are done by the server; `page` is the 0-based page
  // and the cursor of each page is remembered, so going back is possible too.
  async function loadList(page) {
    state.page = page || 0;
    if (!state.page) state.cursors = [null];
    const query = new URLSearchParams({ limit: String(PAGE), sort: state.sort });
    if (state.cursors[state.page]) query.set("cursor", state.cursors[state.page]);
    if (state.q.trim()) query.set("q", state.q.trim());
    if (state.source) query.set("source", state.source);
    const result = await S.call("GET", "/v1/conversations?" + query);
    state.list = result.conversations;
    state.total = result.total; state.more = result.has_more; state.sources = result.sources || [];
    if (result.matching !== null && result.matching !== undefined) state.matching = result.matching;
    if (result.next_cursor) state.cursors[state.page + 1] = result.next_cursor;
  }

  function goToPage(n) {
    loadList(n).then(() => { render(); const top = $("conv-list"); if (top.scrollIntoView) top.scrollIntoView({ block: "start" }); }).catch((e) => S.say(e.message, true));
  }

  function refreshList() { return loadList(0).then(render).catch((e) => S.say(e.message, true)); }

  function fillSources() {
    const select = $("conv-source");
    const keep = state.source;
    select.replaceChildren(el("option", { value: "" }, "všechny zdroje"), state.sources.map((s) => el("option", { value: s }, s)));
    select.value = state.sources.includes(keep) ? keep : "";
  }

  async function openConversation(source_system, conversation_id, highlight) {
    armed = false;
    state.current = { source_system, conversation_id };
    state.highlight = highlight || null;
    state.detail = await S.call("GET", "/v1/conversations/" + encodeURIComponent(source_system) + "/" + encodeURIComponent(conversation_id));
    render();
    if (highlight) {
      const target = document.querySelector('[data-episode="' + CSS.escape(highlight) + '"]');
      if (target && target.scrollIntoView) target.scrollIntoView({ block: "center" });
    }
  }

  const path = (c) => "/v1/conversations/" + encodeURIComponent(c.source_system) + "/" + encodeURIComponent(c.conversation_id);

  // The result is shown next to the buttons (the page-level message line is out of sight when scrolled).
  function note(text, isError) {
    const box = $("conv-action");
    if (!box) return;
    box.textContent = text || "";
    box.className = "note" + (isError ? " error" : "");
    box.hidden = !text;
  }
  const derivedTotal = (detail) => detail.messages.reduce((n, m) => n + m.derived.length, 0);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let busy = false;

  // The model reads the user's messages again and may find more; nothing existing is changed.
  // Processing runs in the background, so the conversation is reloaded until the queue is empty.
  async function reprocess() {
    const c = state.detail;
    if (busy) return;
    busy = true;
    const before = derivedTotal(c);
    try {
      const r = await S.call("POST", path(c) + "/reprocess");
      if (!r.queued) { note("Není co zpracovat: zprávy se právě zpracovávají, nebo žádná nemá co modelu předat."); return; }
      note("Model znovu prochází " + r.queued + " zpráv uživatele… (stránku nemusíte zavírat)");
      for (let i = 0; i < 40; i++) {
        await sleep(2000);
        const jobs = (await S.call("GET", "/v1/jobs")).jobs;
        if (jobs.some((j) => j.status === "pending" || j.status === "running")) continue;
        await openConversation(c.source_system, c.conversation_id);
        S.markDirty();
        const added = derivedTotal(state.detail) - before;
        const failed = jobs.filter((j) => j.status === "failed").length;
        note("Hotovo. " + (added > 0 ? "Přibylo nových položek: " + added + " (najdete je ve frontě Ke schválení)." : "Model nenašel nic nového.") +
          (failed ? " Zpracování " + failed + " zpráv selhalo (viz Nastavení / úlohy)." : ""), failed > 0);
        return;
      }
      note("Zpracování trvá déle než obvykle; pokračuje na pozadí. Obnovte konverzaci později.");
    } catch (error) {
      note(error.status === 409 ? "Znovu projít nejde: není nastaven model pro extrakci (viz Nastavení) nebo je zapnutá projekce Graphiti." : error.message, true);
    } finally {
      busy = false;
    }
  }

  // Deleting asks twice: the first click arms the button, the second one deletes.
  let armed = false;
  async function remove() {
    if (!armed) { armed = true; render(); return; }
    const c = state.detail;
    armed = false;
    try {
      const r = await S.call("DELETE", path(c));
      state.detail = null; state.current = null;
      await loadList(0);
      S.markDirty();
      state.flash = "Smazáno zpráv: " + r.messages + ". Odvozené návrhy, které stály jen na nich, zmizely také. Zálohy se řídí postupem uchování.";
      render();
    } catch (error) {
      state.flash = "Smazání se nepovedlo: " + error.message;
      render();
    }
  }

  function derivedChip(item) {
    return el("li", { class: "chip " + item.status },
      el("span", { class: "kindline" }, R.KIND[item.candidate_kind] || item.candidate_kind, " "),
      el("span", { class: "badge " + item.status }, R.STATUS[item.status] || item.status),
      el("div", { class: "title" }, item.title),
      el("div", { class: "more-links" },
        el("button", { type: "button", class: "link", onclick: () => S.show("review", { focus: { kind: item.subject.kind, id: item.subject.identifier } }) }, "Ve frontě ke schválení"),
        item.subject.kind === "node" ? [" · ", el("button", { type: "button", class: "link", onclick: () => S.show("map", { tab: "themes", focusNode: item.subject.identifier }) }, "Na mapě témat")] : null));
  }

  const LONG = 900; // characters; longer assistant answers start collapsed
  const expanded = new Set();

  function bubble(message) {
    const quotes = message.derived.flatMap((d) => d.quotes);
    const mine = message.role === "user";
    const collapsible = !mine && message.content.length > LONG && !quotes.length;
    const open = expanded.has(message.episode_id);
    const text = el("div", { class: "bubble-text" + (collapsible && !open ? " collapsed" : "") },
      R.markQuotes(message.content, quotes).map((s) => (s.mark ? el("mark", {}, s.text) : s.text)));
    return el("li", { class: "msg " + message.role + (message.episode_id === state.highlight ? " highlight" : ""), "data-episode": message.episode_id },
      el("div", { class: "avatar", "aria-hidden": "true" }, mine ? "Vy" : message.role === "assistant" ? "AI" : "·"),
      el("div", { class: "msg-body" },
        el("div", { class: "msg-head" }, el("strong", {}, R.ROLE[message.role] ? R.ROLE[message.role][0].toUpperCase() + R.ROLE[message.role].slice(1) : message.role), " · ", R.when(message.occurred_at)),
        el("div", { class: "bubble" }, text,
          collapsible ? el("button", { type: "button", class: "link more", onclick: () => { open ? expanded.delete(message.episode_id) : expanded.add(message.episode_id); render(); } }, open ? "Zobrazit méně" : "Zobrazit celou odpověď (" + message.content.length + " znaků)") : null),
        message.derived.length
          ? el("div", { class: "derived" }, el("div", { class: "meta" }, "Z této zprávy vzniklo:"), el("ul", { class: "chips" }, message.derived.map(derivedChip)))
          : null));
  }

  function render() {
    const list = $("conv-list");
    list.replaceChildren();
    if (!S.connected) {
      $("conv-info").textContent = "Připojte se tokenem – bez něj se nic nezobrazí.";
      $("conv-detail").replaceChildren(); $("conv-pager").hidden = true;
      return;
    }
    fillSources();
    const filtered = state.q.trim() || state.source;
    $("conv-info").textContent = filtered
      ? "Nalezeno " + state.matching + " z " + state.total + " konverzací."
      : "Konverzací: " + state.total + (state.sort === "added" ? ". Naposledy přidané nahoře." : ". Nejnovější zprávy nahoře.");
    if (!state.list.length) list.append(el("li", { class: "empty" }, filtered ? "Nic neodpovídá hledání." : "Zatím žádné konverzace."));
    for (const c of state.list) {
      list.append(el("li", { class: "card conv-card" + (same(c, state.current) ? " selected" : ""), tabindex: "0", role: "button",
        onclick: () => openConversation(c.source_system, c.conversation_id).catch((e) => S.say(e.message, true)),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } } },
        el("h3", { class: "title" }, name(c)),
        c.preview && c.preview !== name(c) ? el("p", { class: "preview" }, c.preview) : null,
        c.themes && c.themes.length ? el("ul", { class: "tags", "aria-label": "Témata" }, c.themes.map((t) => el("li", { class: "tag" }, t))) : null,
        el("div", { class: "stats" },
          el("span", {}, c.source_system + " · " + c.messages + " zpráv · " + R.when(c.first_at) + (c.messages > 1 && R.when(c.last_at) !== R.when(c.first_at) ? " – " + R.when(c.last_at) : "")),
          c.derived.candidate ? el("span", { class: "stat-pill candidate" }, c.derived.candidate + " čeká") : null,
          c.derived.confirmed ? el("span", { class: "stat-pill confirmed" }, c.derived.confirmed + " potvrzeno") : null,
          !c.derived.candidate && !c.derived.confirmed && !c.derived.rejected ? el("span", { class: "stat-pill" }, "bez návrhů") : null)));
    }
    S.pager($("conv-pager"), { page: state.page, total: state.matching, size: PAGE, hasNext: state.more }, goToPage);
    const detail = $("conv-detail");
    if (!state.detail) {
      detail.replaceChildren(...[state.flash ? el("div", { class: "note", role: "status" }, state.flash) : null, el("p", { class: "empty" }, "Vyberte konverzaci vlevo.")].filter(Boolean));
      return;
    }
    state.flash = null;
    detail.replaceChildren(
      el("h3", { class: "chat-title" }, name(state.detail)),
      el("div", { class: "meta" }, state.detail.source_system + " · zpráv: " + state.detail.messages.length + " · ",
        el("button", { type: "button", class: "link", onclick: () => S.show("graph", { scope: { kind: "conversation", source_system: state.detail.source_system, conversation_id: state.detail.conversation_id } }) }, "zobrazit jako graf")),
      el("p", { class: "actions" },
        el("button", { type: "button", onclick: reprocess }, "Znovu projít modelem"), " ",
        el("button", { type: "button", class: armed ? "no" : "", onclick: remove }, armed ? "Opravdu smazat? Klikněte znovu" : "Smazat konverzaci"),
        armed ? [" ", el("button", { type: "button", class: "link", onclick: () => { armed = false; render(); } }, "Zrušit")] : null),
      el("div", { id: "conv-action", class: "note", hidden: true, role: "status" }),
      el("ol", { class: "messages chat" }, state.detail.messages.map(bubble)));
  }

  S.register("conversations", {
    async load() {
      await loadList(state.page);
      // An open conversation is reloaded too, so it does not show what has since changed or been deleted.
      if (state.current) {
        try { state.detail = await S.call("GET", path(state.current)); }
        catch (error) { state.detail = null; state.current = null; }
      }
    },
    async show(params) {
      if (params && params.conversation_id) await openConversation(params.source_system, params.conversation_id, params.highlight);
      else render();
    },
    clear() {
      state.list = []; state.total = 0; state.matching = 0; state.cursors = [null]; state.page = 0; state.more = false;
      state.current = null; state.detail = null; state.highlight = null; render();
    },
  });
  let typing = null;
  $("conv-q").addEventListener("input", (e) => { state.q = e.target.value; clearTimeout(typing); typing = setTimeout(refreshList, 300); });
  $("conv-source").addEventListener("change", (e) => { state.source = e.target.value; refreshList(); });
  $("conv-sort").addEventListener("change", (e) => { state.sort = e.target.value; refreshList(); });
})();
