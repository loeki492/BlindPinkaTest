// Serveur local (facultatif) : fichiers statiques + relais Deezer, testé avec un faux Deezer.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

let mock, app, base;
const seen = [];

before(async () => {
  mock = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(req.url.startsWith('/boom') ? 500 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: req.url }));
  });
  await new Promise((r) => mock.listen(0, r));
  process.env.DEEZER_API = `http://127.0.0.1:${mock.address().port}`;
  app = require('../server.js').server;
  await new Promise((r) => app.listen(0, r));
  base = `http://127.0.0.1:${app.address().port}`;
});

after(() => { app.close(); mock.close(); });

test('health', async () => {
  const r = await fetch(`${base}/api/health`);
  assert.deepEqual(await r.json(), { ok: true });
});

test('relais : chemin et paramètres transmis, output/callback retirés', async () => {
  const r = await fetch(`${base}/api/deezer/playlist/12/tracks?limit=100&index=200&output=jsonp&callback=x`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { path: '/playlist/12/tracks?limit=100&index=200' });
});

test('relais : chemins suspects refusés', async () => {
  for (const p of ['/api/deezer/..%2F..%2Fetc', '/api/deezer/playlist/12.json', '/api/deezer/Playlist/1', '/api/deezer/']) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 400, p);
  }
});

test('relais : erreur Deezer transformée en erreur lisible', async () => {
  const r = await fetch(`${base}/api/deezer/boom`);
  assert.equal(r.status, 502);
  assert.match((await r.json()).error.message, /HTTP 500/);
});

test('fichiers statiques du dossier docs/', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Pinkatest/);
  const js = await fetch(`${base}/deezer.js`);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.deepEqual(await (await fetch(`${base}/presets.json`)).json(), []);
});

test('pas de sortie du dossier docs/', async () => {
  const r = await fetch(`${base}/..%2Fserver.js`);
  assert.notEqual(r.status, 200);
});
