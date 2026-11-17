// Couche réseau du multijoueur : un "salon" = un canal temps réel partagé.
//
// Deux implémentations avec la même interface :
//  - Supabase Realtime (Broadcast pour les messages, Presence pour la liste des connectés) ;
//  - BroadcastChannel du navigateur (onglets d'un même navigateur), utilisée pour les tests
//    en ajoutant ?transport=local à l'adresse.
//
// Interface :
//   const room = await Net.join({ code, me: { id, name, host }, onMessage(msg), onMembers(list) });
//   room.send(msg);   // diffusé à tous les AUTRES membres du salon
//   room.close();
//   onMembers reçoit la liste [{ id, name, host }] des membres connectés (soi compris).
(function (root) {
  'use strict';

  const CHANNEL_PREFIX = 'pinkatest-room-';
  const JOIN_TIMEOUT_MS = 10000;

  class NetError extends Error {}

  // ---------- Supabase Realtime ----------

  let supabaseClient = null;

  function getSupabase() {
    if (supabaseClient) return supabaseClient;
    const cfg = root.PINKATEST_CONFIG || {};
    if (!root.supabase || typeof root.supabase.createClient !== 'function') {
      throw new NetError('La bibliothèque Supabase n\'a pas pu être chargée (bloqueur de publicités ou pas de connexion ?)');
    }
    if (!cfg.supabaseUrl || !cfg.supabaseKey) throw new NetError('Supabase n\'est pas configuré (docs/config.js)');
    supabaseClient = root.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 20 } },
    });
    return supabaseClient;
  }

  function joinSupabase({ code, me, onMessage, onMembers }) {
    const client = getSupabase();
    const channel = client.channel(CHANNEL_PREFIX + code, {
      config: { broadcast: { self: false, ack: false }, presence: { key: me.id } },
    });

    const membersFromPresence = () => {
      const state = channel.presenceState();
      const list = [];
      for (const key of Object.keys(state)) {
        const meta = state[key] && state[key][0];
        if (meta && meta.id) list.push({ id: meta.id, name: meta.name, host: !!meta.host });
      }
      return list;
    };

    channel.on('broadcast', { event: 'msg' }, ({ payload }) => onMessage(payload));
    channel.on('presence', { event: 'sync' }, () => onMembers(membersFromPresence()));

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        client.removeChannel(channel);
        reject(new NetError('Le serveur de jeu ne répond pas (projet Supabase en pause ?)'));
      }, JOIN_TIMEOUT_MS);

      channel.subscribe(async (status, err) => {
        if (status === 'SUBSCRIBED' && !settled) {
          try {
            await channel.track({ id: me.id, name: me.name, host: !!me.host });
          } catch (e) { /* la présence sera retentée par la bibliothèque */ }
          settled = true;
          clearTimeout(timer);
          resolve({
            send(msg) {
              channel.send({ type: 'broadcast', event: 'msg', payload: msg });
            },
            close() {
              try { channel.untrack(); } catch { /* ignore */ }
              client.removeChannel(channel);
            },
          });
        } else if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !settled) {
          settled = true;
          clearTimeout(timer);
          client.removeChannel(channel);
          reject(new NetError(`Connexion au serveur de jeu impossible${err && err.message ? ` (${err.message})` : ''}`));
        }
      });
    });
  }

  // ---------- BroadcastChannel (tests, même navigateur) ----------

  function joinLocal({ code, me, onMessage, onMembers }) {
    const bc = new BroadcastChannel(CHANNEL_PREFIX + code);
    const members = new Map([[me.id, { id: me.id, name: me.name, host: !!me.host }]]);
    const emitMembers = () => onMembers([...members.values()]);

    bc.onmessage = (ev) => {
      const d = ev.data || {};
      if (d.sys === 'join' || d.sys === 'here') {
        members.set(d.member.id, d.member);
        if (d.sys === 'join') bc.postMessage({ sys: 'here', member: members.get(me.id) });
        emitMembers();
      } else if (d.sys === 'leave') {
        members.delete(d.id);
        emitMembers();
      } else if (d.msg) {
        onMessage(d.msg);
      }
    };
    const onUnload = () => bc.postMessage({ sys: 'leave', id: me.id });
    root.addEventListener('pagehide', onUnload);

    bc.postMessage({ sys: 'join', member: members.get(me.id) });
    return new Promise((resolve) => {
      setTimeout(() => {
        emitMembers();
        resolve({
          send(msg) { bc.postMessage({ msg }); },
          close() { onUnload(); root.removeEventListener('pagehide', onUnload); bc.close(); },
        });
      }, 150);
    });
  }

  // ---------- Choix du transport ----------

  function useLocal() {
    try { return new URLSearchParams(root.location.search).get('transport') === 'local'; } catch { return false; }
  }

  function join(opts) {
    return useLocal() ? joinLocal(opts) : joinSupabase(opts);
  }

  // Code de salon : 4 caractères sans ambiguïté (pas de 0/O, 1/I/L)
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  function randomCode(len = 4) {
    let s = '';
    const buf = new Uint32Array(len);
    root.crypto.getRandomValues(buf);
    for (const n of buf) s += ALPHABET[n % ALPHABET.length];
    return s;
  }
  function normalizeCode(input) {
    return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  }
  function randomId() {
    return (root.crypto.randomUUID ? root.crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/-/g, '').slice(0, 16);
  }

  root.Net = { join, randomCode, normalizeCode, randomId, NetError, isLocal: useLocal };
})(window);
