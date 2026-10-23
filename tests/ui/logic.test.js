const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../../src/active_memory/ui/logic.js");

const ev = (episode, chat, at, quote) => ({
  episode_id: episode, quote, role: "user", occurred_at: at,
  source_system: "s", conversation_id: chat, message_id: "m-" + episode,
});
const node = (id, kind, label, extra) => Object.assign(
  { id, kind, label, summary: label + " souhrn", status: "candidate", confidence: 0.5,
    valid_from: null, valid_to: null, evidence: [ev(id, "c1", "2026-10-01T10:00:00+00:00", label)],
    activity: 0.5, strength: 1, conversation_count: 1, last_seen: "2026-10-01T10:00:00+00:00" }, extra || {});

const map = {
  nodes: [
    node("t1", "Theme", "Lidská kontrola", { activity: 1.2, status: "confirmed" }),
    node("t2", "Theme", "Běhání", { activity: 0.3 }),
    node("t3", "Theme", "Ranní klus", { activity: 0.2 }),
    node("a", "Thought", "Poslední slovo", { last_seen: "2026-09-01T00:00:00+00:00" }),
    node("b", "Thought", "Bez schválení", { last_seen: "2026-10-05T00:00:00+00:00" }),
    node("r", "Thought", "Odmítnuté", { status: "rejected" }),
    node("d1", "Decision", "PostgreSQL", { valid_from: "2026-06-01T00:00:00Z", valid_to: "2026-10-01T00:00:00Z" }),
    node("d2", "Decision", "Neo4j", { valid_from: "2026-10-01T00:00:00Z" }),
  ],
  edges: [
    { id: "e1", source_id: "a", target_id: "t1", relation: "ABOUT", status: "candidate", evidence: [] },
    { id: "e2", source_id: "b", target_id: "t1", relation: "ABOUT", status: "confirmed", evidence: [] },
    { id: "e3", source_id: "r", target_id: "t1", relation: "ABOUT", status: "candidate", evidence: [] },
    { id: "e4", source_id: "d2", target_id: "d1", relation: "SUPERSEDES", status: "candidate", evidence: [], origin: "proposal",
      proposal: { score: 0.9, method: "temporal", reason: "adjacent", signals: { shared_neighbours: 1 } } },
  ],
  clusters: [{ id: "c", members: ["t2", "t3"], labels: ["Běhání", "Ranní klus"] }],
  truncated: false,
};

test("themes are ordered by activity and carry their alias cluster", () => {
  const rows = L.themeRows(map, {});
  assert.deepEqual(rows.map((r) => r.node.id), ["t1", "t2", "t3"]);
  assert.equal(rows[1].cluster.labels.length, 2);
  assert.equal(rows[0].cluster, null);
});

test("filters keep candidates visible and never promote them", () => {
  assert.deepEqual(L.themeRows(map, { status: "candidate" }).map((r) => r.node.id), ["t2", "t3"]);
  assert.deepEqual(L.themeRows(map, { text: "BĚH" }).map((r) => r.node.id), ["t2"]);
  assert.ok(L.themeRows(map, { status: "all" }).every((r) => r.node.kind === "Theme"));
});

test("related items group by kind, newest first, rejected hidden by default", () => {
  const groups = L.relatedItems(map, "t1");
  assert.deepEqual(groups.Thought.map((g) => g.node.id), ["b", "a"]);
  assert.equal(Object.keys(groups).length, 1);
  const all = L.relatedItems(map, "t1", { showRejected: true });
  assert.equal(all.Thought.length, 3);
});

test("quote segments mark the exact quote and never produce markup", () => {
  const parts = L.quoteSegments("Ahoj <b>svět</b>, chci lidskou kontrolu.", "lidskou kontrolu");
  assert.deepEqual(parts.map((p) => p.mark), [false, true, false]);
  assert.equal(parts.map((p) => p.text).join(""), "Ahoj <b>svět</b>, chci lidskou kontrolu.");
  assert.deepEqual(L.quoteSegments("text", "chybí"), [{ text: "text", mark: false }]);
  assert.deepEqual(L.quoteSegments("celé", "celé"), [{ text: "celé", mark: true }]);
});

