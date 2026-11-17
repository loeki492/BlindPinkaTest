// Pinkatest — logique de l'interface
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'pinkatest.playlists';
  const SETTINGS_KEY = 'pinkatest.settings';

  // ---------- Stockage local (navigateur) ----------

  function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* stockage indisponible : pas grave */ }
  }

  // Client Deezer (JSONP direct, relais local en secours) — voir deezer.js
  const deezer = Deezer.createClient(Deezer.autoTransport());

  // ---------- Écrans ----------

  function show(screen) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${screen}`));
    $('volume-bar').hidden = !(screen === 'game' || screen === 'mgame');
    window.scrollTo(0, 0);
  }

  function showError(el, message) {
    el.textContent = message || '';
    el.hidden = !message;
  }

  // ---------- Gestion des playlists ----------

  // { id, name, picture, playableTracks, totalTracks, selected }
  let playlists = load(STORAGE_KEY, []);

  function persistPlaylists() { save(STORAGE_KEY, playlists); }

  function renderPlaylists() {
    const ul = $('playlist-list');
    ul.innerHTML = '';
    for (const p of playlists) {
      const li = document.createElement('li');
      li.className = p.selected ? 'selected' : '';

      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!p.selected;
      cb.addEventListener('change', () => { p.selected = cb.checked; persistPlaylists(); renderPlaylists(); });
      label.appendChild(cb);

      if (p.picture) {
        const img = document.createElement('img');
        img.src = p.picture;
        img.alt = '';
        label.appendChild(img);
      }

      const text = document.createElement('span');
      text.className = 'pl-text';
      const name = document.createElement('strong');
      name.textContent = p.name || `Playlist ${p.id}`;
      const meta = document.createElement('small');
      meta.textContent = p.error
        ? p.error
        : p.playableTracks != null
          ? `${p.playableTracks} titre(s) jouable(s) sur ${p.totalTracks}`
          : 'Chargement…';
      if (p.error) meta.className = 'error-text';
      text.append(name, meta);
      label.appendChild(text);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon';
      del.title = 'Retirer';
      del.textContent = '✕';
      del.addEventListener('click', () => {
        playlists = playlists.filter((x) => x !== p);
        persistPlaylists();
        renderPlaylists();
      });

      li.append(label, del);
      ul.appendChild(li);
    }
    $('playlist-empty').hidden = playlists.length > 0;
    const canStart = playlists.some((p) => p.selected && !p.error);
    $('start-btn').disabled = !canStart;
    $('host-btn').disabled = !canStart;
  }

  const parseId = Deezer.parsePlaylistId;

  async function refreshPlaylist(p) {
    try {
      const info = await deezer.getPlaylist(p.id);
      Object.assign(p, {
        name: info.name, picture: info.picture,
        playableTracks: info.playableTracks, totalTracks: info.totalTracks, error: null,
      });
    } catch (e) {
      p.error = e.message;
    }
    persistPlaylists();
    renderPlaylists();
  }

  $('add-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = $('add-input');
    const id = parseId(input.value);
    if (!id) return showError($('add-error'), "Ce n'est ni un ID ni un lien de playlist Deezer.");
    if (playlists.some((p) => p.id === id)) return showError($('add-error'), 'Cette playlist est déjà dans la liste.');
    showError($('add-error'), '');

    const btn = ev.submitter || ev.target.querySelector('button');
    btn.disabled = true;
    try {
      const info = await deezer.getPlaylist(id);
      playlists.push({
        id, name: info.name, picture: info.picture,
        playableTracks: info.playableTracks, totalTracks: info.totalTracks, selected: true,
      });
      persistPlaylists();
      renderPlaylists();
      input.value = '';
    } catch (e) {
      showError($('add-error'), e.message);
    } finally {
      btn.disabled = false;
    }
  });

  // Playlists prédéfinies (docs/presets.json)
  async function loadPresets() {
    let presets = [];
    try {
      const res = await fetch('presets.json', { cache: 'no-cache' });
      if (!res.ok) return;
      presets = await res.json();
      if (!Array.isArray(presets)) throw new Error('presets.json doit contenir une liste [ ... ]');
    } catch (e) {
      console.warn('presets.json ignoré :', e.message);
      return;
    }
    let added = false;
    for (const preset of presets) {
      const id = parseId(preset.id);
      if (!id || playlists.some((p) => p.id === id)) continue;
      playlists.push({ id, name: preset.name, selected: false });
      added = true;
    }
    if (added) persistPlaylists();
  }

  // ---------- Réglages ----------

  const settings = Object.assign({ rounds: 15, duration: 20, oral: false, volume: 80, muted: false }, load(SETTINGS_KEY, {}));
  $('opt-rounds').value = settings.rounds;
  $('opt-duration').value = settings.duration;
  $('opt-oral').checked = settings.oral;

  function readSettings() {
    const clamp = (v, min, max, def) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
    };
    settings.rounds = clamp($('opt-rounds').value, 1, 200, 15);
    settings.duration = clamp($('opt-duration').value, 5, 30, 20);
    settings.oral = $('opt-oral').checked;
    $('opt-rounds').value = settings.rounds;
    $('opt-duration').value = settings.duration;
    save(SETTINGS_KEY, settings);
  }

  // ---------- Volume ----------

  const audio = $('audio');

  function applyVolume() {
    settings.volume = Math.min(Math.max(Math.round(settings.volume), 0), 100);
    audio.volume = settings.volume / 100;
    audio.muted = settings.muted;
    $('volume').value = settings.volume;
    $('volume-label').textContent = settings.muted ? 'coupé' : `${settings.volume} %`;
    const icon = settings.muted || settings.volume === 0 ? '🔇' : settings.volume < 50 ? '🔉' : '🔊';
    $('mute-btn').textContent = icon;
    $('mute-btn').title = settings.muted ? 'Rétablir le son' : 'Couper le son';
    $('mute-btn').setAttribute('aria-label', $('mute-btn').title);
    $('volume').closest('.volume').classList.toggle('muted', settings.muted);
    save(SETTINGS_KEY, settings);
  }

  function changeVolume(delta) {
    settings.volume += delta;
    settings.muted = false;
    applyVolume();
  }

  $('volume').addEventListener('input', () => {
    settings.volume = Number($('volume').value);
    settings.muted = false;
    applyVolume();
  });
  $('mute-btn').addEventListener('click', () => {
    settings.muted = !settings.muted;
    applyVolume();
  });
  // Flèches ↑ / ↓ pendant la partie (y compris dans le champ de réponse) : volume +/- 10 %
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    const playing = $('screen-game').classList.contains('active') || $('screen-mgame').classList.contains('active');
    if (!playing || $('volume').disabled) return;
    if (ev.target === $('volume')) return; // le curseur gère déjà les flèches lui-même
    ev.preventDefault();
    changeVolume(ev.key === 'ArrowUp' ? 10 : -10);
  });

  applyVolume();
  // iPhone / iPad : le volume ne peut pas être modifié par une page web (propriété en lecture seule)
  if (settings.volume !== 100 && audio.volume === 1) {
    $('volume').disabled = true;
    $('volume-hint').textContent = "Sur cet appareil, règle le son avec les boutons de volume (le bouton 🔇 fonctionne).";
  }

  // ---------- Partie ----------

  let game = null;      // { tracks, index, score, results, oral, duration }
  let timer = null;     // { start, raf }
  let round = null;     // { track, foundTitle, foundArtist, revealed }

  async function startGame() {
    readSettings();
    const selected = playlists.filter((p) => p.selected && !p.error).map((p) => p.id);
    if (!selected.length) return;
    showError($('start-error'), '');
    $('start-btn').disabled = true;
    $('start-btn').textContent = 'Préparation…';
    try {
      const data = await deezer.buildGame(selected, settings.rounds);
      if (!data.tracks.length) throw new Error('Aucun titre jouable dans les playlists sélectionnées.');
      game = {
        tracks: data.tracks, index: -1, score: 0, results: [],
        oral: settings.oral, duration: settings.duration,
      };
      if (data.tracks.length < settings.rounds) {
        console.info(`Seulement ${data.tracks.length} titre(s) disponible(s).`);
      }
      $('answer-zone').hidden = game.oral;
      $('score-label').hidden = game.oral;
      show('game');
      nextRound();
    } catch (e) {
      showError($('start-error'), e.message);
    } finally {
      $('start-btn').textContent = 'Lancer la partie';
      renderPlaylists();
    }
  }

  function nextRound() {
    stopTimer();
    if (round) game.results.push(round);
    game.index++;
    if (game.index >= game.tracks.length) return endGame();

    const track = game.tracks[game.index];
    round = { track, foundTitle: false, foundArtist: false, revealed: false };

    $('round-label').textContent = `Manche ${game.index + 1} / ${game.tracks.length}`;
    $('score-label').textContent = `Score : ${game.score}`;
    $('found-title').textContent = 'Titre : ?';
    $('found-artist').textContent = 'Artiste : ?';
    $('found-title').classList.remove('ok');
    $('found-artist').classList.remove('ok');
    $('answer-feedback').textContent = '';
    $('answer-input').value = '';
    $('answer-input').disabled = false;
    $('reveal').hidden = true;
    $('next-btn').hidden = true;
    $('skip-btn').hidden = false;
    $('replay-btn').disabled = false;
    setTimerDisplay(1, game.duration);
    $('audio-status').textContent = "Chargement de l'extrait…";

    audio.pause();
    audio.removeAttribute('src');
    const current = round;
    deezer.getPreview(track.id).then((url) => {
      if (round !== current || current.revealed) return; // manche déjà terminée entre-temps
      audio.src = url;
      audio.play().catch(() => {
        $('audio-status').textContent = 'Clique sur « Rejouer l\'extrait » pour lancer le son.';
      });
    }).catch((e) => {
      if (round !== current) return;
      $('audio-status').textContent = `${e.message}. Clique sur « Révéler » pour passer.`;
    });
    if (!game.oral) $('answer-input').focus();
  }

  // Le chrono démarre quand le son démarre vraiment (le temps de chargement ne compte pas)
  audio.addEventListener('playing', () => {
    $('audio-status').textContent = '';
    if (game && round && !round.revealed && !timer) startTimer();
  });
  audio.addEventListener('error', () => {
    if (!round || round.revealed) return;
    $('audio-status').textContent = 'Extrait indisponible pour ce titre. Clique sur « Révéler » pour passer.';
  });

  function startTimer() {
    const start = performance.now();
    timer = { start, raf: 0 };
    const tick = () => {
      const elapsed = (performance.now() - start) / 1000;
      const left = Math.max(game.duration - elapsed, 0);
      setTimerDisplay(left / game.duration, Math.ceil(left));
      if (left <= 0) return reveal();
      timer.raf = requestAnimationFrame(tick);
    };
    timer.raf = requestAnimationFrame(tick);
  }

  function stopTimer() {
    if (timer) cancelAnimationFrame(timer.raf);
    timer = null;
  }

  function setTimerDisplay(ratio, seconds) {
    $('timer-bar').style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
    $('timer-label').textContent = `${seconds} s`;
  }

  function reveal() {
    if (!round || round.revealed) return;
    round.revealed = true;
    stopTimer();
    setTimerDisplay(0, 0);
    const t = round.track;
    $('reveal-cover').src = t.cover || '';
    $('reveal-cover').hidden = !t.cover;
    $('reveal-title').textContent = t.title;
    $('reveal-artist').textContent = t.artist;
    $('reveal-source').textContent = `Playlist : ${t.source}`;
    $('reveal').hidden = false;
    $('answer-input').disabled = true;
    $('skip-btn').hidden = true;
    $('next-btn').hidden = false;
    $('audio-status').textContent = '';
    $('next-btn').focus();
  }

  $('answer-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!round || round.revealed) return;
    const input = $('answer-input');
    const guess = input.value;
    if (!guess.trim()) return;

    const msgs = [];
    if (!round.foundTitle && Match.isMatch(guess, round.track.title)) {
      round.foundTitle = true;
      game.score++;
      $('found-title').textContent = `Titre : ${round.track.title}`;
      $('found-title').classList.add('ok');
      msgs.push('Bon titre ! +1');
    }
    if (!round.foundArtist && Match.isMatch(guess, round.track.artist)) {
      round.foundArtist = true;
      game.score++;
      $('found-artist').textContent = `Artiste : ${round.track.artist}`;
      $('found-artist').classList.add('ok');
      msgs.push('Bon artiste ! +1');
    }
    $('answer-feedback').textContent = msgs.length ? msgs.join(' ') : 'Raté…';
    $('answer-feedback').className = `feedback ${msgs.length ? 'good' : 'bad'}`;
    $('score-label').textContent = `Score : ${game.score}`;
    input.value = '';
    if (round.foundTitle && round.foundArtist) reveal();
  });

  $('replay-btn').addEventListener('click', () => {
    audio.currentTime = 0;
    audio.play().catch(() => {});
  });
  $('skip-btn').addEventListener('click', reveal);
  $('next-btn').addEventListener('click', nextRound);
  $('quit-btn').addEventListener('click', () => {
    if (confirmQuit()) endGame();
  });

  function confirmQuit() {
    // Pas de boîte de dialogue bloquante : un second clic dans les 3 s confirme
    const btn = $('quit-btn');
    if (btn.dataset.armed) return true;
    btn.dataset.armed = '1';
    btn.textContent = 'Cliquer encore pour confirmer';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Arrêter la partie'; }, 3000);
    return false;
  }

  function endGame() {
    stopTimer();
    audio.pause();
    if (round && !game.results.includes(round) && (round.revealed || round.foundTitle || round.foundArtist)) {
      game.results.push(round);
    }
    round = null;
    const max = game.results.length * 2;
    $('final-score').textContent = game.oral
      ? `${game.results.length} titre(s) joué(s)`
      : `${game.score} point(s) sur ${max}`;

    const ol = $('recap');
    ol.innerHTML = '';
    for (const r of game.results) {
      const li = document.createElement('li');
      const main = document.createElement('span');
      main.textContent = `${r.track.title} — ${r.track.artist}`;
      li.appendChild(main);
      if (!game.oral) {
        const marks = document.createElement('small');
        marks.textContent = ` (titre ${r.foundTitle ? '✓' : '✗'}, artiste ${r.foundArtist ? '✓' : '✗'})`;
        li.appendChild(marks);
      }
      const src = document.createElement('small');
      src.className = 'hint';
      src.textContent = ` · ${r.track.source}`;
      li.appendChild(src);
      ol.appendChild(li);
    }
    show('end');
  }

  $('start-btn').addEventListener('click', startGame);
  $('again-btn').addEventListener('click', () => { round = null; startGame(); });
  $('back-btn').addEventListener('click', () => { round = null; show('setup'); });

  // ---------- Démarrage ----------

  // Éléments partagés avec le mode multijoueur (multi.js)
  window.Pinka = {
    deezer, show, showError, readSettings, settings, audio,
    selectedPlaylists: () => playlists.filter((p) => p.selected && !p.error),
    stopSolo: () => { stopTimer(); round = null; },
  };

  (async function init() {
    await loadPresets();
    renderPlaylists();
    // Met à jour les infos (nombre de titres, image) des playlists enregistrées
    playlists.forEach(refreshPlaylist);
  })();
})();
