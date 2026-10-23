// Pure logic of the paste view: split pasted text into messages and build the messages for the
// episodes API. No DOM and no network, so it is unit-tested in Node.
(function (root) {
  "use strict";

  const LIMIT = 50000;

  // ---- pasted conversation --------------------------------------------------------------
  // Speaker markers at the start of a line: "Vy:", "You said:", "ChatGPT:", "**Claude:**" ...
  const USER = /^\s*(?:\*\*)?(?:you|vy|ty|já|user|human|uživatel|me)(?:\s+(?:said|řekl[a]?|napsal[a]?))?\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.*)$/i;
  const BOT = /^\s*(?:\*\*)?(?:chatgpt|gpt-?\d[\w.-]*|claude|gemini|mistral|le chat|copilot|assistant|asistent|ai|model)(?:\s+(?:said|řekl[a]?|napsal[a]?|odpověděl[a]?))?\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.*)$/i;

  // Split pasted text into messages by speaker markers. Without any marker the whole text is one
  // user message (`marked` is false so the page can warn). Text before the first marker is not
  // guessed into a message; its length is reported instead.
  // Claude Code terminal copy: "> " starts a user message, "● " an assistant one. Used only when
  // both appear, so an ordinary markdown quote is not taken for a speaker.
  const CC_USER = /^>\s?(.*)$/;
  const CC_BOT = /^●\s?(.*)$/;

  function parsePaste(text) {
    const messages = [];
    let current = null, preamble = 0;
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    const claudeCode = lines.some((l) => CC_USER.test(l)) && lines.some((l) => CC_BOT.test(l));
    for (const line of lines) {
      let role = null, rest = line;
      let m = USER.exec(line);
      if (m) { role = "user"; rest = m[1]; }
      else if ((m = BOT.exec(line))) { role = "assistant"; rest = m[1]; }
      else if (claudeCode && (m = CC_USER.exec(line))) { role = "user"; rest = m[1]; }
      else if (claudeCode && (m = CC_BOT.exec(line))) { role = "assistant"; rest = m[1]; }
      if (role) { current = { role, lines: [rest] }; messages.push(current); }
      else if (current) current.lines.push(line);
      else preamble += line.trim().length;
    }
    const out = messages.map((x) => ({ role: x.role, content: x.lines.join("\n").trim() })).filter((x) => x.content);
    if (!messages.length) {
      const whole = String(text).trim();
      return { messages: whole ? [{ role: "user", content: whole }] : [], marked: false, preamble: 0 };
    }
    return { messages: out, marked: true, preamble };
  }

  // Text without speaker markers: paragraphs (separated by blank lines) that the person assigns by
  // hand. `marks[i]` is "user" or "assistant" where a new message starts, "" for a continuation.
  function splitBlocks(text) {
    return String(text).replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/).map((s) => s.trim()).filter(Boolean);
  }
  function defaultMarks(count) {
    return Array.from({ length: count }, (_, i) => (i === 0 ? "user" : i === 1 ? "assistant" : ""));
  }
  function fromBlocks(blocks, marks) {
    const out = [];
    blocks.forEach((content, i) => {
      if (marks[i] || !out.length) out.push({ role: marks[i] || "user", content });
      else out[out.length - 1].content += "\n\n" + content;
    });
    return out;
  }

  // 53-bit string hash (cyrb53); stable across runs so a repeated paste is recognised, not a security hash.
  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }

  // Messages with ids derived from title, date and content, so pasting the same thing again is a
  // recognised duplicate. Pasted text has no original times: `day` (YYYY-MM-DD) is the date the
  // person gives or today, and the conversation id says it was pasted.
  function pasteBodies(messages, title, day) {
    const name = (String(title).replace(/[\/\\\u0000-\u001f]+/g, " ").trim() || "Vložená konverzace").slice(0, 100);
    const cid = name + " (vloženo " + day + ", " + hash(JSON.stringify([title, day, messages])).slice(0, 8) + ")";
    const base = Date.parse(day + "T12:00:00Z");
    return messages.filter((x) => x.content.length <= LIMIT).map((x, i) => ({
      source_system: "pasted", conversation_id: cid, message_id: String(i + 1), role: x.role, content: x.content,
      occurred_at: new Date(base + i * 60000).toISOString(),
    }));
  }

  // ---- JSON exports of chat services ---------------------------------------------------------
  // Recognises the structure of the data exports (ChatGPT conversations.json, claude.ai
  // conversations.json, Google Takeout Gemini "My Activity") and of the chat-API message arrays
  // (OpenAI, Anthropic, Gemini). Shapes are taken from the documented/known structure, not from
  // the vendors' guarantees, and are tested on synthetic files only. Returns null when the text
  // is not JSON of a known shape, so the caller falls back to speaker-marker parsing.
  const ROLES = { user: "user", human: "user", assistant: "assistant", model: "assistant", ai: "assistant", bot: "assistant" };

  function iso(value) {
    if (value === null || value === undefined || value === "") return null;
    const ms = typeof value === "number" ? (value < 1e11 ? value * 1000 : value) : Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }

  // Text of a message body: a string, or a list of parts ({type:"text",text} / {text} / strings).
  // Non-text parts (images, tool calls, thinking) are left out.
  function textOf(value) {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    return value.map((p) => (typeof p === "string" ? p : p && typeof p.text === "string" && (!p.type || p.type === "text") ? p.text : ""))
      .filter(Boolean).join("\n");
  }

  const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": " " };
  function htmlToText(html) {
    return String(html).replace(/<\s*br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr)>/gi, "\n").replace(/<[^>]*>/g, "")
      .replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (e) => ENTITIES[e]).replace(/\n{3,}/g, "\n\n").trim();
  }

  function chatgptConversation(c) {
    const mapping = c.mapping || {};
    const chain = [], seen = new Set();
    let node = c.current_node;
    while (node && mapping[node] && !seen.has(node)) { seen.add(node); chain.push(mapping[node]); node = mapping[node].parent; }
    const messages = [];
    for (const n of chain.reverse()) {
      const m = n.message;
      const role = m && m.author && ROLES[m.author.role];
      if (!role || !m.content || (m.content.content_type !== "text" && m.content.content_type !== "multimodal_text")) continue;
      const content = textOf(m.content.parts).trim();
      if (content) messages.push({ id: String(m.id || n.id), role, content, at: iso(m.create_time) });
    }
    return { id: String(c.conversation_id || c.id || ""), title: c.title || "", at: iso(c.create_time), messages };
  }

  function claudeConversation(c) {
    const messages = [];
    for (const m of c.chat_messages) {
      const role = ROLES[m.sender];
      const content = (textOf(m.content) || (typeof m.text === "string" ? m.text : "")).trim();
      if (role && content) messages.push({ id: String(m.uuid || ""), role, content, at: iso(m.created_at) });
    }
    return { id: String(c.uuid || ""), title: c.name || "", at: iso(c.created_at), messages };
  }

  // Google Takeout "My Activity" of Gemini Apps: one entry per prompt, the answer is HTML in
  // safeHtmlItem, entries are newest first and have no conversation id, so they are grouped by day.
  function geminiActivity(list) {
    const days = new Map();
    for (const e of list.slice().reverse()) {
      const at = iso(e.time);
      const prompt = String(e.title || "").replace(/^(?:Prompted|Zadáno|Zadali jste)\s*/i, "").trim();
      const answer = htmlToText((e.safeHtmlItem || []).map((h) => (h && h.html) || "").join("\n"));
      const day = (at || "").slice(0, 10) || "bez-data";
      if (!days.has(day)) days.set(day, []);
      const out = days.get(day), n = out.length;
      if (prompt) out.push({ id: day + "-" + (n + 1) + "u", role: "user", content: prompt, at });
      if (answer) out.push({ id: day + "-" + (n + 1) + "a", role: "assistant", content: answer, at });
    }
    return [...days].map(([day, messages]) => ({ id: "gemini-" + day, title: "Gemini " + day, at: messages[0] && messages[0].at, messages }));
  }

  // API-style message list: [{role, content}] (OpenAI, Anthropic) or [{role, parts:[{text}]}] (Gemini).
  // System, developer and tool messages are not conversation and are left out.
  function apiMessages(list) {
    const messages = [];
    for (const m of list) {
      const role = m && ROLES[m.role];
      const content = (typeof m.content === "string" ? m.content : textOf(m.content) || textOf(m.parts) || (typeof m.text === "string" ? m.text : "")).trim();
      if (role && content) messages.push({ id: "", role, content, at: iso(m.created_at || m.timestamp || m.time) });
    }
    return messages;
  }

  function parseExport(text) {
    const raw = String(text).trim();
    if (!/^[\[{]/.test(raw)) return null;
    let data;
    try { data = JSON.parse(raw); } catch (_) { return null; }
    const items = Array.isArray(data) ? data : [data];
    const first = items.find((x) => x && typeof x === "object");
    if (!first) return null;
    let format, conversations;
    if (first.mapping && typeof first.mapping === "object") {
      format = "chatgpt"; conversations = items.map(chatgptConversation);
    } else if (Array.isArray(first.chat_messages)) {
      format = "claude"; conversations = items.filter((c) => c && Array.isArray(c.chat_messages)).map(claudeConversation);
    } else if (items.every((e) => e && (e.header || e.products) && ("title" in e))) {
      format = "gemini"; conversations = geminiActivity(items);
    } else if (!Array.isArray(data) && Array.isArray(data.messages || data.contents)) {
      format = "api"; conversations = [{ id: String(data.id || ""), title: data.title || data.name || "", at: iso(data.created_at), messages: apiMessages(data.messages || data.contents) }];
    } else if (Array.isArray(data) && items.every((m) => m && typeof m === "object" && (m.role in ROLES || m.role === "system"))) {
      format = "api"; conversations = [{ id: "", title: "", at: null, messages: apiMessages(items) }];
    } else {
      return null;
    }
    conversations = conversations.filter((c) => c.messages.length);
    return { format, conversations };
  }

  const EXPORT_SOURCE = { chatgpt: "chatgpt-export", claude: "claude-export", gemini: "gemini-takeout", api: "json-paste" };

  // Episode bodies for every conversation of a parsed export. Original ids and times are kept, so
  // importing the same file again changes nothing; missing ones are derived from content and `day`.
  function exportBodies(parsed, day) {
    const base = Date.parse(day + "T12:00:00Z");
    const out = [];
    for (const c of parsed.conversations) {
      const cid = c.id || (c.title || "Konverzace") + " (JSON " + day + ", " + hash(JSON.stringify(c.messages)).slice(0, 8) + ")";
      c.messages.filter((m) => m.content.length <= LIMIT).forEach((m, i) => out.push({
        source_system: EXPORT_SOURCE[parsed.format], conversation_id: cid, message_id: m.id || String(i + 1),
        role: m.role, content: m.content, occurred_at: m.at || c.at || new Date(base + i * 60000).toISOString(),
      }));
    }
    return out;
  }

  const api = { LIMIT, parsePaste, splitBlocks, defaultMarks, fromBlocks, pasteBodies, hash, parseExport, exportBodies };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AMPaste = api;
})(typeof window !== "undefined" ? window : globalThis);
