#!/usr/bin/env node
// notion-graph: pulls a Notion workspace into graph.json (read-only).
// Zero dependencies. Node 18+.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- CLI ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const WITH_MENTIONS = flag('--mentions');
const FRESH = flag('--fresh');
const OUT = opt('--out', 'graph.json');
const CACHE_DIR = opt('--cache', '.cache');
const MAX_DEPTH = 3;
const ROOT = opt('--root', '').replace(/-/g, '').toLowerCase();

// ---------- token ----------
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}
const dotenv = loadEnvFile(path.join(process.cwd(), '.env'));
const tokenFile = process.env.NOTION_TOKEN_FILE || dotenv.NOTION_TOKEN_FILE;
const TOKEN = process.env.NOTION_TOKEN || dotenv.NOTION_TOKEN ||
  (tokenFile ? fs.readFileSync(tokenFile.replace(/^~(?=\/)/, require('os').homedir()), 'utf8').trim() : '');
if (!TOKEN) {
  console.error('NOTION_TOKEN not found. Export NOTION_TOKEN or NOTION_TOKEN_FILE, or put either in .env. See README.');
  process.exit(1);
}
const API = process.env.NOTION_API_BASE || 'https://api.notion.com/v1';
const MIN_GAP_MS = Number(process.env.NOTION_MIN_GAP_MS || 350);

