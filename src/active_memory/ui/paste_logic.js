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

  const api = { LIMIT, parsePaste, splitBlocks, defaultMarks, fromBlocks, pasteBodies, hash };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AMPaste = api;
})(typeof window !== "undefined" ? window : globalThis);
