const test = require("node:test");
const assert = require("node:assert/strict");
const I = require("../../src/active_memory/ui/paste_logic.js");

test("splits by speaker markers, including 'You said:' with the text on the next line", () => {
  const r = I.parsePaste("You said:\nAhoj, potřebuji radu\nse zahradou.\nChatGPT said:\nSamozřejmě.\n\nVy: Díky\n**Claude:** Rádo se stalo");
  assert.equal(r.marked, true);
  assert.deepEqual(r.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(r.messages[0].content, "Ahoj, potřebuji radu\nse zahradou.");
  assert.equal(r.messages[2].content, "Díky");
  assert.equal(r.messages[3].content, "Rádo se stalo");
});

test("no markers: one user message and not marked; text before the first marker is counted, not guessed", () => {
  const plain = I.parsePaste("jen nějaký text\ns řádky");
  assert.deepEqual([plain.marked, plain.messages.length, plain.messages[0].role], [false, 1, "user"]);
  const lead = I.parsePaste("úvod před značkou\nVy: ahoj");
  assert.equal(lead.messages.length, 1);
  assert.ok(lead.preamble > 0);
  assert.deepEqual(I.parsePaste("   ").messages, []);
});

test("Claude Code terminal copy: '> ' is the user, '● ' the assistant; a lone quote is not a speaker", () => {
  const r = I.parsePaste("> kde se ukládají konverzace?\n\n● Obojí leží v profilu.\n  Další řádek.\n\n> díky\n● Rádo se stalo");
  assert.deepEqual(r.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(r.messages[0].content, "kde se ukládají konverzace?");
  assert.equal(r.messages[1].content, "Obojí leží v profilu.\n  Další řádek.");
  const quote = I.parsePaste("> jen citace\nběžný text");
  assert.deepEqual([quote.marked, quote.messages.length], [false, 1]);
});

test("text without markers: paragraphs assigned by hand are merged into messages", () => {
  const blocks = I.splitBlocks("otázka\n\nodpověď 1\n\nodpověď 2\r\n \r\nvaše druhá\n\ndalší odpověď");
  assert.equal(blocks.length, 5);
  const marks = I.defaultMarks(blocks.length);
  assert.deepEqual(marks, ["user", "assistant", "", "", ""]);
  let m = I.fromBlocks(blocks, marks);
  assert.deepEqual(m.map((x) => x.role), ["user", "assistant"]);
  assert.equal(m[1].content, "odpověď 1\n\nodpověď 2\n\nvaše druhá\n\ndalší odpověď");
  marks[3] = "user"; marks[4] = "assistant";
  m = I.fromBlocks(blocks, marks);
  assert.deepEqual(m.map((x) => x.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(m[2].content, "vaše druhá");
  assert.equal(I.fromBlocks(["a", "b"], ["", ""])[0].role, "user");
});

test("a normal sentence is not taken for a marker; CRLF is handled", () => {
  const r = I.parsePaste("Vy: použij model tak, aby ty: nebyl značkou\r\nAI: ano");
  assert.deepEqual(r.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(r.messages[0].content, "použij model tak, aby ty: nebyl značkou");
});

test("ids are stable for the same paste and differ with title, date, content or roles", () => {
  const m = I.parsePaste("Vy: a\nAI: b").messages;
  const a = I.pasteBodies(m, "Zahrada", "2026-10-14");
  const b = I.pasteBodies(m, "Zahrada", "2026-10-14");
  assert.deepEqual(a, b);
  assert.equal(a[0].occurred_at, "2026-10-14T12:00:00.000Z");
  assert.equal(a[1].occurred_at, "2026-10-14T12:01:00.000Z");
  assert.deepEqual(a.map((x) => x.message_id), ["1", "2"]);
  assert.notEqual(I.pasteBodies(m, "Zahrada", "2026-10-15")[0].conversation_id, a[0].conversation_id);
  const flipped = [{ ...m[0], role: "assistant" }, m[1]];
  assert.notEqual(I.pasteBodies(flipped, "Zahrada", "2026-10-14")[0].conversation_id, a[0].conversation_id);
  assert.match(a[0].conversation_id, /^Zahrada \(vloženo 2026-10-14, [0-9a-f]{1,8}\)$/);
  assert.match(I.pasteBodies(m, "a/b\\c", "2026-10-14")[0].conversation_id, /^a b c \(/);
  assert.match(I.pasteBodies(m, "  ", "2026-10-14")[0].conversation_id, /^Vložená konverzace/);
});

const fs = require("node:fs");
const path = require("node:path");
const fixture = (name) => fs.readFileSync(path.join(__dirname, "../../examples/test-conversations", name), "utf-8");

test("every generated plain-text fixture splits into alternating user/assistant messages", () => {
  for (const f of fs.readdirSync(path.join(__dirname, "../../examples/test-conversations")).filter((n) => /^text-(chatgpt|claude|gemini|claude-code)-/.test(n))) {
    const r = I.parsePaste(fixture(f));
    assert.equal(r.marked, true, f);
    assert.ok(r.messages.length >= 4, f);
    assert.ok(r.messages.every((m, i) => m.role === (i % 2 ? "assistant" : "user")), f);
  }
});

test("ChatGPT export: current branch only, system messages skipped, original times and ids kept", () => {
  const p = I.parseExport(fixture("export-chatgpt-conversations.json"));
  assert.equal(p.format, "chatgpt");
  assert.equal(p.conversations.length, 3);
  const c = p.conversations[0];
  assert.deepEqual(c.messages.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.equal(c.messages[0].at, "2026-09-12T08:30:00.000Z");
  const bodies = I.exportBodies(p, "2026-10-23");
  assert.equal(bodies[0].source_system, "chatgpt-export");
  assert.equal(bodies[0].conversation_id, "chatgpt-zahrada");
  assert.equal(bodies[0].message_id, "zahrada-n0");
});

test("claude.ai export maps human to user", () => {
  const p = I.parseExport(fixture("export-claude-conversations.json"));
  assert.equal(p.format, "claude");
  assert.equal(p.conversations[2].messages[0].role, "user");
  assert.equal(p.conversations[2].title, "Automatizace rozhodování");
  assert.equal(I.exportBodies(p, "2026-10-23")[0].source_system, "claude-export");
});

test("Gemini Takeout activity: prompt and HTML answer, grouped by day, oldest first", () => {
  const p = I.parseExport(fixture("export-gemini-takeout-MyActivity.json"));
  assert.equal(p.format, "gemini");
  assert.equal(p.conversations.length, 3);
  const first = p.conversations[0].messages;
  assert.equal(first[0].role, "user");
  assert.ok(!first[0].content.startsWith("Prompted"));
  assert.ok(!/[<>]/.test(first[1].content));
});

test("chat API message lists: system dropped, model becomes assistant, content blocks flattened", () => {
  for (const f of ["api-openai-messages.json", "api-anthropic-messages.json", "api-gemini-contents.json"]) {
    const p = I.parseExport(fixture(f));
    assert.equal(p.format, "api", f);
    assert.deepEqual(p.conversations[0].messages.map((m) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant"], f);
  }
  const bare = I.parseExport(JSON.stringify([{ role: "user", content: "ahoj" }, { role: "assistant", content: "čau" }]));
  assert.equal(bare.conversations[0].messages.length, 2);
});

test("not an export: ordinary text, unknown JSON and broken JSON return null", () => {
  assert.equal(I.parseExport("Vy: ahoj"), null);
  assert.equal(I.parseExport("{\"a\": 1}"), null);
  assert.equal(I.parseExport("[{\"role\": \"user\""), null);
  assert.equal(I.parseExport("[]"), null);
});

test("export ids without originals are derived, stable and overlong messages are dropped", () => {
  const raw = JSON.stringify([{ role: "user", content: "x".repeat(I.LIMIT + 1) }, { role: "assistant", content: "ok" }]);
  const a = I.exportBodies(I.parseExport(raw), "2026-10-23"), b = I.exportBodies(I.parseExport(raw), "2026-10-23");
  assert.equal(a.length, 1);
  assert.deepEqual(a, b);
});
