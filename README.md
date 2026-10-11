# notion-graph

An Obsidian-style graph view of your Notion workspace. Every page and database is a node; parent/child
structure, database relations, and in-page mentions are edges.

- **Free.** Node script with zero dependencies, hosted on GitHub Pages, rebuilt by GitHub Actions.
- **Updates on its own.** A scheduled workflow re-crawls Notion every hour (or on demand).
- **Cached at every layer.** Raw Notion responses persist between runs so only edited pages are refetched;
  the browser keeps the last graph and your node layout, so the page opens instantly.
- **Private by default.** Set a password and the published data is AES-encrypted; it is decrypted in your browser.
- **Readable at scale.** Database rows fold into their database by default, nodes are coloured by
  top-level section, and the layout is precomputed in CI so the page never waits on a simulation.
- **Read-only.** The crawler only ever calls GET and `POST /search`. Notion is never modified.

## One-time setup (5 minutes)

### 1. Create a Notion integration

1. Go to <https://www.notion.so/profile/integrations> and click **New integration**.
2. Name it (e.g. `graph`), pick your workspace, type **Internal**. Under capabilities only **Read content** is needed.
3. Copy the **Internal Integration Secret** (starts with `ntn_`).

### 2. Share your pages with it

In Notion, open each **top-level** page or database, click `...` → **Connections** → add your integration.
Children inherit access, so sharing a few root pages usually covers the whole workspace.
Anything you don't share is invisible to the graph.

### 3. Add the secrets to this repo

On GitHub: **Settings → Secrets and variables → Actions → New repository secret**

| name | value |
|---|---|
| `NOTION_TOKEN` | the `ntn_…` secret from step 1 |
| `GRAPH_PASSWORD` | *(optional but recommended)* any password. The site is public; this keeps your page titles private. |

### 4. Run it

**Actions → build graph → Run workflow.** The first run crawls everything (a few minutes for a large workspace).
When it finishes, the site is live at `https://<you>.github.io/notion-graph/`.
After that it rebuilds itself every hour.

## Using the viewer

- **rows collapsed / expanded** folds every database's rows into one square node. Select a database
  and press *expand N rows* to open just that one.
- click a node to select it; the right panel shows its details, an *open in Notion* button and a
  **local graph** switch (1 or 2 hops). Double-click or right-click opens Notion directly.
- **colour by**: database (default), section (top-level page) or any select / multi-select / status
  property (`tag: Tipo`, `tag: Status`…). Click a legend entry to isolate that group.
- **edges**: `parent` (hierarchy, off by default like folders in Obsidian), `relation`, `mention`
  (body *and* rich-text/title properties) and `typed`. **colour relations by name** gives each relation
  property its own colour, with a legend.
- **junction db**: pick a database whose rows describe a link between two pages (e.g. a "Relations"
  database with `Side A` / `Side B` relations and a `Tipo` select). Each row becomes an edge between the
  pages it relates *within the same database*, coloured by its `Tipo` (or first select).
- **3D**: switches to a WebGL view (`3d-force-graph`, loaded on demand). *depth (z)* puts each colour
  group on its own plane, or stacks by hierarchy depth, or lets the layout float freely.
- **edited after** slider hides anything not touched since that date.
- right panel tabs: **hubs** (most linked), **orphans** (no links at all), **stale** (untouched for a
  year), **recent**. Click any item to jump to it.
- `/` focuses search, Enter jumps to the first match, Esc clears.
- hover highlights neighbours; drag pins a node (remembered on this device); **re-layout** discards
  the precomputed positions and runs a live simulation.
- **rebuild now** (bottom right) opens the workflow page where one click triggers a fresh crawl.
  When served by `serve.js` it is replaced by **sync now** + **live** (see below).

The graph only shows links that already exist in Notion: no relation set and no `@mention` written means no edge.

## Running locally

Needs Node 18+.

```bash
cp .env.example .env      # put your NOTION_TOKEN in it
node fetch.js --mentions  # writes graph.json
node layout.js graph.json # adds precomputed positions
node encrypt.js graph.json site/data.json && cp index.html site/
python3 -m http.server 8000 --directory site
```

Then open <http://localhost:8000>.

### Live sync (`serve.js`)

```bash
NOTION_TOKEN_FILE=~/notion-token.txt NOTION_ROOT=<page id> node serve.js
```

Serves the viewer on <http://127.0.0.1:8766> and keeps `site/data.json` in sync with Notion:
automatic sync every `SYNC_EVERY_MIN` minutes (default 10, `0` = manual only), a **sync now** button, and
a **live** toggle that reloads the graph when a sync lands. Notion is never hit more often than
`SYNC_MIN_GAP_S` (default 60 s), manual clicks included; inside that window the cached graph is served.
Each sync only refetches pages edited since the last one (see caching below). The server answers only to
local host names and rejects cross-site sync requests.

### `fetch.js` flags

| flag | effect |
|---|---|
| `--mentions` | walk page blocks for `@mentions` and links (1+ request per page, cached afterwards) |
| `--fresh` | ignore `.cache/` and refetch everything |
| `--out <path>` | output file, default `graph.json` |
| `--cache <dir>` | cache directory, default `.cache` |
| `--root <page id>` | only keep that page's subtree (pages inside columns/toggles are resolved to their page) |

The token comes from `NOTION_TOKEN`, or from a file named by `NOTION_TOKEN_FILE`, either exported or in `.env`.

## How caching works

- **Crawl cache** (`.cache/`): every raw API response is stored, keyed by request and by the object's
  `last_edited_time`. On the next run a page that hasn't changed costs zero requests. In Actions this
  directory is restored with `actions/cache`, so scheduled runs only touch what changed.
- **Layout cache**: `layout.js` runs a Barnes-Hut force simulation in CI (zero dependencies, ~2 s for
  5,000 nodes) for both the collapsed and the full graph, so the browser only draws.
- **Browser cache**: the last graph and any nodes you dragged are kept in IndexedDB. The page renders
  immediately from that, then revalidates `data.json` (ETag, so an unchanged file is a 304).
- Notion limits integrations to ~3 requests/second. The crawler serialises requests 350 ms apart and
  honours `Retry-After` on 429, so a rate limit slows the run down but never fails it.

## Notes

- GitHub pauses scheduled workflows on repos with no commits for 60 days. The workflow makes an empty
  keepalive commit every ~50 days so this never happens.
- Notion caps relation lists at 25 entries in search results; the crawler pages through the property
  endpoint when it sees exactly 25, so big relations are complete.
- `parent` edges point child → parent. `relation` edges carry the property name as `label`; a two-way
  relation is stored once.
- The crawl cache is saved even when a later step fails, so a long first crawl is never lost.
