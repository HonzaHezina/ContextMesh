// Conversations view: the messages as delivered, and under each one what was derived from it with
// links to the review queue and the topic map. Read-only; all text is inserted as text.
(function () {
  "use strict";
  const R = window.AMReview;
  const S = window.AMShell;
  const $ = (id) => document.getElementById(id);
  const state = { list: [], total: 0, next: null, more: false, current: null, detail: null, highlight: null };

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
  const same = (a, b) => a && b && a.source_system === b.source_system && a.conversation_id === b.conversation_id;

  async function loadList(append) {
    const query = new URLSearchParams({ limit: "25" });
    if (append && state.next) query.set("cursor", state.next);
    const page = await S.call("GET", "/v1/conversations?" + query);
    state.list = append ? state.list.concat(page.conversations) : page.conversations;
    state.total = page.total; state.next = page.next_cursor; state.more = page.has_more;
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

  // The model reads the user's messages again and may find more; nothing existing is changed.
  async function reprocess() {
    const c = state.detail;
    try {
      const r = await S.call("POST", path(c) + "/reprocess");
      S.say(r.queued
        ? "Zařazeno k novému projití modelem: " + r.queued + " zpráv. Nové nálezy se objeví mezi kandidáty; stávající se nemění."
        : "Nic k novému projití: zprávy se právě zpracovávají nebo ještě nedoběhly.");
      S.markDirty();
    } catch (error) {
      S.say(error.status === 409 ? "Model pro extrakci není nastaven (Nastavení) – není čím konverzaci znovu projít." : error.message, true);
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
      await loadList(false);
      S.markDirty();
      render();
      S.say("Smazáno zpráv: " + r.messages + ". Odvozené návrhy, které stály jen na nich, zmizely také. Zálohy se řídí postupem uchování.");
    } catch (error) {
      S.say(error.message, true);
      render();
    }
  }

  function counts(derived) {
    const parts = [];
    if (derived.candidate) parts.push(derived.candidate + " čeká na rozhodnutí");
    if (derived.confirmed) parts.push(derived.confirmed + " potvrzeno");
    if (derived.rejected) parts.push(derived.rejected + " zamítnuto");
    return parts.length ? parts.join(" · ") : "nic z ní nevzniklo";
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
      $("conv-detail").replaceChildren(); $("conv-more").hidden = true;
      return;
    }
    $("conv-info").textContent = "Konverzací: " + state.total + ". Nejnovější nahoře.";
    if (!state.list.length) list.append(el("li", { class: "empty" }, "Zatím žádné konverzace."));
    for (const c of state.list) {
      list.append(el("li", { class: "card conv-card" + (same(c, state.current) ? " selected" : ""), tabindex: "0", role: "button",
        onclick: () => openConversation(c.source_system, c.conversation_id).catch((e) => S.say(e.message, true)),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } } },
        el("h3", { class: "title" }, c.conversation_id),
        el("div", { class: "meta" }, c.source_system + " · zpráv: " + c.messages + " · " + R.when(c.first_at) + (c.messages > 1 ? " – " + R.when(c.last_at) : "")),
        el("div", { class: "meta" }, counts(c.derived))));
    }
    $("conv-more").hidden = !state.more;
    const detail = $("conv-detail");
    if (!state.detail) { detail.replaceChildren(el("p", { class: "empty" }, "Vyberte konverzaci vlevo.")); return; }
    detail.replaceChildren(
      el("h3", { class: "chat-title" }, state.detail.conversation_id),
      el("div", { class: "meta" }, state.detail.source_system + " · zpráv: " + state.detail.messages.length + " · ",
        el("button", { type: "button", class: "link", onclick: () => S.show("graph", { scope: { kind: "conversation", source_system: state.detail.source_system, conversation_id: state.detail.conversation_id } }) }, "zobrazit jako graf")),
      el("p", { class: "actions" },
        el("button", { type: "button", onclick: reprocess }, "Znovu projít modelem"), " ",
        el("button", { type: "button", class: armed ? "no" : "", onclick: remove }, armed ? "Opravdu smazat? Klikněte znovu" : "Smazat konverzaci"),
        armed ? [" ", el("button", { type: "button", class: "link", onclick: () => { armed = false; render(); } }, "Zrušit")] : null),
      el("ol", { class: "messages chat" }, state.detail.messages.map(bubble)));
  }

  S.register("conversations", {
    async load() { await loadList(false); },
    async show(params) {
      if (params && params.conversation_id) await openConversation(params.source_system, params.conversation_id, params.highlight);
      else render();
    },
    clear() {
      state.list = []; state.total = 0; state.next = null; state.more = false;
      state.current = null; state.detail = null; state.highlight = null; render();
    },
  });
  $("conv-more").addEventListener("click", () => loadList(true).then(render).catch((e) => S.say(e.message, true)));
})();
