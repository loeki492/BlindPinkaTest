
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const DEEZER_API = (process.env.DEEZER_API || 'https://api.deezer.com').replace(/\/$/, '');
const SITE_DIR = path.join(__dirname, 'docs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function relayDeezer(res, url) {
  const deezerPath = url.pathname.slice('/api/deezer'.length);
  // Seuls des chemins simples sont relayés (ex. /playlist/123/tracks, /track/456)
  if (!/^(\/[a-z]+(\/\d+)?)+$/.test(deezerPath)) return sendJson(res, 400, { error: 'Chemin Deezer refusé' });
  const params = new URLSearchParams(url.searchParams);
  params.delete('output');
  params.delete('callback');
  const qs = params.toString();
  let upstream;
  try {
    upstream = await fetch(`${DEEZER_API}${deezerPath}${qs ? `?${qs}` : ''}`, { headers: { Accept: 'application/json' } });
  } catch (e) {
    return sendJson(res, 502, { error: `Impossible de joindre Deezer (${e.message})` });
  }
  const body = await upstream.text();
  res.writeHead(upstream.ok ? 200 : 502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(upstream.ok ? body : JSON.stringify({ error: { message: `Deezer a répondu HTTP ${upstream.status}` } }));
}

function serveStatic(res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return sendJson(res, 400, { error: 'Chemin invalide' }); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(SITE_DIR, rel));
  if (!file.startsWith(SITE_DIR + path.sep)) return sendJson(res, 403, { error: 'Interdit' });
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Introuvable');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Méthode non autorisée' });
  try {
    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/deezer/')) return await relayDeezer(res, url);
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Route API inconnue' });
    return serveStatic(res, url);
  } catch (e) {
    console.error(e);
    return sendJson(res, 500, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Pinkatest lancé sur http://localhost:${PORT}`));
}

module.exports = { server };
