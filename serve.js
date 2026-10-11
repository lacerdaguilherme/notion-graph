#!/usr/bin/env node
// notion-graph live server: serves the viewer and keeps site/data.json in sync with Notion.
// Zero dependencies. Node 18+.
//
//   NOTION_TOKEN_FILE=~/token.txt NOTION_ROOT=<page id> node serve.js
//
// Env:
//   NOTION_TOKEN / NOTION_TOKEN_FILE  integration token (or in .env)
//   NOTION_ROOT       only crawl this page's subtree (optional)
//   SYNC_EVERY_MIN    automatic sync interval in minutes, 0 = manual only (default 10)
//   SYNC_MIN_GAP_S    never hit Notion more often than this, manual syncs included (default 60)
//   PORT / HOST       default 8766 / 127.0.0.1
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = __dirname;
const SITE = path.join(DIR, 'site');
const DATA = path.join(SITE, 'data.json');
const PORT = Number(process.env.PORT || 8766);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = process.env.NOTION_ROOT || '';
const EVERY_MIN = Number(process.env.SYNC_EVERY_MIN ?? 10);
const MIN_GAP_S = Number(process.env.SYNC_MIN_GAP_S ?? 60);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', HOST]);

const state = { running: false, lastStart: 0, lastSync: 0, lastError: null };
try { state.lastSync = fs.statSync(DATA).mtimeMs; } catch (_) {}

function run(script, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script, ...args], { cwd: DIR, env: process.env });
    let tail = '';
    const out = (chunk) => { process.stdout.write(chunk); tail = (tail + chunk).slice(-500); };
    p.stdout.on('data', out);
    p.stderr.on('data', out);
    p.on('error', reject);
    p.on('close', (code) => (code ? reject(new Error(`${script} exited ${code}: ${tail.trim().split('\n').pop()}`)) : resolve()));
  });
}

// Returns 'started', 'running' or 'fresh' (inside SYNC_MIN_GAP_S: served from what we have).
function sync() {
  if (state.running) return 'running';
  if (Date.now() - Math.max(state.lastStart, state.lastSync) < MIN_GAP_S * 1000) return 'fresh';
  state.running = true;
  state.lastStart = Date.now();
  (async () => {
    try {
      await run('fetch.js', ['--mentions', '--out', 'graph.json', ...(ROOT ? ['--root', ROOT] : [])]);
      await run('layout.js', ['graph.json']);
      fs.mkdirSync(SITE, { recursive: true });
      await run('encrypt.js', ['graph.json', 'site/data.json']);
      state.lastSync = Date.now();
      state.lastError = null;
    } catch (err) {
      state.lastError = err.message;
      console.error('sync failed:', err.message);
    } finally {
      state.running = false;
    }
  })();
  return 'started';
}

const status = () => ({ ...state, everyMin: EVERY_MIN, minGapS: MIN_GAP_S, root: ROOT || null });

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
};

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
  res.end(body);
}

function sendFile(res, file, type) {
  fs.readFile(file, (err, buf) => (err ? send(res, 404, 'text/plain', 'not found') : send(res, 200, type, buf)));
}

http.createServer((req, res) => {
  // DNS-rebinding guard: data.json holds workspace titles, so answer only to local host names
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTS.has(host)) return send(res, 421, 'text/plain', 'unexpected host');
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'text/plain', 'bad request'); }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return sendFile(res, path.join(DIR, 'index.html'), 'text/html; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/data.json') return sendFile(res, DATA, 'application/json');
  if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, 'application/json', JSON.stringify(status()));
  if (req.method === 'POST' && url.pathname === '/api/sync') {
    // only the viewer served by this server may trigger a sync (blocks cross-site POSTs)
    if (req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, 'text/plain', 'forbidden origin');
    return send(res, 202, 'application/json', JSON.stringify({ result: sync(), ...status() }));
  }
  send(res, 404, 'text/plain', 'not found');
}).listen(PORT, HOST, () => {
  console.log(`notion-graph on http://${HOST}:${PORT}  root=${ROOT || 'workspace'}  auto=${EVERY_MIN ? EVERY_MIN + ' min' : 'off'}  min gap=${MIN_GAP_S}s`);
  sync();
  if (EVERY_MIN > 0) setInterval(sync, EVERY_MIN * 60 * 1000);
});
