const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../../src/active_memory/ui/graph_logic.js");

const ev = (conv, ep) => ({ episode_id: ep || "e-" + conv, quote: "q", source_system: "s", conversation_id: conv });
const node = (id, kind, status, convs, extra) => Object.assign({ id, kind, label: "L" + id, status, strength: 1, evidence: convs.map((c) => ev(c)) }, extra);
const edge = (id, source_id, target_id, relation, status) => ({ id, source_id, target_id, relation, status });

const map = {
  nodes: [
    node("t1", "Theme", "candidate", ["a", "b"]),
    node("g1", "Goal", "candidate", ["a"]),
    node("x1", "Thought", "candidate", ["b"]),
    node("r1", "Thought", "rejected", ["a"]),
  ],
  edges: [
    edge("e1", "g1", "t1", "ABOUT", "candidate"),
    edge("e2", "x1", "t1", "ABOUT", "confirmed"),
    edge("e3", "g1", "x1", "SUPPORTS", "candidate"),
    edge("e4", "r1", "t1", "ABOUT", "candidate"),
    edge("e5", "g1", "x1", "CONTRADICTS", "rejected"),
  ],
};

test("conversation scope shows its items, their themes and where each came from", () => {
  const g = G.buildGraph(map, { kind: "conversation", source_system: "s", conversation_id: "a" });
  assert.deepEqual(g.nodes.filter((n) => n.type === "node").map((n) => n.id).sort(), ["g1", "t1"]);
  assert.ok(g.nodes.some((n) => n.id === "conv:s/a") && g.nodes.some((n) => n.id === "conv:s/b"), "theme also came from chat b");
  assert.ok(g.edges.some((e) => e.relation === "ABOUT" && e.source === "g1"));
  assert.ok(g.edges.some((e) => e.type === "origin" && e.source === "conv:s/b" && e.target === "t1"));
});

test("rejected nodes and edges are never drawn", () => {
  const g = G.buildGraph(map, { kind: "all" });
  assert.ok(!g.nodes.some((n) => n.id === "r1"));
  assert.ok(!g.edges.some((e) => e.id === "e4" || e.id === "e5"));
});

test("theme scope includes members and relations between them", () => {
  const g = G.buildGraph(map, { kind: "theme", id: "t1" });
  assert.deepEqual(g.nodes.filter((n) => n.type === "node").map((n) => n.id).sort(), ["g1", "t1", "x1"]);
  assert.ok(g.edges.some((e) => e.relation === "SUPPORTS"));
  assert.deepEqual(G.buildGraph(map, { kind: "theme", id: "missing" }).nodes, []);
});

test("the graph is capped and says so", () => {
  const many = { nodes: [], edges: [] };
  for (let i = 0; i < 100; i++) many.nodes.push(node("n" + i, "Thought", "candidate", ["a"], { strength: i }));
  const g = G.buildGraph(many, { kind: "all" });
  assert.equal(g.shown, G.MAX_NODES);
  assert.equal(g.truncated, true);
  assert.equal(g.total, 100);
  assert.ok(g.nodes.some((n) => n.id === "n99"), "the strongest survive");
  assert.equal(G.buildGraph(map, { kind: "all" }).truncated, false);
});

test("conversations and themes are listed for the scope pickers", () => {
  assert.deepEqual(G.conversations(map).map((c) => [c.conversation_id, c.count]), [["a", 2], ["b", 2]]);
  assert.deepEqual(G.themes(map).map((t) => t.id), ["t1"]);
});

test("display filters hide conversations or unconfirmed items without leaving dangling edges", () => {
  const g = G.buildGraph(map, { kind: "all" });
  const ids = (x) => x.nodes.map((n) => n.id).sort();
  const noConv = G.filterGraph(g, { conversations: false });
  assert.ok(noConv.nodes.every((n) => n.type === "node") && noConv.edges.every((e) => e.type === "relation"));
  assert.equal(G.filterGraph(g, {}).nodes.length, g.nodes.length);
  const sure = G.filterGraph(g, { onlyConfirmed: true });
  assert.deepEqual(ids(sure).filter((id) => !id.startsWith("conv:")), []);
  const ok = { nodes: [{ id: "a", type: "node", status: "confirmed" }, { id: "b", type: "node", status: "candidate" }], edges: [{ id: "e", source: "a", target: "b", type: "relation", status: "confirmed" }] };
  const only = G.filterGraph(ok, { onlyConfirmed: true });
  assert.deepEqual(only.nodes.map((n) => n.id), ["a"]);
  assert.deepEqual(only.edges, []);
});

test("degrees count relations only and a neighbourhood is the node, its neighbours and their edges", () => {
  const g = G.buildGraph(map, { kind: "all" });
  const d = G.degrees(g);
  assert.equal(d.get("t1"), 2);
  assert.equal(d.get("g1"), 2);
  const n = G.neighbourhood(g, "g1");
  assert.ok(n.nodes.has("g1") && n.nodes.has("t1") && n.nodes.has("x1"));
  assert.ok(n.edges.has("e1") && n.edges.has("e3") && !n.edges.has("e2"));
});
