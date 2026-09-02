#!/usr/bin/env node
// layout.js — precomputes node positions so the browser never has to run the simulation.
// Zero-dependency port of the d3-force essentials: Barnes-Hut many-body, link, center.
// usage: node layout.js graph.json   (rewrites the file in place, adding x/y and cx/cy)
'use strict';
const fs = require('fs');

// ---------- collapse helper (same logic as the viewer) ----------
// Folds database rows into their database. Returns { nodes, links } for the collapsed graph.
function collapse(graph) {
  const rep = new Map();
  for (const n of graph.nodes) rep.set(n.id, n.row ? n.parentId : n.id);
  const nodes = graph.nodes.filter((n) => !n.row);
  const seen = new Map();
  for (const l of graph.links) {
    const s = rep.get(l.source), t = rep.get(l.target);
    if (!s || !t || s === t) continue;
    if (l.kind === 'parent' && (rep.get(l.source) !== l.source)) continue; // row -> db parent edge folds away
    const a = s < t ? s : t, b = s < t ? t : s;
    const k = a + '|' + b + '|' + l.kind;
    const e = seen.get(k);
    if (e) e.weight++;
    else seen.set(k, { source: s, target: t, kind: l.kind, weight: 1 });
  }
  return { nodes, links: [...seen.values()] };
}

// ---------- force simulation ----------
function simulate(nodes, links, opts = {}) {
  const n = nodes.length;
  if (!n) return;
  const iterations = opts.iterations || 300;
  const charge = opts.charge ?? -30;
  const linkDistance = opts.linkDistance || (() => 30);
  const theta2 = 0.81, distanceMin2 = 1;
  const alphaMin = 0.001, alphaDecay = 1 - Math.pow(alphaMin, 1 / iterations), velocityDecay = 0.6;

  const x = new Float64Array(n), y = new Float64Array(n), vx = new Float64Array(n), vy = new Float64Array(n);
  const index = new Map();
  nodes.forEach((d, i) => index.set(d.id, i));
  const initialRadius = 10, initialAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const d = nodes[i];
    if (Number.isFinite(d.x) && Number.isFinite(d.y)) { x[i] = d.x; y[i] = d.y; }
    else { const r = initialRadius * Math.sqrt(0.5 + i), a = i * initialAngle; x[i] = r * Math.cos(a); y[i] = r * Math.sin(a); }
  }
  const L = [];
  for (const l of links) {
    const s = index.get(l.source), t = index.get(l.target);
    if (s !== undefined && t !== undefined && s !== t) L.push([s, t, linkDistance(l)]);
  }
  const count = new Int32Array(n);
  for (const [s, t] of L) { count[s]++; count[t]++; }
  const bias = new Float64Array(L.length), strength = new Float64Array(L.length);
  L.forEach(([s, t], i) => { bias[i] = count[s] / (count[s] + count[t]); strength[i] = 1 / Math.min(count[s], count[t]); });
  const jiggle = () => (Math.random() - 0.5) * 1e-6;

  // Barnes-Hut quadtree (array-of-objects, rebuilt every tick)
  function buildTree() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) { if (x[i] < x0) x0 = x[i]; if (x[i] > x1) x1 = x[i]; if (y[i] < y0) y0 = y[i]; if (y[i] > y1) y1 = y[i]; }
    const w = Math.max(x1 - x0, y1 - y0) || 1;
    const root = { x0, y0, w, kids: null, pts: null, value: 0, cx: 0, cy: 0 };
    const insert = (q, i, depth) => {
      if (q.kids === null) {
        if (q.pts === null) { q.pts = [i]; return; }
        if (depth > 32 || (x[q.pts[0]] === x[i] && y[q.pts[0]] === y[i])) { q.pts.push(i); return; }
        const old = q.pts; q.pts = null; q.kids = [null, null, null, null];
        for (const j of old) insert(q, j, depth);
      }
      const h = q.w / 2;
      const k = (x[i] >= q.x0 + h ? 1 : 0) | (y[i] >= q.y0 + h ? 2 : 0);
      if (!q.kids[k]) q.kids[k] = { x0: q.x0 + (k & 1 ? h : 0), y0: q.y0 + (k & 2 ? h : 0), w: h, kids: null, pts: null, value: 0, cx: 0, cy: 0 };
      insert(q.kids[k], i, depth + 1);
    };
    for (let i = 0; i < n; i++) insert(root, i, 0);
    const accumulate = (q) => {
      let value = 0, cx = 0, cy = 0;
      if (q.kids) {
        for (const c of q.kids) if (c) { accumulate(c); value += c.value; cx += c.value * c.cx; cy += c.value * c.cy; }
        // d3 uses strength sums (negative); keep sign consistent
      } else if (q.pts) {
        for (const i of q.pts) { value += charge; cx += charge * x[i]; cy += charge * y[i]; }
      }
      q.value = value; q.cx = value ? cx / value : 0; q.cy = value ? cy / value : 0;
    };
    accumulate(root);
    return root;
  }

  function manyBody(alpha, root) {
    for (let i = 0; i < n; i++) {
      const xi = x[i], yi = y[i];
      const visit = (q) => {
        if (!q.value) return;
        let dx = q.cx - xi, dy = q.cy - yi;
        let l = dx * dx + dy * dy;
        if ((q.w * q.w) / theta2 < l) {
          if (dx === 0) { dx = jiggle(); l += dx * dx; }
          if (dy === 0) { dy = jiggle(); l += dy * dy; }
          if (l < distanceMin2) l = Math.sqrt(distanceMin2 * l);
          vx[i] += (dx * q.value * alpha) / l; vy[i] += (dy * q.value * alpha) / l;
          return;
        }
        if (q.kids) { for (const c of q.kids) if (c) visit(c); return; }
        for (const j of q.pts) {
          if (j === i) continue;
          let ddx = x[j] - xi, ddy = y[j] - yi, ll = ddx * ddx + ddy * ddy;
          if (ddx === 0) { ddx = jiggle(); ll += ddx * ddx; }
          if (ddy === 0) { ddy = jiggle(); ll += ddy * ddy; }
          if (ll < distanceMin2) ll = Math.sqrt(distanceMin2 * ll);
          vx[i] += (ddx * charge * alpha) / ll; vy[i] += (ddy * charge * alpha) / ll;
        }
      };
      visit(root);
    }
  }

  let alpha = 1;
  for (let it = 0; it < iterations; it++) {
    alpha += (0 - alpha) * alphaDecay;
    if (alpha < alphaMin) break;
    // link force
    for (let k = 0; k < L.length; k++) {
      const [s, t, dist] = L[k];
      let dx = x[t] + vx[t] - x[s] - vx[s] || jiggle();
      let dy = y[t] + vy[t] - y[s] - vy[s] || jiggle();
      let l = Math.sqrt(dx * dx + dy * dy);
      l = ((l - dist) / l) * alpha * strength[k];
      dx *= l; dy *= l;
      const b = bias[k];
      vx[t] -= dx * b; vy[t] -= dy * b;
      vx[s] += dx * (1 - b); vy[s] += dy * (1 - b);
    }
    manyBody(alpha, buildTree());
    // center
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
    sx /= n; sy /= n;
    for (let i = 0; i < n; i++) { x[i] -= sx; y[i] -= sy; }
    // integrate
    for (let i = 0; i < n; i++) { x[i] += vx[i] *= velocityDecay; y[i] += vy[i] *= velocityDecay; }
  }
  for (let i = 0; i < n; i++) { nodes[i].x = Math.round(x[i] * 10) / 10; nodes[i].y = Math.round(y[i] * 10) / 10; }
}

