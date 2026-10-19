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