test("validity shows exclusive end and unknown validity honestly", () => {
  assert.equal(L.formatValidity(map.nodes[6]), "platí 2026-06-01 – 2026-10-01 (konec je vyloučen)");
  assert.equal(L.formatValidity(map.nodes[7]), "platí 2026-10-01 – … (konec je vyloučen)");
  assert.equal(L.formatValidity(map.nodes[0]), "platnost neuvedena");
});

test("change links resolve both directions and wording", () => {
  const newer = L.linksOf(map, "d2");
  assert.equal(newer.length, 1);
  assert.equal(L.describeLink(newer[0].edge, newer[0].direction), "nahrazuje");
  const older = L.linksOf(map, "d1");
  assert.equal(L.describeLink(older[0].edge, older[0].direction), "je nahrazeno");
  assert.equal(L.linksOf(map, "t1").length, 0);
});

test("timeline orders evidence by time and conversations are unique", () => {
  const n = node("x", "Thought", "x");
  n.evidence = [ev("2", "c2", "2026-10-03T00:00:00Z", "q2"), ev("1", "c1", "2026-10-01T00:00:00Z", "q1"), ev("3", "c1", "2026-10-02T00:00:00Z", "q3")];
  assert.deepEqual(L.timeline(n).map((e) => e.quote), ["q1", "q3", "q2"]);
  assert.deepEqual(L.conversationsOf(n), ["s / c1", "s / c2"]);
});

test("proposal cards expose score, method, reason and source quotes", () => {
  const card = L.proposalCard(Object.assign({ source: map.nodes[7], target: map.nodes[6] },
    map.edges[3], { evidence: [{ episode_id: "e", quote: "q" }] }));
  assert.equal(card.score, 0.9);
  assert.equal(card.method, "temporal");
  assert.equal(card.relationText, "nahrazuje");
  assert.deepEqual(card.quotes, [{ episode_id: "e", quote: "q" }]);
  assert.equal(card.status, "candidate");
});

test("summary counts candidates and open proposals", () => {
  const s = L.summary(map, [{ status: "candidate" }, { status: "confirmed" }]);
  assert.equal(s.themes, 3);
  assert.equal(s.openProposals, 1);
  assert.equal(s.candidates, 6);
});

test("theme links (ABOUT) are not counted as proposals", () => {
  const s = L.summary(map, [
    { status: "candidate", relation: "ABOUT" }, { status: "candidate", relation: "ABOUT" },
    { status: "candidate", relation: "SUPPORTS" }, { status: "confirmed", relation: "SUPPORTS" },
  ]);
  assert.equal(s.openProposals, 1);
});

test("themes: themes recurring in more chats come first, rejected ones are hidden by the 'active' filter", () => {
  const L = require("../../src/active_memory/ui/logic.js");
  const theme = (id, label, status, chats, activity) => ({ id, kind: "Theme", label, summary: label, status, conversation_count: chats, activity, evidence: [] });
  const map = { nodes: [theme("a", "Zahrada", "candidate", 1, 0.9), theme("b", "Automatizace", "candidate", 3, 0.1), theme("c", "Spánek", "rejected", 5, 1)], edges: [], clusters: [] };
  assert.deepEqual(L.themeRows(map, { status: "active" }).map((r) => r.node.id), ["b", "a"]);
  assert.deepEqual(L.themeRows(map, { status: "all" }).map((r) => r.node.id), ["c", "b", "a"]);
  assert.deepEqual(L.themeRows(map, { status: "rejected" }).map((r) => r.node.id), ["c"]);
});

test("pageInfo keeps the page in range and describes the slice", () => {
  const L = require("../../src/active_memory/ui/logic.js");
  assert.deepEqual(L.pageInfo(0, 3, 10), { page: 0, pages: 1, from: 0, to: 0, total: 0, size: 10, start: 0, end: 0, hasPrev: false, hasNext: false });
  const mid = L.pageInfo(45, 2, 20);
  assert.deepEqual([mid.page, mid.pages, mid.from, mid.to, mid.start, mid.end, mid.hasPrev, mid.hasNext], [2, 3, 41, 45, 40, 45, true, false]);
  assert.equal(L.pageInfo(45, 9, 20).page, 2); // a list that shrank clamps to the last page
  assert.equal(L.pageInfo(45, -4, 20).page, 0);
});