// ---------- main ----------
if (require.main === module) {
  const file = process.argv[2] || 'graph.json';
  const t0 = Date.now();
  const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const dist = (l) => (l.kind === 'parent' ? 25 : l.kind === 'relation' ? 45 : 60) + Math.log2(l.weight || 1) * 12;

  // 1. collapsed layout (databases + non-row pages). Stored as cx/cy.
  const c = collapse(graph);
  const cnodes = c.nodes.map((n) => ({ id: n.id }));
  simulate(cnodes, c.links, { iterations: 300, charge: -150, linkDistance: dist });
  for (const n of cnodes) { const g = byId.get(n.id); g.cx = n.x; g.cy = n.y; }
  console.log(`collapsed layout: ${cnodes.length} nodes, ${c.links.length} links, ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 2. full layout. Seed rows next to their database's collapsed position so clusters land where the collapsed map has them.
  const t1 = Date.now();
  const fnodes = graph.nodes.map((n) => {
    const anchor = n.row ? byId.get(n.parentId) : n;
    const ax = anchor && Number.isFinite(anchor.cx) ? anchor.cx * 4 : undefined;
    const ay = anchor && Number.isFinite(anchor.cy) ? anchor.cy * 4 : undefined;
    return ax === undefined ? { id: n.id } : { id: n.id, x: ax + (Math.random() - 0.5) * 40, y: ay + (Math.random() - 0.5) * 40 };
  });
  simulate(fnodes, graph.links, { iterations: 300, charge: -30, linkDistance: dist });
  for (const n of fnodes) { const g = byId.get(n.id); g.x = n.x; g.y = n.y; }
  console.log(`full layout: ${fnodes.length} nodes, ${graph.links.length} links, ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  graph.collapsedLinks = c.links;
  graph.layout = { version: 1, computedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(graph));
}
module.exports = { simulate, collapse };
