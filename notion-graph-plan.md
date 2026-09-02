# Notion Graph — build plan

Build a local tool that reads a Notion workspace and renders it as an interactive force-directed graph, like Obsidian's graph view. Notion stays the source of truth. This is read-only visualization.

## Constraints

- Zero cost. No paid APIs, no hosting, no accounts beyond Notion itself.
- Node.js only, no npm dependencies. Use built-in `fetch` (Node 18+).
- The viewer is one HTML file using a CDN script tag. No build step, no bundler.
- Read-only. The script must never call POST/PATCH/DELETE on Notion.
- Everything runs locally. Nothing is uploaded anywhere.

## Setup the user does first (not your job, but document it in the README)

1. Go to notion.so/profile/integrations, create an internal integration, copy the token (`ntn_...`).
2. In Notion, open each top-level page or database, click the `...` menu, Connections, add the integration. Child pages inherit access.
3. Put the token in a `.env` file as `NOTION_TOKEN=ntn_...`. Add `.env` to `.gitignore`.

## Files to produce

```
notion-graph/
  fetch.js        # pulls Notion -> graph.json
  index.html      # renders graph.json
  .env.example
  .gitignore
  README.md
  .cache/         # raw API responses, gitignored
  graph.json      # output, gitignored
```

## fetch.js

### API basics

- Base URL `https://api.notion.com/v1`
- Headers: `Authorization: Bearer <token>`, `Notion-Version: 2022-06-28`, `Content-Type: application/json`
- Read the token from `.env` by parsing the file yourself. Do not add a dotenv dependency.

### Rate limiting

Notion allows about 3 requests per second per integration. Build a single request wrapper that every call goes through:

- Serialize requests through one queue. Minimum 350ms gap between calls.
- On HTTP 429, read the `Retry-After` header, wait that many seconds, retry. On 5xx, exponential backoff, 3 attempts, then give up on that one request and keep going.
- Never let one failed page kill the whole run. Collect errors and print a summary at the end.

### Caching

Cache raw JSON responses under `.cache/`, keyed by a hash of the endpoint plus body. On rerun, reuse a cached response if the object's `last_edited_time` hasn't changed since the cached copy. A `--fresh` flag ignores the cache entirely. This is what makes reruns fast.

### Step 1 — collect nodes

`POST /v1/search` with an empty query returns every page and database shared with the integration. Page through it with `start_cursor` until `has_more` is false, 100 per request.

For each result build a node:

```json
{
  "id": "uuid",
  "title": "plain text title",
  "type": "page" | "database",
  "url": "https://notion.so/...",
  "parentId": "uuid or null",
  "lastEdited": "ISO date"
}
```

Title extraction differs by object type. For a database it's the `title` array. For a page it's whichever property has `type: "title"`, or `properties.title` for non-database pages. Fall back to `"Untitled"`. Handle both, don't assume.

### Step 2 — structural edges (free)

The search response already contains `parent`. For every node with a parent that is also a node in the set, emit:

```json
{ "source": "childId", "target": "parentId", "kind": "parent" }
```

Skip parents of type `workspace`.

### Step 3 — relation edges (free)

Database rows come back from search with their properties. For every property of `type: "relation"`, emit one edge per related id:

```json
{ "source": "pageId", "target": "relatedId", "kind": "relation", "label": "property name" }
```

Important: the search and retrieve endpoints cap inline relation and person references at 25 per page. If a relation array has exactly 25 entries, it is probably truncated. In that case call `GET /v1/pages/{id}/properties/{property_id}` and page through it for the full list. Only do this when the count hits 25, so you don't burn requests on every row.

### Step 4 — mention edges (expensive, flag-gated)

Behind a `--mentions` flag, since this is one or more requests per page.

For each page, `GET /v1/blocks/{id}/children`, page through with `start_cursor`. Walk every block's `rich_text` arrays. Emit an edge for:

- `type: "mention"` where `mention.type` is `page` or `database` — target is that id
- `type: "text"` with a `link.url` that contains a Notion page id — extract the 32-hex id from the URL

```json
{ "source": "pageId", "target": "mentionedId", "kind": "mention" }
```

Recurse into children only when a block has `has_children: true`, and cap recursion depth at 3 so a deeply nested page can't run away.

### Step 5 — write output

Deduplicate edges on `source|target|kind`. Drop any edge whose target isn't in the node set (that means it points at a page the integration can't see). Compute a `degree` count per node. Write:

```json
{
  "generatedAt": "ISO date",
  "nodes": [...],
  "links": [...]
}
```

Print a summary: node count, edge count broken down by kind, orphan count, how many requests were made, how many came from cache, and any errors.

### CLI flags

- `--mentions` — enable step 4
- `--fresh` — bypass cache
- `--out <path>` — output path, default `graph.json`

## index.html

Single file. Loads `graph.json` with `fetch`. Renders with `force-graph` from a CDN:

```
https://unpkg.com/force-graph
```

Behavior:

- Force-directed layout, drag to move, scroll to zoom, drag background to pan.
- Node radius scales with `degree`. Databases render in a different color from pages.
- Node label shows on hover.
- Click a node opens its Notion URL in a new tab.
- Hovering a node dims everything not directly connected to it.
- A search box in the corner filters nodes by title, matches stay bright, the rest dim.
- Checkboxes to toggle each edge kind on and off (parent, relation, mention).
- A counter showing how many nodes and edges are currently visible.

Dark background, light nodes. Keep the CSS inline and minimal.

## README.md

Cover the integration setup steps above, how to run `node fetch.js`, how to serve the viewer with `python3 -m http.server 8000`, and what the flags do. One short note that the graph only shows links that already exist in the workspace — no links written means no edges drawn.

## Definition of done

- `node fetch.js` completes on a real workspace and writes `graph.json` with a non-zero node and edge count.
- Rerunning it is noticeably faster than the first run because of the cache.
- Opening the viewer shows a graph you can drag, zoom, search, and click through to Notion.
- A 429 during the run does not crash it.
- No dependencies in `package.json` beyond nothing at all.
