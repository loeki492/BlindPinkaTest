// Accès à l'API Deezer depuis le navigateur.


(function (root) {
  'use strict';

  const API = 'https://api.deezer.com';
  const MAX_TRACKS_PER_PLAYLIST = 2000;
  const PAGE_SIZE = 100;
  const CACHE_TTL_MS = 10 * 60 * 1000;

  class DeezerError extends Error {
    constructor(message, notFound = false) {
      super(message);
      this.notFound = notFound;
    }
  }

  // ---------- Transports ----------

  let jsonpSeq = 0;

  function jsonpTransport(path, { base = API, timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const cb = `__pinkatest_cb_${Date.now()}_${jsonpSeq++}`;
      const sep = path.includes('?') ? '&' : '?';
      const script = document.createElement('script');
      let done = false;

      const cleanup = () => {
        done = true;
        clearTimeout(timer);
        script.remove();
        // On garde une fonction vide un moment au cas où une réponse arriverait après le délai
        root[cb] = () => {};
        setTimeout(() => { delete root[cb]; }, 60000);
      };
      const timer = setTimeout(() => {
        if (done) return;
        cleanup();
        reject(new DeezerError('Deezer ne répond pas (délai dépassé)'));
      }, timeout);

      root[cb] = (data) => {
        if (done) return;
        cleanup();
        resolve(data);
      };
      script.onerror = () => {
        if (done) return;
        cleanup();
        reject(new DeezerError('Impossible de joindre Deezer'));
      };
      // Script chargé mais callback jamais appelé : Deezer n'a pas répondu en JSONP
      script.onload = () => {
        setTimeout(() => {
          if (done) return;
          cleanup();
          reject(new DeezerError("Deezer n'a pas répondu au format JSONP"));
        }, 0);
      };
      script.src = `${base}${path}${sep}output=jsonp&callback=${cb}`;
      document.head.appendChild(script);
    });
  }

  async function proxyTransport(path) {
    const res = await fetch(`api/deezer${path}`);
    if (!res.ok) throw new DeezerError(`Le relais a répondu HTTP ${res.status}`);
    return res.json();
  }

  function autoTransport({ base = API } = {}) {
    let mode = 'jsonp';
    let proxyChecked = null;
    const proxyAvailable = () => {
      if (!proxyChecked) {
        proxyChecked = fetch('api/health').then((r) => r.ok).catch(() => false);
      }
      return proxyChecked;
    };
    const transport = async (path) => {
      if (mode === 'jsonp') {
        try {
          return await jsonpTransport(path, { base });
        } catch (e) {
          if (!(await proxyAvailable())) throw e;
          mode = 'proxy';
          console.warn('JSONP Deezer indisponible, passage par le relais local.', e.message);
        }
      }
      return proxyTransport(path);
    };
    transport.mode = () => mode;
    return transport;
  }

  // ---------- Outils ----------

  function parsePlaylistId(input) {
    const s = String(input == null ? '' : input).trim();
    const m = s.match(/playlist\/(\d+)/) || s.match(/^(\d+)$/);
    return m ? Number(m[1]) : null;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ---------- Client ----------

  function createClient(transport) {
    const cache = new Map();

    async function call(path) {
      const data = await transport(path);
      // Deezer signale ses erreurs dans le corps de la réponse : { error: { code, message } }
      if (data && data.error) {
        if (data.error.code === 800) {
          throw new DeezerError('Introuvable sur Deezer (ID incorrect ou playlist privée ?)', true);
        }
        throw new DeezerError(`Erreur Deezer : ${data.error.message || 'inconnue'}`);
      }
      return data;
    }

    async function getPlaylist(id) {
      const hit = cache.get(id);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

      const info = await call(`/playlist/${id}`);
      const tracks = [];
      for (let index = 0; index < MAX_TRACKS_PER_PLAYLIST; index += PAGE_SIZE) {
        const page = await call(`/playlist/${id}/tracks?limit=${PAGE_SIZE}&index=${index}`);
        const data = page.data || [];
        for (const t of data) {
          if (!t.readable || !t.preview) continue; // pas lisible ou pas d'extrait
          tracks.push({
            id: t.id,
            title: t.title_short || t.title,
            artist: t.artist ? t.artist.name : '',
            album: t.album ? t.album.title : '',
            cover: t.album ? (t.album.cover_medium || t.album.cover || '') : '',
            link: t.link,
          });
        }
        const total = typeof page.total === 'number' ? page.total : info.nb_tracks;
        if (data.length < PAGE_SIZE || index + PAGE_SIZE >= total) break;
      }

      const value = {
        id: Number(id),
        name: info.title,
        picture: info.picture_medium || info.picture || '',
        totalTracks: info.nb_tracks,
        playableTracks: tracks.length,
        tracks,
      };
      cache.set(id, { at: Date.now(), value });
      return value;
    }

    async function buildGame(ids, rounds) {
      const unique = [...new Set(ids.map(parsePlaylistId).filter(Boolean))];
      if (!unique.length) throw new DeezerError('Aucune playlist sélectionnée');
      const playlists = await Promise.all(unique.map(getPlaylist));
      const pool = new Map();
      for (const p of playlists) {
        for (const t of p.tracks) {
          if (!pool.has(t.id)) pool.set(t.id, { ...t, source: p.name });
        }
      }
      return {
        available: pool.size,
        tracks: shuffle([...pool.values()]).slice(0, Math.max(1, rounds)),
      };
    }

    async function getPreview(trackId) {
      const t = await call(`/track/${trackId}`);
      if (!t.preview) throw new DeezerError("Pas d'extrait disponible pour ce titre");
      return t.preview;
    }

    return { call, getPlaylist, buildGame, getPreview };
  }

  const api = {
    DeezerError, createClient, jsonpTransport, proxyTransport, autoTransport, parsePlaylistId, shuffle,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Deezer = api;
})(typeof window !== 'undefined' ? window : globalThis);