// ---------- stats ----------
const stats = { requests: 0, cached: 0, retries: 0, errors: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- cache ----------
fs.mkdirSync(CACHE_DIR, { recursive: true });
const cacheKey = (method, url, body) =>
  crypto.createHash('sha1').update(method + ' ' + url + ' ' + (body ? JSON.stringify(body) : '')).digest('hex');
const cachePath = (key) => path.join(CACHE_DIR, key + '.json');
function cacheGet(key, version) {
  if (FRESH) return null;
  try {
    const entry = JSON.parse(fs.readFileSync(cachePath(key), 'utf8'));
    if (entry.version === version) return entry.data;
  } catch (_) {}
  return null;
}
function cachePut(key, version, data) {
  fs.writeFileSync(cachePath(key), JSON.stringify({ version, data }));
}

// ---------- request queue (one at a time, >= MIN_GAP_MS apart) ----------
let queue = Promise.resolve();
let lastCall = 0;
function request(method, endpoint, body) {
  const run = async () => {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    const url = API + endpoint;
    for (let attempt = 0; ; attempt++) {
      lastCall = Date.now();
      stats.requests++;
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: 'Bearer ' + TOKEN,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (attempt >= 3) throw err;
        stats.retries++;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after')) || 1;
        stats.retries++;
        process.stderr.write(`  429 rate limited, waiting ${ra}s\n`);
        await sleep(ra * 1000);
        continue;
      }
      if (res.status >= 500) {
        if (attempt >= 3) throw new Error(`HTTP ${res.status} after ${attempt} retries: ${method} ${endpoint}`);
        stats.retries++;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const json = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${json.code || ''}: ${json.message || ''} (${method} ${endpoint})`);
      return json;
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

// `version` is the caller's notion of freshness (e.g. the page's last_edited_time).
// Same key + same version => served from cache without a request.
async function cachedRequest(method, endpoint, body, version) {
  const key = cacheKey(method, endpoint, body);
  const hit = cacheGet(key, version);
  if (hit) {
    stats.cached++;
    return hit;
  }
  const data = await request(method, endpoint, body);
  cachePut(key, version, data);
  return data;
}

// Page through any list endpoint.
async function paginate(method, endpoint, body, version) {
  const results = [];
  let cursor;
  do {
    let ep = endpoint;
    let b = body;
    if (method === 'GET') ep += (ep.includes('?') ? '&' : '?') + 'page_size=100' + (cursor ? '&start_cursor=' + cursor : '');
    else b = { ...(body || {}), page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
    const res = await cachedRequest(method, ep, b, version);
    results.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return results;
}

// ---------- helpers ----------
const plain = (rich) => (Array.isArray(rich) ? rich.map((t) => t.plain_text || '').join('') : '');
const normId = (id) => (id || '').replace(/-/g, '').toLowerCase();
const isNotionHost = (u) => /^(https?:\/\/)?(www\.)?notion\.(so|site)\//i.test(u);
function idFromUrl(url) {
  if (!url || !isNotionHost(url)) return null;
  const m = url.match(/([0-9a-f]{32})(?:[?#]|$)/i) || url.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? normId(m[1]) : null;
}

function titleOf(obj) {
  if (obj.object === 'database') return plain(obj.title) || 'Untitled';
  const props = obj.properties || {};
  for (const p of Object.values(props)) if (p && p.type === 'title') return plain(p.title) || 'Untitled';
  if (props.title && props.title.title) return plain(props.title.title) || 'Untitled';
  return 'Untitled';
}

function parentIdOf(obj) {
  const p = obj.parent || {};
  if (p.type === 'page_id') return normId(p.page_id);
  if (p.type === 'database_id') return normId(p.database_id);
  if (p.type === 'block_id') return normId(p.block_id); // resolved later if the block's page is known
  return null;
}

// select / multi_select / status values, used by the viewer for colour and filters
function tagsOf(obj) {
  const out = {};
  for (const [name, p] of Object.entries(obj.properties || {})) {
    if (!p || obj.object !== 'page') continue;
    const v = p[p.type];
    if (p.type === 'select' || p.type === 'status') { if (v && v.name) out[name] = [v.name]; }
    else if (p.type === 'multi_select' && Array.isArray(v) && v.length) out[name] = v.map((x) => x.name);
  }
  return out;
}

// page/database ids referenced by a rich_text array (mentions, link_mentions, notion.so hrefs)
function richTextTargets(rich) {
  const out = [];
  for (const rt of rich || []) {
    if (rt.type === 'mention' && rt.mention) {
      const m = rt.mention;
      if (m.type === 'page') out.push(m.page.id);
      else if (m.type === 'database') out.push(m.database.id);
      else if (m.type === 'link_mention' && m.link_mention) { const t = idFromUrl(m.link_mention.href); if (t) out.push(t); }
    } else if (rt.href) {
      const t = idFromUrl(rt.href);
      if (t) out.push(t);
    }
  }
  return out;
}

function iconOf(obj) {
  const ic = obj.icon;
  if (!ic) return null;
  if (ic.type === 'emoji') return ic.emoji;
  return null;
}

// ---------- main ----------
(async () => {
  const t0 = Date.now();
  console.log(`notion-graph  mentions=${WITH_MENTIONS} fresh=${FRESH} cache=${CACHE_DIR}`);

  // Step 1: collect nodes via search (always fresh; this is how we learn last_edited_time).
  console.log('1/5 searching workspace...');
  const results = await paginate('POST', '/search', {}, 'search-' + Date.now());
  const nodes = new Map();
  const raw = new Map();
  for (const r of results) {
    const id = normId(r.id);
    if (nodes.has(id)) continue;
    raw.set(id, r);
    nodes.set(id, {
      id,
      title: titleOf(r),
      type: r.object === 'database' ? 'database' : 'page',
      icon: iconOf(r),
      tags: tagsOf(r),
      url: r.url || 'https://www.notion.so/' + id,
      parentId: parentIdOf(r),
      parentType: (r.parent && r.parent.type) || null,
      lastEdited: r.last_edited_time || null,
      created: r.created_time || null,
      archived: !!r.archived,
      degree: 0,
    });
  }
  console.log(`    ${nodes.size} objects visible to the integration`);

  // Pages inside columns/toggles have a block parent: climb the block tree to the owning page/database.
  const blockOwner = new Map();
  const resolveBlock = async (blockId) => {
    const path = [];
    for (let hops = 0; blockId && hops < 16; hops++) {
      if (nodes.has(blockId)) break;
      if (blockOwner.has(blockId)) { blockId = blockOwner.get(blockId); break; }
      let b;
      try {
        b = await cachedRequest('GET', `/blocks/${blockId}`, null, 'block');
      } catch (err) {
        stats.errors.push(`block parent ${blockId}: ${err.message}`);
        blockId = null;
        break;
      }
      path.push(blockId);
      blockId = parentIdOf(b);
    }
    for (const id of path) blockOwner.set(id, blockId);
    return blockId;
  };
  for (const n of nodes.values()) {
    if (n.parentType === 'block_id' && n.parentId && !nodes.has(n.parentId)) n.parentId = await resolveBlock(n.parentId);
  }

  if (ROOT) {
    if (!nodes.has(ROOT)) throw new Error(`--root ${ROOT} is not visible to the integration`);
    const inRoot = (n) => {
      for (let guard = 0; n && guard < 64; guard++) {
        if (n.id === ROOT) return true;
        n = nodes.get(n.parentId);
      }
      return false;
    };
    for (const [id, n] of nodes) if (!inRoot(n)) { nodes.delete(id); raw.delete(id); }
    console.log(`    ${nodes.size} objects under --root ${ROOT}`);
  }

  const edges = new Map();
  const addEdge = (source, target, kind, label) => {
    source = normId(source);
    target = normId(target);
    if (!source || !target || source === target) return;
    const k = source + '|' + target + '|' + kind;
    if (edges.has(k)) return;
    if (kind === 'relation') {
      // a two-way relation shows up once from each side; keep a single edge
      const rev = edges.get(target + '|' + source + '|' + kind);
      if (rev) { if (label && rev.label && !rev.label.split(' ↔ ').includes(label)) rev.label = [...rev.label.split(' ↔ '), label].sort().join(' ↔ '); return; }
    }
    edges.set(k, { source, target, kind, ...(label ? { label } : {}) });
  };

  // Step 2: structural edges.
  console.log('2/5 structural edges...');
  for (const n of nodes.values()) if (n.parentId && nodes.has(n.parentId)) addEdge(n.id, n.parentId, 'parent');

  // Step 3: relation edges.
  console.log('3/5 relation + property mention edges...');
  for (const [id, r] of raw) {
    if (r.object !== 'page' || !r.properties) continue;
    for (const [name, prop] of Object.entries(r.properties)) {
      if (prop && (prop.type === 'rich_text' || prop.type === 'title')) {
        for (const t of richTextTargets(prop[prop.type])) addEdge(id, t, 'mention', name);
        continue;
      }
      if (!prop || prop.type !== 'relation') continue;
      let rel = prop.relation || [];
      if (rel.length >= 25 || prop.has_more) {
        try {
          rel = await paginate('GET', `/pages/${id}/properties/${encodeURIComponent(prop.id)}`, null, r.last_edited_time);
          rel = rel.map((x) => x.relation).filter(Boolean);
        } catch (err) {
          stats.errors.push(`relation ${name} on ${id}: ${err.message}`);
        }
      }
      for (const x of rel) addEdge(id, x.id, 'relation', name);
    }
  }

  // Step 4: mention edges (walk block trees).
  if (WITH_MENTIONS) {
    console.log('4/5 mention edges (block walk)...');
    let done = 0;
    const walk = async (blockId, ownerId, version, depth) => {
      if (depth > MAX_DEPTH) return;
      let blocks;
      try {
        blocks = await paginate('GET', `/blocks/${blockId}/children`, null, version);
      } catch (err) {
        stats.errors.push(`blocks of ${blockId}: ${err.message}`);
        return;
      }
      for (const b of blocks) {
        const inner = b[b.type] || {};
        // child page / child database blocks are real pages: they show up in search; parent edge already covers them.
        if (b.type === 'link_to_page') {
          const l = b.link_to_page || {};
          addEdge(ownerId, l.page_id || l.database_id, 'mention');
        }
        for (const t of richTextTargets(inner.rich_text)) addEdge(ownerId, t, 'mention');
        if (b.has_children && b.type !== 'child_page' && b.type !== 'child_database') {
          await walk(b.id, ownerId, version, depth + 1);
        }
      }
    };
    for (const n of nodes.values()) {
      if (n.type !== 'page') continue;
      await walk(n.id, n.id, n.lastEdited, 0);
      done++;
      if (done % 50 === 0) console.log(`    ${done}/${nodes.size} pages walked, ${stats.requests} requests, ${stats.cached} cached`);
    }
  } else {
    console.log('4/5 mention edges skipped (pass --mentions)');
  }

  // Step 5: write.
  console.log('5/5 writing output...');
  const links = [...edges.values()].filter((e) => nodes.has(e.source) && nodes.has(e.target));
  const dropped = edges.size - links.length;
  for (const e of links) {
    nodes.get(e.source).degree++;
    nodes.get(e.target).degree++;
  }
  const byKind = {};
  for (const e of links) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  // root = top-most visible ancestor (used for colouring), row = direct child of a visible database
  for (const n of nodes.values()) {
    let cur = n, depth = 0, guard = 0;
    while (cur.parentId && nodes.has(cur.parentId) && guard++ < 64) { cur = nodes.get(cur.parentId); depth++; }
    n.root = cur.id;
    n.depth = depth;
    const p = n.parentId && nodes.get(n.parentId);
    n.row = !!(p && p.type === 'database');
  }
  const out = {
    generatedAt: new Date().toISOString(),
    nodes: [...nodes.values()].map(({ parentType, ...n }) => n),
    links,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));

  const orphans = out.nodes.filter((n) => n.degree === 0).length;
  console.log('');
  console.log(`nodes     ${out.nodes.length}  (${out.nodes.filter((n) => n.type === 'database').length} databases, ${orphans} orphans)`);
  console.log(`edges     ${links.length}  ${JSON.stringify(byKind)}  (${dropped} dropped: target not visible)`);
  console.log(`requests  ${stats.requests} live, ${stats.cached} from cache, ${stats.retries} retries`);
  console.log(`time      ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${OUT}`);
  if (stats.errors.length) {
    console.log(`errors    ${stats.errors.length}`);
    for (const e of stats.errors.slice(0, 20)) console.log('  - ' + e);
  }
})().catch((err) => {
  console.error('fatal:', err.message);
  process.exit(1);
});
