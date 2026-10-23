// 3D drawing of the graph view (WebGL via the vendored 3d-force-graph / Three.js). It only draws what
// graph_logic.js already selected: it fetches nothing and parses no server text as HTML. The library's
// own hover tooltip would insert HTML, so it is switched off; labels are our own absolutely positioned
// elements filled with textContent and moved to the projected node position on every frame.
// Candidates are amber, confirmed items green, conversations blue; size follows how many relations touch a node.
// Hovering or selecting a node keeps it and its neighbours bright and dims the rest; a dragged node stays put.
(function () {
  "use strict";
  const L = window.AMGraph;

  function available() {
    if (typeof window.ForceGraph3D !== "function") return false;
    try {
      const probe = document.createElement("canvas");
      return !!(probe.getContext("webgl2") || probe.getContext("webgl"));
    } catch (error) {
      return false;
    }
  }

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function colors() {
    return { fg: css("--fg"), bg: css("--card"), line: css("--muted"), muted: css("--muted"), cand: css("--cand"), ok: css("--ok"), accent: css("--accent") };
  }

  // "#rrggbb" or "#rgb" to rgba(); anything else is returned unchanged (then it is simply not dimmed).
  function faded(color, alpha) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
    if (!m) return color;
    const h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
    return "rgba(" + parseInt(h.slice(0, 2), 16) + "," + parseInt(h.slice(2, 4), 16) + "," + parseInt(h.slice(4), 16) + "," + alpha + ")";
  }

  // Nodes and links are copied: the library replaces link ends by node objects and adds coordinates.
  function data(graph) {
    return {
      nodes: graph.nodes.map((n) => ({ id: n.id, label: n.label, type: n.type, kind: n.kind, status: n.status })),
      links: graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: e.type, relation: e.relation, status: e.status })),
    };
  }

  // handle: {box, scene, layer, labels, ...}; render() returns it, destroy() takes it down.
  function render(box, graph, hooks) {
    const c = colors();
    const degree = L.degrees(graph);
    const handle = { box, graph, labels: new Map(), near: null, hover: null, selected: null, fitted: false, observer: null, resize: null, frame: 0, running: true };
    const lit = (id) => !handle.near || handle.near.nodes.has(id);
    const litLink = (l) => !handle.near || handle.near.edges.has(l.id);
    const nodeColor = (n) => {
      const base = n.type === "conversation" ? c.accent : n.status === "confirmed" ? c.ok : c.cand;
      return lit(n.id) ? base : faded(base, 0.15);
    };
    const linkColor = (l) => {
      const base = l.type === "origin" ? c.muted : l.status === "confirmed" ? c.ok : c.cand;
      return litLink(l) ? base : faded(base, 0.08);
    };
    const layer = document.createElement("div");
    layer.className = "g3d-labels";
    layer.setAttribute("aria-hidden", "true");
    const scene = window.ForceGraph3D()(box)
      .backgroundColor(c.bg)
      .showNavInfo(false)
      .width(box.clientWidth).height(box.clientHeight)
      .nodeLabel(() => "")
      .linkLabel(() => "")
      .nodeColor(nodeColor)
      .nodeVal((n) => (n.type === "conversation" ? 3 : (n.kind === "Theme" ? 6 : 2) + 1.5 * Math.min(degree.get(n.id) || 0, 6)))
      .nodeOpacity(0.95)
      .nodeResolution(16)
      .linkColor(linkColor)
      .linkOpacity(0.75)
      .linkWidth((l) => (l.type === "origin" ? 0 : l.relation === "ABOUT" ? 0.4 : 1.4))
      .linkDirectionalArrowLength((l) => (l.type === "origin" ? 0 : 4))
      .linkDirectionalArrowRelPos(1)
      .linkDirectionalParticles((l) => (l.type === "relation" && l.relation !== "ABOUT" && litLink(l) ? 2 : 0))
      .linkDirectionalParticleWidth(1.6)
      .linkDirectionalParticleSpeed(0.006)
      .linkHoverPrecision(6)
      .cooldownTicks(160)
      .onEngineStop(() => { if (!handle.fitted) { handle.fitted = true; scene.zoomToFit(600, 70); } })
      .onNodeHover((n) => { handle.hover = n ? n.id : null; box.style.cursor = n ? "pointer" : ""; refresh(); })
      .onNodeClick((n) => {
        handle.selected = n.id;
        refresh();
        focus(handle, n.id);
        hooks.onNode(n.id);
      })
      .onNodeDragEnd((n) => { n.fx = n.x; n.fy = n.y; n.fz = n.z; })
      .onLinkClick((l) => hooks.onLink(l.id))
      .onBackgroundClick(() => { handle.selected = null; refresh(); hooks.onBackground(); })
      .graphData(data(graph));
    box.append(layer);
    handle.scene = scene;
    handle.layer = layer;

    // Re-applying an accessor makes the library recompute the colours and particles.
    function refresh() {
      const id = handle.hover || handle.selected;
      handle.near = id ? L.neighbourhood(graph, id) : null;
      scene.nodeColor(nodeColor).linkColor(linkColor).linkDirectionalParticles(scene.linkDirectionalParticles());
    }
    handle.refresh = refresh;

    for (const n of graph.nodes) {
      const tag = document.createElement("span");
      tag.className = "g3d-label" + (n.kind === "Theme" ? " theme" : "");
      tag.textContent = n.label;
      layer.append(tag);
      handle.labels.set(n.id, tag);
    }

    function place() {
      handle.frame = 0;
      if (!handle.running) return;
      const cam = scene.camera().position;
      const width = box.clientWidth, height = box.clientHeight;
      for (const n of scene.graphData().nodes) {
        const tag = handle.labels.get(n.id);
        if (!tag) continue;
        if (n.x === undefined) { tag.hidden = true; continue; }
        const p = scene.graph2ScreenCoords(n.x, n.y, n.z);
        const dist = Math.hypot(n.x - cam.x, n.y - cam.y, n.z - cam.z);
        const off = p.x < -40 || p.y < -20 || p.x > width + 40 || p.y > height + 20 || !isFinite(dist);
        tag.hidden = off;
        if (off) continue;
        tag.style.transform = "translate(" + Math.round(p.x) + "px," + Math.round(p.y + 12) + "px) translateX(-50%)";
        tag.style.opacity = String(lit(n.id) ? Math.max(0.3, Math.min(1, 280 / dist)) : 0.12);
      }
      handle.frame = requestAnimationFrame(place);
    }
    handle.start = () => { handle.running = true; scene.resumeAnimation(); if (!handle.frame) handle.frame = requestAnimationFrame(place); };
    handle.stop = () => { handle.running = false; scene.pauseAnimation(); if (handle.frame) cancelAnimationFrame(handle.frame); handle.frame = 0; };

    // The canvas follows its container; drawing pauses while the view is hidden or scrolled away.
    if (typeof ResizeObserver === "function") {
      handle.resize = new ResizeObserver(() => { if (box.clientWidth > 0) scene.width(box.clientWidth).height(box.clientHeight); });
      handle.resize.observe(box);
    }
    if (typeof IntersectionObserver === "function") {
      handle.observer = new IntersectionObserver((entries) => { if (entries[entries.length - 1].isIntersecting) handle.start(); else handle.stop(); });
      handle.observer.observe(box);
    }
    handle.start();
    return handle;
  }

  function focus(handle, id) {
    const n = handle.scene.graphData().nodes.find((x) => x.id === id);
    if (!n || n.x === undefined) return;
    handle.selected = id;
    handle.refresh();
    const ratio = 1 + 90 / (Math.hypot(n.x, n.y, n.z) || 1);
    handle.scene.cameraPosition({ x: n.x * ratio, y: n.y * ratio, z: n.z * ratio }, n, 700);
  }

  function fit(handle) {
    handle.selected = null;
    handle.hover = null;
    handle.refresh();
    handle.scene.zoomToFit(600, 70);
  }

  function destroy(handle) {
    if (!handle) return;
    handle.stop();
    if (handle.observer) handle.observer.disconnect();
    if (handle.resize) handle.resize.disconnect();
    if (typeof handle.scene._destructor === "function") handle.scene._destructor();
    handle.box.replaceChildren();
  }

  window.AMGraph3D = { available, render, focus, fit, destroy };
})();
