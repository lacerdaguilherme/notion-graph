# notion-graph

An Obsidian-style graph view of your Notion workspace. Every page and database is a node; parent/child
structure, database relations, and in-page mentions are edges.

- **Free.** Node script with zero dependencies, hosted on GitHub Pages, rebuilt by GitHub Actions.
- **Updates on its own.** A scheduled workflow re-crawls Notion every 6 hours (or on demand).
- **Cached at every layer.** Raw Notion responses persist between runs so only edited pages are refetched;
  the browser keeps the last graph and your node layout, so the page opens instantly.
- **Private by default.** Set a password and the published data is AES-encrypted; it is decrypted in your browser.
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
After that it rebuilds itself every 6 hours.

## Using the viewer

- scroll to zoom, drag background to pan, drag nodes to pin them
- hover a node to highlight its neighbourhood; click to open it in Notion
- `/` focuses search; matching pages stay bright, the rest dim
- checkboxes toggle edge kinds (parent / relation / mention) and orphans
- **re-layout** forgets the saved positions and runs the force layout again

The graph only shows links that already exist in Notion: no relation set and no `@mention` written means no edge.

## Running locally

Needs Node 18+.

```bash
cp .env.example .env      # put your NOTION_TOKEN in it
node fetch.js --mentions  # writes graph.json
node encrypt.js graph.json site/data.json && cp index.html site/
python3 -m http.server 8000 --directory site
```

Then open <http://localhost:8000>.

### `fetch.js` flags

| flag | effect |
|---|---|
| `--mentions` | walk page blocks for `@mentions` and links (1+ request per page, cached afterwards) |
| `--fresh` | ignore `.cache/` and refetch everything |
| `--out <path>` | output file, default `graph.json` |
| `--cache <dir>` | cache directory, default `.cache` |

## How caching works

- **Crawl cache** (`.cache/`): every raw API response is stored, keyed by request and by the object's
  `last_edited_time`. On the next run a page that hasn't changed costs zero requests. In Actions this
  directory is restored with `actions/cache`, so scheduled runs only touch what changed.
- **Browser cache**: the last graph and node positions are kept in `localStorage`. The page renders
  immediately from that, then revalidates `data.json` (ETag, so an unchanged file is a 304).
- Notion limits integrations to ~3 requests/second. The crawler serialises requests 350 ms apart and
  honours `Retry-After` on 429, so a rate limit slows the run down but never fails it.

## Notes

- GitHub pauses scheduled workflows on repos with no commits for 60 days. The workflow makes an empty
  keepalive commit every ~50 days so this never happens.
- Notion caps relation lists at 25 entries in search results; the crawler pages through the property
  endpoint when it sees exactly 25, so big relations are complete.
- `parent` edges point child → parent. `relation` edges carry the property name as `label`.
