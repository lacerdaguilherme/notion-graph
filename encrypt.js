#!/usr/bin/env node
// Packs graph.json into the file the viewer loads (site/data.json).
// If GRAPH_PASSWORD is set, the graph is gzipped and AES-GCM encrypted so the
// public Pages site never exposes your page titles. Decryption happens in the browser.
// usage: node encrypt.js [in=graph.json] [out=site/data.json]
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { webcrypto } = require('crypto');

const inFile = process.argv[2] || 'graph.json';
const outFile = process.argv[3] || path.join('site', 'data.json');
const password = process.env.GRAPH_PASSWORD;

(async () => {
  const graph = fs.readFileSync(inFile);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  if (!password) {
    writeAtomic(outFile, graph);
    console.log(`wrote ${outFile} (plain, ${graph.length} bytes). Set GRAPH_PASSWORD to encrypt.`);
    return;
  }
  const subtle = webcrypto.subtle;
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const iterations = 250000;
  const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const packed = zlib.gzipSync(graph);
  const cipher = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, packed));
  const b64 = (u8) => Buffer.from(u8).toString('base64');
  const generatedAt = (() => { try { return JSON.parse(graph).generatedAt; } catch { return null; } })();
  const envelope = { encrypted: true, v: 1, kdf: 'PBKDF2-SHA256', iterations, salt: b64(salt), iv: b64(iv), gzip: true, generatedAt, data: b64(cipher) };
  writeAtomic(outFile, JSON.stringify(envelope));
  console.log(`wrote ${outFile} (encrypted, ${graph.length} -> ${cipher.length} bytes)`);
})().catch((e) => { console.error(e); process.exit(1); });

// serve.js may read data.json mid-sync: never expose a half-written file
function writeAtomic(file, data) {
  fs.writeFileSync(file + '.tmp', data);
  fs.renameSync(file + '.tmp', file);
}
