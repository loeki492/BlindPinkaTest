
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const P = window.Pinka;
  const audio = P.audio;

  const NAME_KEY = 'pinkatest.name';
  const ID_KEY = 'pinkatest.playerId';
  const READY_TIMEOUT_MS = 6000;
  const REVEAL_GRACE_MS = 400;
  const HOST_LOST_DELAY_MS = 5000; 
  const GUESS_MIN_INTERVAL_MS = 250;
  const HOST_MESSAGES = new Set(['lobby', 'welcome', 'start', 'round', 'go', 'found', 'miss', 'reveal', 'end', 'closed']);

  // ---------- État ----------

  const me = { id: sessionId(), name: '' };
  let room = null;
  let code = null;
  let isHost = false;
  let hostId = null;
  let joinedAt = 0;
  let members = [];
  let names = {};
  let scores = {};
  let status = {};
  let phase = 'idle';
  let info = { playlists: [], rounds: 0, duration: 20 };
  let cur = null;
  let timerRaf = 0;
  let hostLostTimer = null;
  let welcomeResolve = null;
  let H = null;

  function sessionId() {
    try {
      let id = sessionStorage.getItem(ID_KEY);
      if (!id) { id = Net.randomId(); sessionStorage.setItem(ID_KEY, id); }
      return id;
    } catch { return Net.randomId(); }
  }

  function cleanName(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- Envoi des messages ----------

  function broadcast(msg) {
    const full = { ...msg, from: me.id };
    if (room) room.send(full);
    handle(full);
  }

  function toHost(msg) {
    const full = { ...msg, from: me.id };
    if (isHost) handle(full);
    else if (room) room.send(full);
  }

  // ---------- Son ----------

  let silentUrl = null;
  function unlockAudio() {
    try {
      if (!silentUrl) {
        const n = 800;
        const buf = new ArrayBuffer(44 + n);
        const v = new DataView(buf);
        const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
        w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true);
        v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
        new Uint8Array(buf, 44).fill(128);
        silentUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
      }
      audio.src = silentUrl;
      const p = audio.play();
      if (p) p.then(() => audio.pause()).catch(() => {});
    } catch { /* sans importance */ }
  }


  function mpError(message) { P.showError($('mp-error'), message); }

  function readName() {
    const name = cleanName($('mp-name').value);
    if (!name) {
      mpError('Choisis d\'abord un pseudo.');
      $('mp-name').focus();
      return null;
    }
    try { localStorage.setItem(NAME_KEY, name); } catch { /* ignore */ }
    return name;
  }

  async function connect(roomCode, asHost) {
    code = roomCode;
    isHost = asHost;
    hostId = asHost ? me.id : null;
    joinedAt = Date.now();
    room = await Net.join({
      code,
      me: { id: me.id, name: me.name, host: asHost },
      onMessage: handle,
      onMembers,
    });
  }

  async function createRoom() {
    mpError('');
    const name = readName();
    if (!name) return;
    const selected = P.selectedPlaylists();
    if (!selected.length) return mpError('Coche au moins une playlist pour créer un salon.');
    P.readSettings();
    me.name = name;
    P.stopSolo();
    unlockAudio();
    setBusy($('host-btn'), true, 'Création…');
    try {
      // On vérifie qu'aucun autre salon n'utilise déjà ce code
      for (let attempt = 0; ; attempt++) {
        await connect(Net.randomCode(), true);
        await sleep(800);
        if (!members.some((m) => m.host && m.id !== me.id)) break;
        room.close(); room = null;
        if (attempt >= 4) throw new Error('Impossible de trouver un code de salon libre, réessaie.');
      }
      H = {
        playlistIds: selected.map((p) => p.id),
        rounds: P.settings.rounds,
        duration: P.settings.duration,
      };
      info = { playlists: selected.map((p) => p.name), rounds: H.rounds, duration: H.duration };
      names = { [me.id]: me.name };
      scores = { [me.id]: 0 };
      sendLobby();
    } catch (e) {
      resetRoom();
      mpError(e.message);
    } finally {
      setBusy($('host-btn'), false);
    }
  }

  async function joinRoom(ev) {
    if (ev) ev.preventDefault();
    mpError('');
    const name = readName();
    if (!name) return;
    const roomCode = Net.normalizeCode($('join-code').value);
    if (roomCode.length !== 4) return mpError('Le code du salon fait 4 caractères.');
    me.name = name;
    P.stopSolo();
    unlockAudio();
    const btn = $('join-form').querySelector('button');
    setBusy(btn, true, 'Connexion…');
    try {
      await connect(roomCode, false);
      const welcomed = new Promise((resolve) => { welcomeResolve = resolve; });
      // On se présente à l'hôte (deux fois au cas où le premier message se perde)
      for (let i = 0; i < 3; i++) {
        toHost({ t: 'hello', name: me.name });
        const ok = await Promise.race([welcomed, sleep(2000).then(() => false)]);
        if (ok) break;
        if (i === 2) throw new Error(`Salon ${roomCode} introuvable. Vérifie le code, ou demande à l'hôte s'il est toujours connecté.`);
      }
    } catch (e) {
      resetRoom();
      mpError(e.message);
    } finally {
      welcomeResolve = null;
      setBusy(btn, false);
    }
  }

  function leaveRoom(message) {
    if (isHost && room) {
      try { room.send({ t: 'closed', from: me.id }); } catch { /* ignore */ }
    }
    resetRoom();
    P.show('setup');
    if (message) mpError(message);
  }

  function resetRoom() {
    stopTimer();
    clearTimeout(hostLostTimer);
    if (H) { clearTimeout(H.readyTimer); clearTimeout(H.revealTimer); }
    if (room) { try { room.close(); } catch { /* ignore */ } }
    room = null; code = null; isHost = false; hostId = null; H = null; cur = null;
    members = []; names = {}; scores = {}; status = {}; phase = 'idle';
    audio.pause();
  }

  function setBusy(btn, busy, label) {
    if (busy) {
      btn.dataset.label = btn.textContent;
      btn.textContent = label;
      btn.disabled = true;
    } else {
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
      btn.disabled = false;
      if (btn.id === 'host-btn') btn.disabled = !P.selectedPlaylists().length;
    }
  }

  // ---------- Membres connectés ----------

  function onMembers(list) {
    members = list;
    for (const m of list) {
      if (m.name) names[m.id] = m.name;
      if (m.host && m.id !== me.id && !isHost) hostId = m.id;
    }
    if (isHost) {
      for (const m of list) if (!(m.id in scores)) scores[m.id] = 0;
      if (H && H.current && !H.current.startedAt) maybeGo();
    } else if (phase !== 'idle') {
      const hostHere = list.some((m) => m.host);
      clearTimeout(hostLostTimer);
      if (!hostHere && Date.now() - joinedAt > 1500) {
        hostLostTimer = setTimeout(() => {
          if (!members.some((m) => m.host)) leaveRoom("L'hôte a quitté le salon.");
        }, HOST_LOST_DELAY_MS);
      }
    }
    renderPlayers();
  }

  // ---------- Réception des messages ----------

  function handle(msg) {
    if (!msg || !msg.t) return;
    // Les messages "de l'hôte" ne sont acceptés que s'ils viennent bien de l'hôte
    if (HOST_MESSAGES.has(msg.t) && msg.from !== hostId) {
      if (msg.t === 'welcome' && msg.to === me.id && !isHost) hostId = msg.from;
      else return;
    }
    switch (msg.t) {
      // --- côté hôte ---
      case 'hello': return isHost && onHello(msg);
      case 'ready': return isHost && onReady(msg);
      case 'guess': return isHost && onGuess(msg);
      // --- côté joueurs (et hôte) ---
      case 'welcome': return onWelcome(msg);
      case 'lobby': return onLobby(msg);
      case 'start': return onStart(msg);
      case 'round': return onRound(msg);
      case 'go': return onGo(msg);
      case 'found': return onFound(msg);
      case 'miss': return onMiss(msg);
      case 'reveal': return onReveal(msg);
      case 'end': return onEnd(msg);
      case 'closed': return leaveRoom("L'hôte a fermé le salon.");
      default: return undefined;
    }
  }

  // ---------- Hôte ----------

  function sendLobby() {
    broadcast({ t: 'lobby', names, scores, info });
  }

  function onHello(msg) {
    const name = cleanName(msg.name) || 'Joueur';
    names[msg.from] = name;
    if (!(msg.from in scores)) scores[msg.from] = 0;
    const payload = {
      t: 'welcome', to: msg.from, phase: phase === 'lobby' ? 'lobby' : (phase === 'end' ? 'end' : 'waiting'),
      names, scores, info, index: H && H.index, total: H && H.total,
    };
    if (room) room.send({ ...payload, from: me.id });
    renderPlayers();
  }

  async function hostStart() {
    if (!isHost || !H) return;
    const btn = $('lobby-start');
    setBusy(btn, true, 'Préparation…');
    try {
      const data = await P.deezer.buildGame(H.playlistIds, H.rounds);
      if (!data.tracks.length) throw new Error('Aucun titre jouable dans les playlists choisies.');
      H.tracks = data.tracks;
      H.pos = 0;
      H.index = 0;
      H.total = Math.min(H.rounds, data.tracks.length);
      for (const id of Object.keys(scores)) scores[id] = 0;
      for (const m of members) scores[m.id] = 0;
      broadcast({ t: 'start', total: H.total, duration: H.duration, scores, names });
      await hostNextRound();
    } catch (e) {
      P.showError($('lobby-error'), e.message);
    } finally {
      setBusy(btn, false);
    }
  }

  async function hostNextRound() {
    if (!isHost || !H) return;
    clearTimeout(H.readyTimer);
    clearTimeout(H.revealTimer);
    $('m-next').disabled = true;
    try {
      if (H.index >= H.total) return hostEnd();
      // On cherche le prochain titre dont l'extrait est disponible
      let track = null;
      let preview = null;
      while (H.pos < H.tracks.length && !preview) {
        track = H.tracks[H.pos++];
        try { preview = await P.deezer.getPreview(track.id); } catch { preview = null; }
      }
      if (!preview) return hostEnd();
      H.index++;
      const expected = new Set(members.map((m) => m.id));
      expected.add(me.id);
      H.current = { track, expected, ready: new Set(), found: {}, startedAt: 0, revealed: false };
      broadcast({ t: 'round', index: H.index, total: H.total, duration: H.duration, preview });
      H.readyTimer = setTimeout(hostGo, READY_TIMEOUT_MS);
    } finally {
      $('m-next').disabled = false;
    }
  }

  function onReady(msg) {
    if (!H || !H.current || msg.index !== H.index) return;
    H.current.ready.add(msg.from);
    maybeGo();
  }

  function maybeGo() {
    if (!H || !H.current || H.current.startedAt) return;
    const online = new Set(members.map((m) => m.id));
    const waiting = [...H.current.expected].filter((id) => online.has(id) && !H.current.ready.has(id));
    if (!waiting.length) hostGo();
  }

  function hostGo() {
    if (!H || !H.current || H.current.startedAt) return;
    clearTimeout(H.readyTimer);
    H.current.startedAt = Date.now();
    broadcast({ t: 'go', index: H.index });
    H.revealTimer = setTimeout(hostReveal, H.duration * 1000 + REVEAL_GRACE_MS);
  }

  function roundStatus() {
    const out = {};
    for (const [id, f] of Object.entries(H.current.found)) out[id] = { title: f.title, artist: f.artist };
    return out;
  }

  function onGuess(msg) {
    if (!H || !H.current || msg.index !== H.index || !H.current.startedAt || H.current.revealed) return;
    const text = String(msg.text || '').slice(0, 120);
    const f = H.current.found[msg.from] || (H.current.found[msg.from] = { title: false, artist: false, points: 0 });
    const t = H.current.track;
    const newTitle = !f.title && Match.isMatch(text, t.title);
    const newArtist = !f.artist && Match.isMatch(text, t.artist);
    if (!newTitle && !newArtist) {
      broadcast({ t: 'miss', to: msg.from, seq: msg.seq });
      return;
    }
    const elapsed = Date.now() - H.current.startedAt;
    const remaining = Math.max(0, 1 - elapsed / (H.duration * 1000));
    const perItem = Math.round(50 + 50 * remaining);
    const gained = perItem * ((newTitle ? 1 : 0) + (newArtist ? 1 : 0));
    if (newTitle) f.title = true;
    if (newArtist) f.artist = true;
    f.points += gained;
    scores[msg.from] = (scores[msg.from] || 0) + gained;
    broadcast({
      t: 'found', index: H.index, to: msg.from, seq: msg.seq,
      title: newTitle, artist: newArtist, points: gained, scores, status: roundStatus(),
    });
    const everyoneDone = members
      .filter((m) => H.current.expected.has(m.id))
      .every((m) => {
        const x = H.current.found[m.id];
        return x && x.title && x.artist;
      });
    if (everyoneDone) setTimeout(hostReveal, 600);
  }

  function hostReveal() {
    if (!H || !H.current || H.current.revealed) return;
    H.current.revealed = true;
    clearTimeout(H.readyTimer);
    clearTimeout(H.revealTimer);
    const t = H.current.track;
    const gained = {};
    for (const [id, f] of Object.entries(H.current.found)) gained[id] = f.points;
    broadcast({
      t: 'reveal', index: H.index, total: H.total,
      title: t.title, artist: t.artist, cover: t.cover, source: t.source,
      status: roundStatus(), gained, scores, names,
      last: H.index >= H.total || H.pos >= H.tracks.length,
    });
  }

  function hostEnd() {
    if (!H) return;
    clearTimeout(H.readyTimer);
    clearTimeout(H.revealTimer);
    H.current = null;
    broadcast({ t: 'end', scores, names });
  }

  function hostBackToLobby() {
    if (!isHost || !H) return;
    H.current = null;
    for (const id of Object.keys(scores)) scores[id] = 0;
    sendLobby();
  }


  function onWelcome(msg) {
    if (msg.to !== me.id) return;
    names = { ...msg.names, ...names };
    scores = msg.scores || {};
    info = msg.info || info;
    if (welcomeResolve) welcomeResolve(true);
    if (msg.phase === 'lobby') {
      phase = 'lobby';
      showLobby();
    } else {
      phase = 'waiting';
      showGameWaiting(msg.index, msg.total);
    }
  }

  function onLobby(msg) {
    names = { ...names, ...msg.names };
    scores = msg.scores || scores;
    info = msg.info || info;
    phase = 'lobby';
    stopTimer();
    audio.pause();
    showLobby();
  }

  function onStart(msg) {
    scores = msg.scores || {};
    names = { ...names, ...msg.names };
    info.duration = msg.duration;
  }

  function onRound(msg) {
    phase = 'loading';
    status = {};
    cur = {
      index: msg.index, total: msg.total, duration: msg.duration,
      title: null, artist: null, seq: 0, guesses: new Map(), lastGuessAt: 0, readySent: false,
    };
    stopTimer();
    P.show('mgame');
    $('m-round').textContent = `Manche ${msg.index} / ${msg.total}`;
    $('m-code').textContent = `Salon ${code}`;
    setTimer(1, msg.duration);
    $('m-status').textContent = "Chargement de l'extrait…";
    $('m-feedback').textContent = '';
    $('m-feedback').className = 'feedback';
    $('m-found-title').textContent = 'Titre : ?';
    $('m-found-artist').textContent = 'Artiste : ?';
    $('m-found-title').classList.remove('ok');
    $('m-found-artist').classList.remove('ok');
    $('m-answer').value = '';
    $('m-answer').disabled = true;
    $('m-answer-zone').hidden = false;
    $('m-reveal').hidden = true;
    $('m-feed').innerHTML = '';
    updateHostControls();
    renderPlayers();

    const sendReady = () => {
      if (cur && cur.index === msg.index && !cur.readySent) {
        cur.readySent = true;
        toHost({ t: 'ready', index: msg.index });
      }
    };
    audio.pause();
    audio.src = msg.preview;
    audio.addEventListener('canplay', sendReady, { once: true });
    audio.addEventListener('error', () => {
      if (!cur || cur.index !== msg.index) return;
      $('m-status').textContent = "Impossible de charger l'extrait sur cet appareil.";
      sendReady();
    }, { once: true });
    audio.load();
  }

  function onGo(msg) {
    if (!cur || cur.index !== msg.index) return;
    phase = 'playing';
    $('m-status').textContent = '';
    $('m-answer').disabled = false;
    $('m-answer').focus();
    try { audio.currentTime = 0; } catch { /* ignore */ }
    const p = audio.play();
    if (p) {
      p.catch(() => {
        $('m-status').textContent = 'Le son est bloqué par le navigateur : clique sur « Rejouer l\'extrait ».';
      });
    }
    startTimer(cur.duration);
    updateHostControls();
  }

  function onFound(msg) {
    if (!cur || cur.index !== msg.index) return;
    scores = msg.scores || scores;
    status = msg.status || status;
    if (msg.to === me.id) {
      const guess = cur.guesses.get(msg.seq) || '';
      if (msg.title) {
        $('m-found-title').textContent = `Titre : ${guess}`;
        $('m-found-title').classList.add('ok');
      }
      if (msg.artist) {
        $('m-found-artist').textContent = `Artiste : ${guess}`;
        $('m-found-artist').classList.add('ok');
      }
      const what = msg.title && msg.artist ? 'titre et artiste' : msg.title ? 'titre' : 'artiste';
      $('m-feedback').textContent = `Bon ${what} ! +${msg.points} pts`;
      $('m-feedback').className = 'feedback good';
    } else {
      const who = names[msg.to] || 'Un joueur';
      const what = msg.title && msg.artist ? 'le titre et l\'artiste' : msg.title ? 'le titre' : 'l\'artiste';
      addFeed(`${who} a trouvé ${what} !`);
    }
    renderPlayers();
  }

  function onMiss(msg) {
    if (!cur || msg.to !== me.id) return;
    $('m-feedback').textContent = 'Raté…';
    $('m-feedback').className = 'feedback bad';
  }

  function onReveal(msg) {
    if (!cur || cur.index !== msg.index) {

      cur = { index: msg.index, total: msg.total, duration: info.duration, guesses: new Map(), seq: 0 };
      P.show('mgame');
      $('m-round').textContent = `Manche ${msg.index} / ${msg.total}`;
      $('m-code').textContent = `Salon ${code}`;
    }
    phase = 'reveal';
    stopTimer();
    setTimer(0, 0);
    scores = msg.scores || scores;
    status = msg.status || {};
    names = { ...names, ...msg.names };
    cur.last = msg.last;
    $('m-answer').disabled = true;
    $('m-status').textContent = '';
    $('m-reveal-cover').src = msg.cover || '';
    $('m-reveal-cover').hidden = !msg.cover;
    $('m-reveal-title').textContent = msg.title;
    $('m-reveal-artist').textContent = msg.artist;
    $('m-reveal-source').textContent = `Playlist : ${msg.source}`;
    $('m-reveal').hidden = false;
    const mine = msg.gained && msg.gained[me.id];
    if (!mine) {
      $('m-feedback').textContent = 'Pas de point pour cette manche.';
      $('m-feedback').className = 'feedback';
    }
    updateHostControls();
    renderPlayers(msg.gained);
  }

  function onEnd(msg) {
    phase = 'end';
    stopTimer();
    audio.pause();
    scores = msg.scores || scores;
    names = { ...names, ...msg.names };
    const ol = $('m-ranking');
    ol.innerHTML = '';
    for (const p of ranking()) {
      const li = document.createElement('li');
      const n = document.createElement('span');
      n.textContent = p.id === me.id ? `${p.name} (toi)` : p.name;
      const s = document.createElement('strong');
      s.textContent = `${p.score} pts`;
      li.append(n, s);
      if (p.id === me.id) li.classList.add('me');
      ol.appendChild(li);
    }
    $('m-end-host').hidden = !isHost;
    $('m-end-guest').hidden = isHost;
    P.show('mend');
  }

  function showLobby() {
    P.show('lobby');
    $('lobby-code').textContent = code;
    const link = `${location.origin}${location.pathname}?salon=${code}${Net.isLocal() ? '&transport=local' : ''}`;
    $('lobby-link').value = link;
    $('lobby-playlists').textContent = info.playlists && info.playlists.length ? info.playlists.join(', ') : '—';
    $('lobby-settings').textContent = `${info.rounds} manche(s), ${info.duration} s d'écoute`;
    $('lobby-host').hidden = !isHost;
    $('lobby-guest').hidden = isHost;
    P.showError($('lobby-error'), '');
    renderPlayers();
  }

  function showGameWaiting(index, total) {
    P.show('mgame');
    cur = null;
    $('m-round').textContent = index ? `Manche ${index} / ${total}` : '';
    $('m-code').textContent = `Salon ${code}`;
    setTimer(0, 0);
    $('m-status').textContent = 'Partie en cours : tu joueras dès la prochaine manche.';
    $('m-answer-zone').hidden = true;
    $('m-reveal').hidden = true;
    updateHostControls();
    renderPlayers();
  }

  function updateHostControls() {
    $('m-skip').hidden = !(isHost && (phase === 'playing' || phase === 'loading'));
    $('m-next').hidden = !(isHost && phase === 'reveal');
    $('m-next').textContent = cur && cur.last ? 'Voir le classement' : 'Manche suivante';
    $('m-wait-host').hidden = isHost || phase !== 'reveal';
  }

  function addFeed(text) {
    const li = document.createElement('li');
    li.textContent = text;
    $('m-feed').prepend(li);
  }

  function ranking() {
    const ids = new Set([...members.map((m) => m.id), ...Object.keys(scores)]);
    const online = new Set(members.map((m) => m.id));
    return [...ids]
      .filter((id) => names[id])
      .map((id) => ({ id, name: names[id], score: scores[id] || 0, online: online.has(id), host: id === hostId }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  function renderPlayers(gained) {
    const lobbyList = $('lobby-players');
    lobbyList.innerHTML = '';
    for (const m of members) {
      const li = document.createElement('li');
      li.textContent = `${m.name || names[m.id] || '…'}${m.id === me.id ? ' (toi)' : ''}${m.host ? ' 👑' : ''}`;
      lobbyList.appendChild(li);
    }
    $('lobby-count').textContent = `${members.length} joueur(s)`;

    const board = $('m-board');
    board.innerHTML = '';
    for (const p of ranking()) {
      const li = document.createElement('li');
      if (p.id === me.id) li.classList.add('me');
      if (!p.online) li.classList.add('offline');
      const n = document.createElement('span');
      n.className = 'name';
      n.textContent = `${p.name}${p.host ? ' 👑' : ''}${p.online ? '' : ' (parti)'}`;
      const marks = document.createElement('span');
      marks.className = 'marks';
      const st = status[p.id] || {};
      marks.textContent = `${st.title ? '🎵' : ''}${st.artist ? '🎤' : ''}`;
      marks.title = 'Trouvé cette manche : 🎵 titre, 🎤 artiste';
      const s = document.createElement('strong');
      s.textContent = `${p.score}`;
      if (gained && gained[p.id]) {
        const g = document.createElement('small');
        g.className = 'gain';
        g.textContent = ` +${gained[p.id]}`;
        s.appendChild(g);
      }
      li.append(n, marks, s);
      board.appendChild(li);
    }
  }

  // ---------- Chrono local ----------

  function startTimer(duration) {
    stopTimer();
    const start = performance.now();
    const tick = () => {
      const left = Math.max(duration - (performance.now() - start) / 1000, 0);
      setTimer(left / duration, Math.ceil(left));
      if (left > 0) timerRaf = requestAnimationFrame(tick);
      else $('m-status').textContent = 'Temps écoulé…';
    };
    timerRaf = requestAnimationFrame(tick);
  }

  function stopTimer() {
    cancelAnimationFrame(timerRaf);
    timerRaf = 0;
  }

  function setTimer(ratio, seconds) {
    $('m-timer-bar').style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
    $('m-timer-label').textContent = `${seconds} s`;
  }

  // ---------- Événements de l'interface ----------

  $('m-answer-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = $('m-answer');
    const text = input.value.trim();
    if (!text || phase !== 'playing' || !cur) return;
    const now = Date.now();
    if (now - cur.lastGuessAt < GUESS_MIN_INTERVAL_MS) return;
    cur.lastGuessAt = now;
    cur.seq++;
    cur.guesses.set(cur.seq, text);
    toHost({ t: 'guess', index: cur.index, seq: cur.seq, text });
    input.value = '';
  });

  $('m-replay').addEventListener('click', () => {
    if (phase !== 'playing' && phase !== 'reveal') return;
    try { audio.currentTime = 0; } catch { /* ignore */ }
    audio.play().then(() => { if (phase === 'playing') $('m-status').textContent = ''; }).catch(() => {});
  });

  $('host-btn').addEventListener('click', createRoom);
  $('join-form').addEventListener('submit', joinRoom);
  $('lobby-start').addEventListener('click', hostStart);
  $('m-skip').addEventListener('click', hostReveal);
  $('m-next').addEventListener('click', () => {
    if (cur && cur.last) hostEnd();
    else hostNextRound();
  });
  $('m-again').addEventListener('click', hostBackToLobby);
  ['lobby-leave', 'm-leave', 'm-end-leave', 'm-end-leave2'].forEach((id) => {
    $(id).addEventListener('click', () => leaveRoom());
  });
  $('lobby-copy').addEventListener('click', async () => {
    const input = $('lobby-link');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand && document.execCommand('copy');
    }
    $('lobby-copy').textContent = 'Copié !';
    setTimeout(() => { $('lobby-copy').textContent = 'Copier le lien'; }, 1500);
  });
  $('join-code').addEventListener('input', () => {
    const v = Net.normalizeCode($('join-code').value);
    if ($('join-code').value !== v) $('join-code').value = v;
  });

  window.addEventListener('pagehide', () => {
    if (isHost && room) { try { room.send({ t: 'closed', from: me.id }); } catch { /* ignore */ } }
  });

  // ---------- Démarrage ----------

  try { $('mp-name').value = localStorage.getItem(NAME_KEY) || ''; } catch { /* ignore */ }
  const fromLink = Net.normalizeCode(new URLSearchParams(location.search).get('salon'));
  if (fromLink) {
    $('join-code').value = fromLink;
    (cleanName($('mp-name').value) ? $('join-form').querySelector('button') : $('mp-name')).focus();
  }
})();
