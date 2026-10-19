// Paste view: a conversation copied from any chat. The text is split into messages by speaker
// markers in this page, shown for correction (who speaks can be flipped), and only then sent.
// Messages arrive as candidates through the same API as every other producer. All text is shown
// as text only.
(function () {
  "use strict";
  const S = window.AMShell;
  const $ = (id) => document.getElementById(id);
  const state = { messages: [], running: false };

  function say(text, isError) {
    $("paste-result").textContent = text || "";
    $("paste-result").className = "note" + (isError ? " error" : "");
    $("paste-result").hidden = !text;
  }

  const today = () => new Date().toISOString().slice(0, 10);
  const ROLE = { user: "Vy", assistant: "Asistent" };

  const NEXT = { "": "user", user: "assistant", assistant: "" };

  // Text without speaker markers: every paragraph is listed and the person says where a message
  // starts and who speaks (click cycles: continuation → you → assistant).
  function paintBlocks() {
    const ol = $("paste-list");
    ol.replaceChildren();
    state.blocks.forEach((text, i) => {
      const mark = state.marks[i] || (i === 0 ? "user" : "");
      const who = document.createElement("button");
      who.type = "button"; who.className = "link";
      who.textContent = (mark ? "Nová zpráva: " + ROLE[mark] : "pokračování předchozí zprávy") + " (změnit)";
      who.addEventListener("click", () => {
        state.marks[i] = NEXT[state.marks[i] || ""];
        state.messages = window.AMPaste.fromBlocks(state.blocks, state.marks);
        paint();
      });
      const head = document.createElement("div");
      head.append(who);
      const body = document.createElement("div");
      body.className = "quote";
      body.textContent = text.length > 300 ? text.slice(0, 300) + "…" : text;
      const li = document.createElement("li");
      li.append(head, body);
      ol.append(li);
    });
    $("paste-send").hidden = !state.messages.length;
    $("paste-send").textContent = "Odeslat (" + state.messages.length + " zpráv)";
  }

  function paint() {
    if (state.blocks) return paintBlocks();
    const ol = $("paste-list");
    ol.replaceChildren();
    state.messages.forEach((m) => {
      const who = document.createElement("button");
      who.type = "button"; who.className = "link"; who.textContent = ROLE[m.role] + " (změnit)";
      who.addEventListener("click", () => { m.role = m.role === "user" ? "assistant" : "user"; paint(); });
      const head = document.createElement("div");
      head.append(who);
      const body = document.createElement("div");
      body.className = "quote";
      body.textContent = m.content.length > 600 ? m.content.slice(0, 600) + "…" : m.content;
      const li = document.createElement("li");
      li.append(head, body);
      ol.append(li);
    });
    $("paste-send").hidden = !state.messages.length;
    $("paste-send").textContent = "Odeslat (" + state.messages.length + " zpráv)";
  }

  function parse() {
    say("");
    const r = window.AMPaste.parsePaste($("paste-text").value);
    state.messages = r.messages;
    state.blocks = null;
    if (!r.marked) {
      const blocks = window.AMPaste.splitBlocks($("paste-text").value);
      if (blocks.length > 1) {
        state.blocks = blocks; state.marks = window.AMPaste.defaultMarks(blocks.length);
        state.messages = window.AMPaste.fromBlocks(blocks, state.marks);
        $("paste-preview").textContent = "Nenašel jsem značky mluvčích. Text je rozdělen na odstavce: první je vaše zpráva, druhý odpověď, zbytek pokračuje. Klikáním u odstavců určete, kde začíná nová zpráva a kdo mluví.";
        return paint();
      }
    }
    $("paste-preview").textContent = !r.messages.length ? "Není co odeslat: vložte text konverzace."
      : r.marked ? "Rozděleno na " + r.messages.length + " zpráv podle značek mluvčích." + (r.preamble ? " Text před první značkou (" + r.preamble + " znaků) se nepoužije." : "") + " Zkontrolujte, kdo mluví."
      : "Nenašel jsem značky mluvčích, vše je jedna zpráva od vás. Přidejte na začátek odpovědí například „ChatGPT:“ a rozdělte znovu.";
    paint();
  }

  function reset() {
    state.messages = []; state.blocks = null; $("paste-text").value = ""; $("paste-title").value = "";
    $("paste-preview").textContent = ""; $("paste-list").replaceChildren(); $("paste-send").hidden = true;
  }

  async function send() {
    if (state.running || !state.messages.length) return;
    const day = $("paste-day").value || today();
    const bodies = window.AMPaste.pasteBodies(state.messages, $("paste-title").value, day);
    const skipped = state.messages.length - bodies.length;
    state.running = true; $("paste-send").disabled = true;
    let fresh = 0; const rejected = [];
    let sent = false;
    try {
      for (const body of bodies) {
        try {
          const r = await S.call("POST", "/v1/episodes", body);
          if (!r.duplicate) fresh++;
        } catch (error) {
          if (error.status !== 422 && error.status !== 409) throw error;
          rejected.push(error.message);
        }
      }
      say("Odesláno " + bodies.length + " zpráv, nových " + fresh +
        (rejected.length ? ", odmítnuto serverem " + rejected.length + " (např. podezření na heslo nebo klíč v textu: " + rejected[0] + ")" : "") +
        (skipped ? ", přeskočeno delších než " + window.AMPaste.LIMIT + " znaků: " + skipped : "") +
        ". Stejné vložení znovu nic nezdvojí. Najdete to v Konverzacích pod názvem s datem vložení.", rejected.length > 0);
      sent = !rejected.length && !skipped;
    } catch (error) {
      say("Odesílání se zastavilo: " + error.message + (error.status === 403 ? " Vkládání potřebuje token s právem zápisu (write)." : ""), true);
    } finally {
      state.running = false; $("paste-send").disabled = false; S.markDirty();
      // After a clean send the form is emptied for the next paste; the result note stays.
      if (sent) {
        const note = $("paste-result").textContent;
        reset(); say(note);
      }
    }
  }

  S.register("paste", {
    async load() {},
    show() {
      $("paste-info").textContent = S.connected ? "" : "Připojte se tokenem – bez něj se nic neodešle.";
      if (!$("paste-day").value) $("paste-day").value = today();
    },
    clear() { reset(); say(""); },
  });
  $("open-paste").addEventListener("click", () => S.show("paste"));
  $("paste-back").addEventListener("click", () => S.show("conversations"));
  $("paste-parse").addEventListener("click", parse);
  $("paste-send").addEventListener("click", send);
})();
