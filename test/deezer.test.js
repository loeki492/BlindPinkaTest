// Logique du client Deezer (docs/deezer.js), avec un transport simulé : aucun accès réseau.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClient, parsePlaylistId, DeezerError } = require('../docs/deezer.js');

function track(id, extra = {}) {
  return {
    id, title: `Titre ${id} (Remastered)`, title_short: `Titre ${id}`, readable: true,
    preview: `https://cdn.example/${id}.mp3`, link: `https://www.deezer.com/track/${id}`,
    artist: { name: `Artiste ${id}` }, album: { title: 'Album', cover_medium: 'https://img/c.jpg' },
    ...extra,
  };
}

// Playlist 1 : 250 titres (3 pages), le n°5 sans extrait, le n°6 non lisible
const pl1 = Array.from({ length: 250 }, (_, i) => track(i + 1));
pl1[4].preview = '';
pl1[5].readable = false;
// Playlist 2 : doublons avec la playlist 1 + un titre en plus
const pl2 = [track(1), track(2), track(1000)];
const PL = { 1: pl1, 2: pl2 };

function fakeDeezer() {
  const calls = [];
  const transport = async (path) => {
    calls.push(path);
    const u = new URL(path, 'http://x');
    let m;
    if ((m = u.pathname.match(/^\/playlist\/(\d+)$/))) {
      if (!PL[m[1]]) return { error: { type: 'DataException', message: 'no data', code: 800 } };
      return { id: +m[1], title: `Playlist ${m[1]}`, nb_tracks: PL[m[1]].length, picture_medium: 'p.jpg' };
    }
    if ((m = u.pathname.match(/^\/playlist\/(\d+)\/tracks$/))) {
      const index = +u.searchParams.get('index');
      const limit = +u.searchParams.get('limit');
      return { data: PL[m[1]].slice(index, index + limit), total: PL[m[1]].length };
    }
    if ((m = u.pathname.match(/^\/track\/(\d+)$/))) {
      if (m[1] === '404') return { id: 404, preview: '' };
      return { id: +m[1], preview: `https://cdn.example/fresh/${m[1]}.mp3` };
    }
    return { error: { message: 'Quota limit exceeded', code: 4 } };
  };
  return { transport, calls };
}

test('identifiants : ID seul ou lien complet', () => {
  assert.equal(parsePlaylistId('123'), 123);
  assert.equal(parsePlaylistId(' https://www.deezer.com/fr/playlist/908622995?utm=x '), 908622995);
  assert.equal(parsePlaylistId('https://link.deezer.com/s/abc'), null);
  assert.equal(parsePlaylistId(''), null);
});

test('playlist : pagination, filtrage des titres non jouables, titre court', async () => {
  const { transport, calls } = fakeDeezer();
  const p = await createClient(transport).getPlaylist(1);
  assert.equal(p.name, 'Playlist 1');
  assert.equal(p.totalTracks, 250);
  assert.equal(p.playableTracks, 248);
  assert.equal(p.tracks[0].title, 'Titre 1');
  assert.equal(calls.filter((c) => c.includes('/tracks')).length, 3);
});

test('playlist mise en cache', async () => {
  const { transport, calls } = fakeDeezer();
  const client = createClient(transport);
  await client.getPlaylist(2);
  const n = calls.length;
  await client.getPlaylist(2);
  assert.equal(calls.length, n);
});

test('playlist introuvable ou privée', async () => {
  const { transport } = fakeDeezer();
  await assert.rejects(createClient(transport).getPlaylist(999), (e) => e instanceof DeezerError && e.notFound);
});

test('autre erreur Deezer remontée avec son message', async () => {
  const { transport } = fakeDeezer();
  await assert.rejects(createClient(transport).call('/inconnu'), /Quota limit exceeded/);
});

test('partie : mélange de deux playlists sans doublon', async () => {
  const { transport } = fakeDeezer();
  const g = await createClient(transport).buildGame([1, '2', 2], 500);
  assert.equal(g.available, 249);
  assert.equal(g.tracks.length, 249);
  assert.equal(new Set(g.tracks.map((t) => t.id)).size, 249);
  assert.ok(g.tracks.some((t) => t.id === 1000 && t.source === 'Playlist 2'));
});

test('partie : nombre de manches respecté et ordre mélangé', async () => {
  const { transport } = fakeDeezer();
  const g = await createClient(transport).buildGame([1], 20);
  assert.equal(g.tracks.length, 20);
  const ids = g.tracks.map((t) => t.id);
  assert.notDeepEqual(ids, [...ids].sort((a, b) => a - b));
});

test('partie sans playlist', async () => {
  const { transport } = fakeDeezer();
  await assert.rejects(createClient(transport).buildGame([], 10), /Aucune playlist/);
});

test('extrait : URL fraîche, erreur si absent', async () => {
  const { transport } = fakeDeezer();
  const client = createClient(transport);
  assert.equal(await client.getPreview(42), 'https://cdn.example/fresh/42.mp3');
  await assert.rejects(client.getPreview(404), /Pas d'extrait/);
});
