// Coin Rush - a small HTML5 canvas game. No libraries needed.
(() => {
  'use strict';

  // =====================================================================
  //  SETTINGS - everything you may want to tweak is in this section
  // =====================================================================
  const CONFIG = {
    gameSeconds: 60,        // length of one round
    startLives: 3,
    coinPoints: 10,         // points per coin
    enemyKillPoints: 0,     // points for destroying an enemy with a blast (0 = enemies give no points, as before)
    playerSpeed: 280,       // arena units per second
    playerRadius: 16,
    playerAccel: 14,        // higher = snappier movement
    invincibleSeconds: 1.5, // safe time after being hit
    respawnDelay: 4,        // seconds before a blasted enemy is replaced
    powerupGap: 3,          // minimum seconds between two power-up spawns
    warnSeconds: 10,        // main timer warning (ticks + pulse) starts here

    // Stopwatch power-up
    timerPU: {
      lifetime: 5,          // seconds on screen if not collected
      blinkFrom: 2,         // starts blinking + ticking after this many seconds (= last 3 seconds)
      bonus: 5,             // seconds added to the round timer
      firstDelay: [7, 11],  // seconds until the first possible spawn
      interval: [10, 18],   // seconds between spawn attempts
      chance: 0.75,         // probability that an attempt spawns one
      minPlayerDist: 140, maxPlayerDist: 900, radius: 17
    },
    // Bomb power-up
    bomb: {
      lifetime: 12,         // seconds on screen if not collected (0 = stays until collected)
      firstDelay: [12, 18], interval: [14, 24], chance: 0.65,
      minPlayerDist: 140, maxPlayerDist: 900, radius: 16,
      blastRadius: 170,     // how far the blast reaches
      blastDuration: 0.65   // length of the blast animation in seconds
    }
  };

  // Stages. Only Stage 1 is playable today. To add a stage later: fill in a new entry
  // (colours, spawn settings, difficulty and a drawBackground function) and set available: true.
  const STAGES = [
    {
      id: 1, name: 'STAGE 1', available: true,
      theme: { skyTop: '#120d26', skyBottom: '#1f1745', floorTop: '#2f2560', floorBottom: '#231b4a',
               line: 'rgba(120,100,210,0.16)', gold: '#ffc928', skyline: '#1c1540', accent: '#8f7dff' },
      difficulty: { startObstacles: 3, maxObstacles: 7, obstacleEvery: 15, speedMin: 90, speedMax: 150 },
      spawn: { maxCoins: 4, timerPU: {}, bomb: {} },   // per-stage overrides of CONFIG.timerPU / CONFIG.bomb
      drawBackground: drawStage1Background
    },
    { id: 2, name: 'STAGE 2', available: false },
    { id: 3, name: 'STAGE 3', available: false }
  ];

  // =====================================================================
  //  Page elements
  // =====================================================================
  const $ = (id) => document.getElementById(id);
  const gameEl = $('game'), canvas = $('canvas'), ctx = canvas.getContext('2d');
  const hudEl = $('hud'), scoreEl = $('score'), timeEl = $('time'), timeBox = $('timeBox'), livesEl = $('lives');
  const bombPill = $('bombPill'), bombCount = $('bombCount'), stageTag = $('stageTag');
  const startScreen = $('start'), overScreen = $('over'), pauseScreen = $('pauseScreen');
  const soundBtn = $('soundBtn'), pauseBtn = $('pauseBtn'), blastBtn = $('blastBtn'), barHint = $('barHint'), safeProbe = $('safe');
  const bg = document.createElement('canvas'), bgCtx = bg.getContext('2d'); // cached stage background

  // =====================================================================
  //  Game state
  // =====================================================================
  const TOP = 60;                       // HUD height in arena units
  let W = 800, H = 600, S = 1, B = { x0: 0, y0: TOP, x1: 800, y1: 560 }; // arena size, scale, playable bounds
  let touchMode = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches), portrait = false, barPx = 44;
  let state = 'menu';                   // 'menu' | 'playing' | 'paused' | 'over'
  let stage = STAGES[0], timerCfg = CONFIG.timerPU, bombCfg = CONFIG.bomb;
  let score = 0, lives = 3, timeLeft = 60, elapsed = 0, invincible = 0, shake = 0, flash = 0, warnFlash = 0, clock = 0;
  let player = null, coins = [], obstacles = [], respawns = [], particles = [], rings = [], texts = [];
  let timerPU = null, bombPU = null, bombCharges = 0, blast = null;
  let timerNext = 0, bombNext = 0, puCooldown = 0, lastTickSec = Infinity;
  const keys = {};
  const joy = { active: false, id: null, ox: 0, oy: 0, x: 0, y: 0, px: 0, py: 0 };
  const MAXP = 350;                     // particle limit (performance)

  const rand = (a, b) => a + Math.random() * (b - a);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const merge = (a, b) => Object.assign({}, a, b || {});
  function setState(s) { state = s; gameEl.dataset.state = s; }

  // =====================================================================
  //  Sizing: the arena fills the whole window (no stretching: one uniform scale)
  // =====================================================================
  function fit() {
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!vw || !vh) return;
    portrait = vh > vw;
    S = clamp(Math.min(vw, vh) / 560, 0.7, 2.2);   // CSS pixels per arena unit
    W = vw / S; H = vh / S;
    gameEl.style.setProperty('--u', S.toFixed(3));
    gameEl.classList.toggle('touch', touchMode);
    gameEl.classList.toggle('portrait', portrait);
    barPx = !touchMode ? 44 : portrait ? clamp(Math.round(vh * 0.18), 120, 170) : 64;
    gameEl.style.setProperty('--bar', barPx + 'px');
    barHint.textContent = touchMode ? 'Drag anywhere to move' : 'WASD / arrows to move \u00B7 SPACE to blast';

    const cs = getComputedStyle(safeProbe);       // phone notches / rounded corners
    const ins = { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0,
                  b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
    B = { x0: ins.l / S, y0: ins.t / S + TOP, x1: W - ins.r / S, y1: H - (ins.b + barPx) / S };

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = bg.width = Math.round(vw * dpr);
    canvas.height = bg.height = Math.round(vh * dpr);
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    bgCtx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    stage.drawBackground(bgCtx, W, H, B, stage.theme);
    clampEntities();
  }
  // Keep everything inside the arena after a resize / rotation (the round is NOT reset)
  function clampEntities() {
    const keep = (o, m) => { o.x = clamp(o.x, B.x0 + m, Math.max(B.x0 + m, B.x1 - m)); o.y = clamp(o.y, B.y0 + m, Math.max(B.y0 + m, B.y1 - m)); };
    if (player) keep(player, player.r);
    coins.forEach((c) => keep(c, c.r));
    obstacles.forEach((o) => keep(o, o.r));
    if (timerPU) keep(timerPU, timerPU.r);
    if (bombPU) keep(bombPU, bombPU.r);
  }
  let resizeQueued = false;
  function queueFit() { if (resizeQueued) return; resizeQueued = true; requestAnimationFrame(() => { resizeQueued = false; fit(); }); }
  window.addEventListener('resize', queueFit);
  window.addEventListener('orientationchange', () => setTimeout(queueFit, 120));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', queueFit);

  // =====================================================================
  //  Sound (made with the browser, no sound files)
  //  soundOn is the ONE switch. The label and a master volume are set from it together.
  // =====================================================================
  let soundOn = true, audio = null, master = null, noiseBuf = null;
  const voices = new Set();             // every sound that is currently playing, so we can stop them
  const lastPlay = {};
  const MIN_GAP = { coin: 50, tickMain: 150, puTick: 150, destroy: 60, hit: 150 }; // ms; stops identical sounds stacking up

  function ensureAudio() {
    if (!audio) {
      try {
        audio = new (window.AudioContext || window.webkitAudioContext)();
        const comp = audio.createDynamicsCompressor();      // prevents clipping when sounds overlap
        master = audio.createGain();
        master.connect(comp); comp.connect(audio.destination);
      } catch (e) { audio = null; return false; }
    }
    if (audio.state !== 'running') { try { audio.resume(); } catch (e) {} }
    master.gain.value = soundOn ? 1 : 0;
    return true;
  }
  function updateSoundButton() {
    soundBtn.textContent = 'Sound: ' + (soundOn ? 'On' : 'Off');
    soundBtn.setAttribute('aria-pressed', String(soundOn));
  }
  function track(src, g) {
    const v = { o: src, g };
    voices.add(v);
    src.onended = () => { voices.delete(v); try { g.disconnect(); } catch (e) {} };
  }
  function tone(freq, dur, type, vol, slideTo, delay) {
    if (!soundOn || voices.size > 18 || !ensureAudio()) return;
    try {
      const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + (delay || 0);
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol || 0.1, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + dur + 0.02);
      track(o, g);
    } catch (e) { /* sound is optional */ }
  }
  function noise(dur, vol, cutoff) {
    if (!soundOn || voices.size > 18 || !ensureAudio()) return;
    try {
      if (!noiseBuf) {
        noiseBuf = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      const s = audio.createBufferSource(), f = audio.createBiquadFilter(), g = audio.createGain(), t = audio.currentTime;
      s.buffer = noiseBuf; f.type = 'lowpass'; f.frequency.setValueAtTime(cutoff, t);
      f.frequency.exponentialRampToValueAtTime(120, t + dur);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      s.connect(f); f.connect(g); g.connect(master);
      s.start(t); s.stop(t + dur + 0.02);
      track(s, g);
    } catch (e) {}
  }
  // Every game sound goes through here. Called by game EVENTS only (never once per frame).
  function sfx(name, a) {
    const now = performance.now();
    if (MIN_GAP[name] && lastPlay[name] && now - lastPlay[name] < MIN_GAP[name]) return;
    lastPlay[name] = now;
    switch (name) {
      case 'start':        tone(520, 0.15, 'triangle', 0.1, 880); break;
      case 'over':         tone(400, 0.5, 'sawtooth', 0.1, 120); break;
      case 'coin':         tone(880, 0.12, 'triangle', 0.1, 1320); break;
      case 'hit':          tone(220, 0.3, 'square', 0.1, 70); break;
      case 'tickMain': {   // a = whole seconds left (10..1): pitch rises, last 3 are louder
        tone(620 + (10 - a) * 45, 0.07, 'square', a <= 3 ? 0.13 : 0.08); break; }
      case 'puTick':       // a = 0,1,2 : three distinct soft pings
        tone([1250, 1500, 1800][a] || 1500, 0.09, 'sine', 0.14); break;
      case 'timerCollect': tone(660, 0.12, 'triangle', 0.1); tone(880, 0.12, 'triangle', 0.1, 0, 0.07); tone(1320, 0.22, 'triangle', 0.1, 0, 0.14); break;
      case 'bombCollect':  tone(180, 0.25, 'sawtooth', 0.07, 520); tone(520, 0.18, 'triangle', 0.09, 780, 0.14); break;
      case 'blast':        noise(0.5, 0.3, 1400); tone(150, 0.55, 'sine', 0.28, 38); break;
      case 'destroy':      tone(520, 0.1, 'square', 0.06, 150); break;
      case 'blip':         tone(660, 0.1, 'triangle', 0.1, 990); break;
    }
  }
  function stopAllSounds() {            // stop everything that is playing or queued, right now
    voices.forEach((v) => { try { v.o.onended = null; v.o.stop(); } catch (e) {} try { v.g.disconnect(); } catch (e) {} });
    voices.clear();
  }
  soundBtn.addEventListener('click', () => {
    soundOn = !soundOn;
    updateSoundButton();
    ensureAudio();                       // wakes the audio engine and sets the volume
    if (!soundOn) stopAllSounds();
    if (soundOn) sfx('blip');
    soundBtn.blur();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (state === 'playing') pauseGame(); }
    else if (audio && soundOn) ensureAudio();
  });
  // iPhones can switch the audio engine to "interrupted". Browsers only allow waking it from a real
  // tap, click or key press, so we also do it on those events.
  ['pointerup', 'touchend', 'keydown'].forEach((type) =>
    window.addEventListener(type, () => { if (audio && soundOn && audio.state !== 'running') ensureAudio(); }, { passive: true }));

  // =====================================================================
  //  Starting, pausing and ending a round
  // =====================================================================
  function resetRound() {
    stopAllSounds();
    timerCfg = merge(CONFIG.timerPU, stage.spawn.timerPU);
    bombCfg = merge(CONFIG.bomb, stage.spawn.bomb);
    score = 0; lives = CONFIG.startLives; timeLeft = CONFIG.gameSeconds;
    elapsed = 0; invincible = 0; shake = 0; flash = 0; warnFlash = 0;
    lastTickSec = Infinity; bombCharges = 0; blast = null; timerPU = null; bombPU = null;
    coins = []; obstacles = []; respawns = []; particles = []; rings = []; texts = [];
    puCooldown = 0;
    timerNext = rand(timerCfg.firstDelay[0], timerCfg.firstDelay[1]);
    bombNext = rand(bombCfg.firstDelay[0], bombCfg.firstDelay[1]);
    player = { x: (B.x0 + B.x1) / 2, y: (B.y0 + B.y1) / 2, r: CONFIG.playerRadius, vx: 0, vy: 0, face: 0 };
    for (let i = 0; i < stage.difficulty.startObstacles; i++) spawnObstacle(true);
    while (coins.length < stage.spawn.maxCoins) spawnCoin();
    joy.active = false; joy.x = joy.y = 0;
    timeBox.classList.remove('beat'); timeBox.dataset.u = '0';
    stageTag.textContent = stage.name;
  }
  function startGame() {
    ensureAudio();
    fit();
    resetRound();
    startScreen.classList.add('hidden'); overScreen.classList.add('hidden'); pauseScreen.classList.add('hidden');
    hud.classList.remove('hidden');
    setState('playing');
    updateHud(true);
    sfx('start');
  }
  function pauseGame() {
    if (state !== 'playing') return;
    setState('paused');
    stopAllSounds();
    for (const k in keys) keys[k] = false;
    joy.active = false; joy.x = joy.y = 0;
    pauseScreen.classList.remove('hidden');
    $('resumeBtn').focus();
  }
  function resumeGame() {
    if (state !== 'paused') return;
    pauseScreen.classList.add('hidden');
    setState('playing');
    last = performance.now();
    pauseBtn.blur();
  }
  function endGame(reason) {
    if (state !== 'playing') return;     // the round can only end once
    setState('over');
    stopAllSounds();
    timerPU = null; bombPU = null; blast = null; bombCharges = 0;
    for (const k in keys) keys[k] = false;
    joy.active = false; joy.x = joy.y = 0;
    hud.classList.add('hidden');
    blastBtn.classList.add('hidden');
    let best = 0;
    try { best = Number(localStorage.getItem('coinRushBest')) || 0; } catch (e) {}
    const isNew = score > best;
    if (isNew) { best = score; try { localStorage.setItem('coinRushBest', String(best)); } catch (e) {} }
    $('reason').textContent = reason;
    $('finalScore').textContent = score;
    $('best').textContent = isNew && score > 0 ? 'New best score!' : 'Best: ' + best;
    overScreen.classList.remove('hidden');
    $('restartBtn').focus();
    sfx('over');
  }
  const hud = hudEl;

  // =====================================================================
  //  Spawning
  // =====================================================================
  function findSpot(minP, maxP, margin) {
    const m = Math.max(margin, 24);
    for (let i = 0; i < 80; i++) {
      const q = { x: rand(B.x0 + m, Math.max(B.x0 + m + 1, B.x1 - m)), y: rand(B.y0 + m, Math.max(B.y0 + m + 1, B.y1 - m)) };
      const dp = dist(q, player);
      if (dp < minP || dp > maxP) continue;
      if (obstacles.some((o) => dist(q, o) < 70) || coins.some((c) => dist(q, c) < 40)) continue;
      if ((timerPU && dist(q, timerPU) < 70) || (bombPU && dist(q, bombPU) < 70)) continue;
      return q;
    }
    return null;
  }
  function spawnCoin() {
    const q = findSpot(90, 99999, 40) || { x: rand(B.x0 + 40, B.x1 - 40), y: rand(B.y0 + 40, B.y1 - 40) };
    coins.push({ x: q.x, y: q.y, r: 13, phase: rand(0, 6) });
  }
  function spawnObstacle() {
    const o = { x: 0, y: 0, r: 18, age: 0, rot: 0 };
    for (let i = 0; i < 40; i++) {
      o.x = rand(B.x0 + 40, B.x1 - 40); o.y = rand(B.y0 + 40, B.y1 - 40);
      if (dist(o, player) > 220) break;
    }
    const d = stage.difficulty, a = rand(0, Math.PI * 2), sp = rand(d.speedMin, d.speedMax);
    o.vx = Math.cos(a) * sp; o.vy = Math.sin(a) * sp;
    obstacles.push(o);
  }
  function spawnTimerPU() {
    const q = findSpot(timerCfg.minPlayerDist, timerCfg.maxPlayerDist, 36);
    if (!q) return false;
    timerPU = { x: q.x, y: q.y, r: timerCfg.radius, age: 0, ticked: [false, false, false] };
    return true;
  }
  function spawnBomb() {
    const q = findSpot(bombCfg.minPlayerDist, bombCfg.maxPlayerDist, 36);
    if (!q) return false;
    bombPU = { x: q.x, y: q.y, r: bombCfg.radius, age: 0 };
    return true;
  }

  // ---- effects helpers ----
  function burst(x, y, color, n, speed, life, size) {
    for (let i = 0; i < n && particles.length < MAXP; i++) {
      const a = rand(0, 6.283), s = rand((speed || 200) * 0.3, speed || 200);
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: life || 0.5, max: life || 0.5, color, size: size || 3 });
    }
  }
  function ring(x, y, r, dur, color, w) { rings.push({ x, y, r, t: 0, dur, color, w: w || 3 }); }
  function floatText(x, y, text, color, size, life) {
    texts.push({ x: clamp(x, B.x0 + 70, B.x1 - 70), y, text, color, size: size || 20, life: life || 0.8, max: life || 0.8 });
  }

  // =====================================================================
  //  Blast (one-use bomb ability)
  // =====================================================================
  function useBlast() {
    if (state !== 'playing' || bombCharges <= 0) return;   // no charge = no blast
    bombCharges = 0;                                       // consume the charge first: one blast per bomb
    const R = bombCfg.blastRadius;
    blast = { x: player.x, y: player.y, t: 0, dur: bombCfg.blastDuration, r: R };
    flash = 1;
    let killed = 0;
    // A destroyed enemy is removed from the list immediately, so it can never be counted twice.
    for (let i = obstacles.length - 1; i >= 0; i--) {
      const o = obstacles[i];
      if (dist(o, player) <= R) {
        obstacles.splice(i, 1); killed++;
        respawns.push(CONFIG.respawnDelay);
        burst(o.x, o.y, '#ff5a4e', 14, 260, 0.6, 3.5);
        burst(o.x, o.y, '#ffd08a', 6, 160, 0.45, 2.5);
        ring(o.x, o.y, 34, 0.35, '#ff9f43', 3);
        if (CONFIG.enemyKillPoints) { score += CONFIG.enemyKillPoints; floatText(o.x, o.y - 20, '+' + CONFIG.enemyKillPoints, '#fff4d6', 18, 0.7); }
        sfx('destroy');
      }
    }
    burst(player.x, player.y, '#ffb15c', 26, 340, 0.55, 3);
    shake = Math.max(shake, 0.18);
    sfx('blast');
    if (!killed) floatText(player.x, player.y - 34, 'BLAST!', '#ffb15c', 20, 0.7);
    updateHud(true);
  }
  blastBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); blastBtn.classList.add('pressed'); useBlast(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => blastBtn.addEventListener(t, () => blastBtn.classList.remove('pressed')));

  // =====================================================================
  //  Update (runs once per frame while playing; dt = seconds of game time)
  // =====================================================================
  function update(dt) {
    elapsed += dt;
    timeLeft -= dt;
    if (timeLeft <= 0) { timeLeft = 0; endGame("Time's up!"); return; }   // checked first: no bonus can extend a finished round
    if (invincible > 0) invincible -= dt;
    if (shake > 0) shake -= dt;
    if (flash > 0) flash = Math.max(0, flash - dt / 0.18);
    if (warnFlash > 0) warnFlash = Math.max(0, warnFlash - dt / 0.5);

    // --- main timer warning: one tick each time the whole-second value changes (final 10 seconds) ---
    const whole = Math.ceil(timeLeft);
    if (whole > lastTickSec) lastTickSec = whole;           // time was added (bonus): the ticks start again from here
    if (whole <= CONFIG.warnSeconds && whole < lastTickSec) {
      lastTickSec = whole;
      sfx('tickMain', whole);
      timeBox.classList.remove('beat'); void timeBox.offsetWidth; timeBox.classList.add('beat');
      warnFlash = 1;
    }

    // --- spawning ---
    const d = stage.difficulty;
    const want = Math.min(d.maxObstacles, d.startObstacles + Math.floor(elapsed / d.obstacleEvery));
    while (obstacles.length + respawns.length < want) spawnObstacle();
    for (let i = respawns.length - 1; i >= 0; i--) { respawns[i] -= dt; if (respawns[i] <= 0) { respawns.splice(i, 1); spawnObstacle(); } }
    puCooldown = Math.max(0, puCooldown - dt);
    timerNext -= dt;
    if (timerNext <= 0) {
      if (timerPU) timerNext = rand(timerCfg.interval[0], timerCfg.interval[1]);
      else if (puCooldown > 0) timerNext = puCooldown + 0.1;
      else { if (Math.random() < timerCfg.chance && spawnTimerPU()) puCooldown = CONFIG.powerupGap; timerNext = rand(timerCfg.interval[0], timerCfg.interval[1]); }
    }
    bombNext -= dt;
    if (bombNext <= 0) {
      if (bombPU || bombCharges > 0) bombNext = rand(bombCfg.interval[0], bombCfg.interval[1]);   // never more than one bomb
      else if (puCooldown > 0) bombNext = puCooldown + 0.1;
      else { if (Math.random() < bombCfg.chance && spawnBomb()) puCooldown = CONFIG.powerupGap; bombNext = rand(bombCfg.interval[0], bombCfg.interval[1]); }
    }

    // --- player movement (keyboard + touch), smoothed ---
    let dx = 0, dy = 0;
    if (keys.ArrowLeft || keys.KeyA) dx -= 1;
    if (keys.ArrowRight || keys.KeyD) dx += 1;
    if (keys.ArrowUp || keys.KeyW) dy -= 1;
    if (keys.ArrowDown || keys.KeyS) dy += 1;
    if (joy.active) { dx += joy.x; dy += joy.y; }
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    const k = 1 - Math.exp(-CONFIG.playerAccel * dt);
    player.vx += (dx * CONFIG.playerSpeed - player.vx) * k;
    player.vy += (dy * CONFIG.playerSpeed - player.vy) * k;
    player.x = clamp(player.x + player.vx * dt, B.x0 + player.r, B.x1 - player.r);
    player.y = clamp(player.y + player.vy * dt, B.y0 + player.r, B.y1 - player.r);
    if (len > 0.05) player.face = Math.atan2(dy, dx);

    // --- obstacles roam and bounce off the walls ---
    for (const o of obstacles) {
      o.age += dt; o.rot += dt * 2;
      o.x += o.vx * dt; o.y += o.vy * dt;
      if (o.x < B.x0 + o.r) { o.x = B.x0 + o.r; o.vx = Math.abs(o.vx); }
      if (o.x > B.x1 - o.r) { o.x = B.x1 - o.r; o.vx = -Math.abs(o.vx); }
      if (o.y < B.y0 + o.r) { o.y = B.y0 + o.r; o.vy = Math.abs(o.vy); }
      if (o.y > B.y1 - o.r) { o.y = B.y1 - o.r; o.vy = -Math.abs(o.vy); }
      if (o.age > 1 && invincible <= 0 && dist(o, player) < o.r + player.r - 4) {   // new enemies are harmless for 1 second
        lives--; invincible = CONFIG.invincibleSeconds; shake = 0.3;
        burst(player.x, player.y, '#ff5a4e', 14, 220);
        sfx('hit');
        if (lives <= 0) { updateHud(true); endGame('You ran out of lives.'); return; }
      }
    }

    // --- coins ---
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i];
      if (dist(c, player) < c.r + player.r) {
        score += CONFIG.coinPoints;
        burst(c.x, c.y, '#ffc928', 12, 220);
        ring(c.x, c.y, 26, 0.3, '#ffe680', 2);
        floatText(c.x, c.y - 12, '+' + CONFIG.coinPoints, '#fff4d6', 20, 0.7);
        coins.splice(i, 1);
        sfx('coin');
      }
    }
    while (coins.length < stage.spawn.maxCoins) spawnCoin();

    // --- stopwatch power-up: 5 s of game time, blinks + ticks during the last 3 s ---
    if (timerPU) {
      const p = timerPU; p.age += dt;
      if (p.age >= timerCfg.lifetime) timerPU = null;                      // expired: gone immediately
      else {
        let fire = -1;
        for (let i = 0; i < 3; i++) {                                      // tick at 2 s, 3 s and 4 s of its life
          if (!p.ticked[i] && p.age >= timerCfg.lifetime - 3 + i) { p.ticked[i] = true; fire = i; }
        }
        if (fire >= 0) sfx('puTick', fire);
        if (dist(p, player) < p.r + player.r) {
          timerPU = null;                                                  // removed first, so the reward can only be given once
          timeLeft += timerCfg.bonus;
          sfx('timerCollect');
          burst(p.x, p.y, '#4cc9ff', 18, 260, 0.6);
          ring(p.x, p.y, 40, 0.5, '#4cc9ff', 4); ring(player.x, player.y, 34, 0.45, '#bdeeff', 3);
          floatText(player.x, player.y - 34, '+' + timerCfg.bonus + ' SECONDS', '#7fdcff', 26, 1.1);
          puCooldown = Math.max(puCooldown, 1);
        }
      }
    }

    // --- bomb power-up: gives exactly one charge ---
    if (bombPU) {
      const b = bombPU; b.age += dt;
      if (bombCfg.lifetime > 0 && b.age >= bombCfg.lifetime) bombPU = null;
      else if (dist(b, player) < b.r + player.r) {
        bombPU = null;
        bombCharges = 1;
        sfx('bombCollect');
        burst(b.x, b.y, '#ff9f43', 16, 240, 0.6);
        ring(b.x, b.y, 38, 0.45, '#ff9f43', 4);
        floatText(player.x, player.y - 34, touchMode ? 'BOMB READY!' : 'BOMB READY! SPACE', '#ffb15c', 22, 1.1);
        puCooldown = Math.max(puCooldown, 1);
      }
    }

    if (blast) { blast.t += dt; if (blast.t >= blast.dur) blast = null; }

    // --- particles, rings and floating text ---
    for (let i = particles.length - 1; i >= 0; i--) {
      const e = particles[i]; e.vx *= 1 - 3 * dt; e.vy *= 1 - 3 * dt;
      e.x += e.vx * dt; e.y += e.vy * dt; e.life -= dt;
      if (e.life <= 0) particles.splice(i, 1);
    }
    for (let i = rings.length - 1; i >= 0; i--) { rings[i].t += dt; if (rings[i].t >= rings[i].dur) rings.splice(i, 1); }
    for (let i = texts.length - 1; i >= 0; i--) { const e = texts[i]; e.y -= 40 * dt; e.life -= dt; if (e.life <= 0) texts.splice(i, 1); }
  }

  // =====================================================================
  //  Drawing
  // =====================================================================
  function rr(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // Stage 1 background: drawn once per resize into a cached canvas (cheap to display every frame).
  function drawStage1Background(c, W, H, B, th) {
    const rnd = mulberry32(1337);
    let g = c.createLinearGradient(0, 0, 0, H);                         // layer 1: night sky
    g.addColorStop(0, th.skyTop); g.addColorStop(1, th.skyBottom);
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    c.fillStyle = '#fff4d6';                                             // layer 2: stars
    for (let i = 0; i < 70; i++) { c.globalAlpha = 0.2 + rnd() * 0.5; c.beginPath(); c.arc(rnd() * W, rnd() * H, 0.4 + rnd() * 1.2, 0, 6.283); c.fill(); }
    c.globalAlpha = 1;
    const mx = W * 0.68, my = Math.max(14, B.y0 * 0.5);                  // moon
    g = c.createRadialGradient(mx, my, 4, mx, my, 38);
    g.addColorStop(0, 'rgba(255,241,201,0.35)'); g.addColorStop(1, 'rgba(255,241,201,0)');
    c.fillStyle = g; c.fillRect(mx - 40, my - 40, 80, 80);
    c.fillStyle = 'rgba(255,241,201,0.8)'; c.beginPath(); c.arc(mx, my, 10, 0, 6.283); c.fill();
    c.fillStyle = th.skyline;                                            // layer 3: distant skyline behind the arena edge
    for (let x = B.x0 - 10; x < B.x1; ) {
      const w = 18 + rnd() * 34, h = 8 + rnd() * 26;
      c.fillRect(x, B.y0 - h, w, h + 6);
      if (rnd() > 0.6) { c.beginPath(); c.moveTo(x, B.y0 - h); c.lineTo(x + w / 2, B.y0 - h - 10); c.lineTo(x + w, B.y0 - h); c.fill(); }
      x += w + 3 + rnd() * 10;
    }
    const aw = B.x1 - B.x0, ah = B.y1 - B.y0;                            // layer 4: the arena floor
    g = c.createLinearGradient(0, B.y0, 0, B.y1);
    g.addColorStop(0, th.floorTop); g.addColorStop(1, th.floorBottom);
    c.save(); rr(c, B.x0, B.y0, aw, ah, 14); c.fillStyle = g; c.fill(); c.clip();
    c.fillStyle = 'rgba(255,255,255,0.028)';                             // checker tiles
    for (let y = 0, j = 0; y < ah; y += 56, j++) for (let x = 0, i = 0; x < aw; x += 56, i++) if ((i + j) % 2) c.fillRect(B.x0 + x, B.y0 + y, 56, 56);
    c.strokeStyle = th.line; c.lineWidth = 1; c.beginPath();             // grid
    for (let x = 0; x <= aw; x += 56) { c.moveTo(B.x0 + x, B.y0); c.lineTo(B.x0 + x, B.y1); }
    for (let y = 0; y <= ah; y += 56) { c.moveTo(B.x0, B.y0 + y); c.lineTo(B.x1, B.y0 + y); }
    c.stroke();
    const n = Math.round(aw * ah / 9000);                                // scattered pebbles and tiny flowers
    for (let i = 0; i < n; i++) {
      const x = B.x0 + rnd() * aw, y = B.y0 + rnd() * ah, kind = rnd();
      if (kind < 0.6) { c.fillStyle = 'rgba(10,5,30,0.22)'; c.beginPath(); c.ellipse(x, y, 3 + rnd() * 3, 2 + rnd() * 2, 0, 0, 6.283); c.fill(); }
      else { c.fillStyle = th.accent; c.globalAlpha = 0.35; for (let p = 0; p < 4; p++) { c.beginPath(); c.arc(x + Math.cos(p * 1.57) * 2.6, y + Math.sin(p * 1.57) * 2.6, 1.4, 0, 6.283); c.fill(); } c.globalAlpha = 1; }
    }
    const cx = (B.x0 + B.x1) / 2, cy = (B.y0 + B.y1) / 2;                // faint centre emblem
    c.strokeStyle = 'rgba(255,201,40,0.07)'; c.lineWidth = 6; c.beginPath(); c.arc(cx, cy, 110, 0, 6.283); c.stroke();
    c.lineWidth = 2; c.beginPath(); c.arc(cx, cy, 82, 0, 6.283); c.stroke();
    for (let i = 0; i < 12; i++) { const a = i * 0.5236; c.beginPath(); c.moveTo(cx + Math.cos(a) * 92, cy + Math.sin(a) * 92); c.lineTo(cx + Math.cos(a) * 104, cy + Math.sin(a) * 104); c.stroke(); }
    c.strokeStyle = 'rgba(255,201,40,0.22)'; c.lineWidth = 2;            // corner ornaments
    [[B.x0, B.y0, 0], [B.x1, B.y0, 1.5708], [B.x1, B.y1, 3.1416], [B.x0, B.y1, 4.7124]].forEach(([x, y, a]) => {
      c.beginPath(); c.arc(x, y, 46, a, a + 1.5708); c.stroke(); c.beginPath(); c.arc(x, y, 34, a, a + 1.5708); c.stroke(); });
    g = c.createRadialGradient(cx, cy, Math.min(aw, ah) * 0.3, cx, cy, Math.max(aw, ah) * 0.75);   // vignette
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(8,4,22,0.5)');
    c.fillStyle = g; c.fillRect(B.x0, B.y0, aw, ah);
    c.restore();
    c.strokeStyle = th.gold; c.lineWidth = 3; rr(c, B.x0 + 1.5, B.y0 + 1.5, aw - 3, ah - 3, 13); c.stroke();
  }

  function drawMotes() {                 // slow drifting dust that moves a little with the player (parallax)
    const aw = B.x1 - B.x0, ah = B.y1 - B.y0, px = player ? (player.x - W / 2) : 0, py = player ? (player.y - H / 2) : 0;
    ctx.fillStyle = '#ffe9a8';
    for (let i = 0; i < 26; i++) {
      const depth = 0.3 + (i % 5) * 0.18, sp = 5 + (i % 7) * 2.5;
      const x = B.x0 + (((i * 97.3 + clock * sp - px * depth * 0.06) % aw) + aw) % aw;
      const y = B.y0 + (((i * 61.7 + Math.sin(clock * 0.4 + i) * 12 + clock * sp * 0.3 - py * depth * 0.06) % ah) + ah) % ah;
      ctx.globalAlpha = 0.12 + 0.22 * Math.abs(Math.sin(clock * 0.9 + i));
      ctx.beginPath(); ctx.arc(x, y, 0.8 + depth * 1.3, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function glow(x, y, r, rgb, a) {
    const g = ctx.createRadialGradient(x, y, 2, x, y, r);
    g.addColorStop(0, 'rgba(' + rgb + ',' + a + ')'); g.addColorStop(1, 'rgba(' + rgb + ',0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
  }
  function drawCoin(c) {
    const w = Math.max(0.25, Math.abs(Math.cos(clock * 3 + c.phase)));
    ctx.save(); ctx.translate(c.x, c.y);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(0, c.r + 4, c.r * 0.8, 4, 0, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#c98a00';
    ctx.beginPath(); ctx.ellipse(0, 0, c.r * w, c.r, 0, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#ffc928';
    ctx.beginPath(); ctx.ellipse(0, 0, c.r * w * 0.85, c.r * 0.85, 0, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#ffe680';
    ctx.beginPath(); ctx.ellipse(-c.r * w * 0.25, -c.r * 0.3, c.r * w * 0.25, c.r * 0.25, 0, 0, 6.283); ctx.fill();
    ctx.restore();
  }
  function drawObstacle(o) {
    const grow = Math.min(1, o.age);
    ctx.save(); ctx.translate(o.x, o.y); ctx.scale(grow, grow);
    ctx.globalAlpha = o.age < 1 ? 0.5 + 0.5 * Math.abs(Math.sin(o.age * 12)) : 1;
    ctx.rotate(o.rot);
    ctx.fillStyle = '#ff5a4e';
    for (let i = 0; i < 8; i++) {
      ctx.rotate(Math.PI / 4);
      ctx.beginPath(); ctx.moveTo(o.r - 4, -6); ctx.lineTo(o.r + 9, 0); ctx.lineTo(o.r - 4, 6); ctx.fill();
    }
    ctx.beginPath(); ctx.arc(0, 0, o.r, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#7a1a2e';
    ctx.beginPath(); ctx.arc(0, 0, o.r * 0.6, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#fff4d6';
    ctx.beginPath(); ctx.arc(-4, -2, 3, 0, 6.283); ctx.arc(4, -2, 3, 0, 6.283); ctx.fill();
    ctx.restore();
  }
  function drawStopwatch(p) {             // glowing blue stopwatch with a shrinking ring (time left on screen)
    const life = timerCfg.lifetime, blink = p.age >= timerCfg.blinkFrom;
    const a = blink && Math.floor(p.age * 6) % 2 === 1 ? 0.18 : 1;      // clear blinking in the last 3 seconds
    const pulse = 1 + 0.08 * Math.sin(clock * 7);
    ctx.save(); ctx.translate(p.x, p.y); ctx.globalAlpha = a;
    glow(0, 0, p.r * 2.7 * pulse, '76,201,255', 0.5);
    ctx.strokeStyle = '#4cc9ff'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, 0, p.r + 6, -1.5708, -1.5708 + 6.283 * Math.max(0, 1 - p.age / life)); ctx.stroke();
    ctx.fillStyle = '#4cc9ff'; ctx.fillRect(-3, -p.r - 3, 6, 5); ctx.fillRect(-6, -p.r - 6, 12, 3);
    ctx.fillStyle = '#0f3a66'; ctx.beginPath(); ctx.arc(0, 0, p.r, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#eafaff'; ctx.beginPath(); ctx.arc(0, 0, p.r - 3.5, 0, 6.283); ctx.fill();
    ctx.strokeStyle = '#0f3a66'; ctx.lineWidth = 2;
    for (let i = 0; i < 4; i++) { const t = i * 1.5708; ctx.beginPath(); ctx.moveTo(Math.cos(t) * (p.r - 6.5), Math.sin(t) * (p.r - 6.5)); ctx.lineTo(Math.cos(t) * (p.r - 4), Math.sin(t) * (p.r - 4)); ctx.stroke(); }
    const h = clock * 3 - 1.5708; ctx.strokeStyle = '#e8453c'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(h) * (p.r - 6), Math.sin(h) * (p.r - 6)); ctx.stroke();
    ctx.fillStyle = '#0f3a66'; ctx.beginPath(); ctx.arc(0, 0, 2.2, 0, 6.283); ctx.fill();
    ctx.restore();
  }
  function drawBomb(b) {                  // dark bomb with an orange glow and a flickering fuse
    const blink = bombCfg.lifetime > 0 && b.age > bombCfg.lifetime - 3;
    const a = blink && Math.floor(b.age * 6) % 2 === 1 ? 0.3 : 1;
    const pulse = 1 + 0.1 * Math.sin(clock * 6);
    ctx.save(); ctx.translate(b.x, b.y); ctx.globalAlpha = a;
    glow(0, 0, b.r * 2.6 * pulse, '255,159,67', 0.5);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(0, b.r + 3, b.r * 0.8, 4, 0, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#2b2745'; ctx.strokeStyle = '#ff9f43'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(0, 2, b.r, 0, 6.283); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.ellipse(-5, -3, 4, 3, -0.6, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#ff9f43'; ctx.fillRect(-4, 2 - b.r - 3, 8, 5);
    ctx.strokeStyle = '#d9c9a3'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, 2 - b.r - 3); ctx.quadraticCurveTo(7, -b.r - 9, 11, -b.r - 5); ctx.stroke();
    const f = 0.6 + 0.4 * Math.sin(clock * 30);
    ctx.fillStyle = '#ffe680'; ctx.beginPath(); ctx.arc(11, -b.r - 5, 3.2 * f + 1, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#ff5a4e'; ctx.beginPath(); ctx.arc(11, -b.r - 5, 1.6, 0, 6.283); ctx.fill();
    ctx.restore();
  }
  function drawPlayer(p) {
    if (invincible > 0 && Math.floor(invincible * 10) % 2 === 0) return;
    ctx.save(); ctx.translate(p.x, p.y);
    if (bombCharges > 0) glow(0, 0, p.r * 2.4, '255,159,67', 0.35 + 0.12 * Math.sin(clock * 8));   // armed: faint orange aura
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(0, p.r + 3, p.r * 0.9, 5, 0, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#5ee6c1'; ctx.strokeStyle = '#1d8f78'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, p.r, 0, 6.283); ctx.fill(); ctx.stroke();
    const ex = Math.cos(p.face) * 3, ey = Math.sin(p.face) * 3;
    for (const sx of [-6, 6]) {
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(sx, -3, 5, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#17112b'; ctx.beginPath(); ctx.arc(sx + ex * 0.6, -3 + ey * 0.6, 2.5, 0, 6.283); ctx.fill();
    }
    ctx.restore();
  }
  function drawEffects() {
    for (const e of rings) {
      const p = e.t / e.dur, r = e.r * (1 - Math.pow(1 - p, 3));
      ctx.globalAlpha = 1 - p; ctx.strokeStyle = e.color; ctx.lineWidth = e.w * (1 - p * 0.5);
      ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, 6.283); ctx.stroke();
    }
    for (const e of particles) {
      ctx.globalAlpha = Math.max(0, e.life / e.max); ctx.fillStyle = e.color;
      ctx.fillRect(e.x - e.size / 2, e.y - e.size / 2, e.size, e.size);
    }
    ctx.textAlign = 'center'; ctx.lineJoin = 'round';
    for (const e of texts) {
      ctx.globalAlpha = Math.min(1, e.life / (e.max * 0.5));
      ctx.font = 'bold ' + e.size + 'px "Trebuchet MS", sans-serif';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(10,5,25,0.85)'; ctx.strokeText(e.text, e.x, e.y);
      ctx.fillStyle = e.color; ctx.fillText(e.text, e.x, e.y);
    }
    ctx.globalAlpha = 1;
  }
  function drawBlast() {
    const p = blast.t / blast.dur, e = 1 - Math.pow(1 - p, 3), r = blast.r * e;
    ctx.save();
    const g = ctx.createRadialGradient(blast.x, blast.y, r * 0.2, blast.x, blast.y, Math.max(r, 1));
    g.addColorStop(0, 'rgba(255,240,200,0)'); g.addColorStop(0.7, 'rgba(255,159,67,' + (0.22 * (1 - p)) + ')'); g.addColorStop(1, 'rgba(255,200,120,' + (0.5 * (1 - p)) + ')');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(blast.x, blast.y, r, 0, 6.283); ctx.fill();
    ctx.globalAlpha = 1 - p; ctx.strokeStyle = '#fff1cf'; ctx.lineWidth = 6 * (1 - p) + 1;
    ctx.beginPath(); ctx.arc(blast.x, blast.y, r, 0, 6.283); ctx.stroke();
    ctx.strokeStyle = '#ff9f43'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(blast.x, blast.y, r * 0.82, 0, 6.283); ctx.stroke();
    ctx.restore();
  }
  function draw() {
    ctx.save();
    if (shake > 0 && state === 'playing') ctx.translate(rand(-4, 4), rand(-4, 4));
    ctx.drawImage(bg, 0, 0, W, H);
    drawMotes();
    if (state !== 'menu' && player) {
      coins.forEach(drawCoin);
      if (bombPU) drawBomb(bombPU);
      if (timerPU) drawStopwatch(timerPU);
      obstacles.forEach(drawObstacle);
      drawPlayer(player);
      if (blast) drawBlast();
      drawEffects();
    }
    if (warnFlash > 0 && state === 'playing') {                         // soft red edge pulse once per second in the last 10 s
      const u = timeLeft <= 3 ? 1 : timeLeft <= 5 ? 0.7 : 0.4, a = 0.14 * u * warnFlash;
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.7);
      g.addColorStop(0, 'rgba(255,40,40,0)'); g.addColorStop(1, 'rgba(255,40,40,' + a + ')');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    if (flash > 0) { ctx.fillStyle = 'rgba(255,244,214,' + (0.3 * flash) + ')'; ctx.fillRect(0, 0, W, H); }   // brief blast flash
    if (joy.active) {                                                   // touch joystick
      ctx.globalAlpha = 0.35; ctx.strokeStyle = '#fff4d6'; ctx.fillStyle = '#fff4d6'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(joy.ox / S, joy.oy / S, 50 / S, 0, 6.283); ctx.stroke();
      ctx.beginPath(); ctx.arc(joy.px / S, joy.py / S, 20 / S, 0, 6.283); ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  // =====================================================================
  //  HUD (the text on top of the game)
  // =====================================================================
  const hudCache = {};
  function setText(el, key, val) { if (hudCache[key] !== val) { hudCache[key] = val; el.textContent = val; } }
  function updateHud(force) {
    const whole = Math.max(0, Math.ceil(timeLeft));
    setText(scoreEl, 's', score);
    setText(timeEl, 't', whole);
    const u = whole <= 3 ? 3 : whole <= 5 ? 2 : whole <= CONFIG.warnSeconds ? 1 : 0;
    if (timeBox.dataset.u !== String(u)) timeBox.dataset.u = String(u);
    let h = '';
    for (let i = 0; i < CONFIG.startLives; i++) h += '<span class="heart' + (i < lives ? '' : ' lost') + '">&#9829;</span>';
    if (hudCache.h !== h) { hudCache.h = h; livesEl.innerHTML = h; }
    setText(bombCount, 'b', bombCharges);
    bombPill.classList.toggle('on', bombCharges > 0);
    blastBtn.classList.toggle('hidden', !(bombCharges > 0 && state === 'playing'));
  }

  // =====================================================================
  //  Main loop (one single loop for the whole game)
  // =====================================================================
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);   // capped so a slow frame or a hidden tab never causes a jump
    last = now; clock += dt;
    if (state === 'playing') { update(dt); if (state === 'playing') updateHud(); }
    draw();
    requestAnimationFrame(frame);
  }

  // =====================================================================
  //  Controls
  // =====================================================================
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (state === 'playing') {
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      if ((e.code === 'Space' || e.code === 'KeyB') && !e.repeat) useBlast();
      if (e.code === 'KeyP' && !e.repeat) pauseGame();
    } else if (state === 'paused' && e.code === 'KeyP' && !e.repeat) resumeGame();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

  // Touch / mouse drag: press anywhere on the arena and drag to steer
  gameEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && !touchMode) { touchMode = true; fit(); }
    if (state !== 'playing' || e.target.closest('button') || joy.active) return;
    joy.active = true; joy.id = e.pointerId;
    joy.ox = joy.px = e.clientX; joy.oy = joy.py = e.clientY;
    joy.x = joy.y = 0;
    try { gameEl.setPointerCapture(e.pointerId); } catch (err) {}
  });
  gameEl.addEventListener('pointermove', (e) => {
    if (!joy.active || e.pointerId !== joy.id) return;
    let vx = e.clientX - joy.ox, vy = e.clientY - joy.oy;
    const m = Math.hypot(vx, vy), max = 50;
    if (m > max) { vx = vx / m * max; vy = vy / m * max; }
    joy.px = joy.ox + vx; joy.py = joy.oy + vy;
    joy.x = m < 6 ? 0 : vx / max; joy.y = m < 6 ? 0 : vy / max;
  });
  const releaseJoy = (e) => { if (e.pointerId === joy.id) { joy.active = false; joy.x = joy.y = 0; } };
  gameEl.addEventListener('pointerup', releaseJoy);
  gameEl.addEventListener('pointercancel', releaseJoy);
  gameEl.addEventListener('lostpointercapture', releaseJoy);
  gameEl.addEventListener('contextmenu', (e) => e.preventDefault());           // no long-press menu
  ['gesturestart', 'gesturechange'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));   // no pinch-zoom (iOS)
  document.addEventListener('touchmove', (e) => { if (e.target.closest && e.target.closest('#game')) e.preventDefault(); }, { passive: false });

  $('startBtn').addEventListener('click', startGame);
  $('restartBtn').addEventListener('click', startGame);
  $('resumeBtn').addEventListener('click', resumeGame);
  pauseBtn.addEventListener('click', () => { if (state === 'playing') pauseGame(); else resumeGame(); });

  // =====================================================================
  //  Go!
  // =====================================================================
  const chips = $('stageChips');
  STAGES.forEach((s) => {                // Stage 1 is playable; the others are labelled and cannot be clicked
    const d = document.createElement('div');
    d.className = 'chip' + (s === stage ? ' active' : '');
    d.textContent = s.name;
    const sm = document.createElement('small');
    sm.textContent = s.available ? (s === stage ? 'PLAY NOW' : 'READY') : 'COMING SOON';
    d.appendChild(sm);
    if (!s.available) d.setAttribute('aria-disabled', 'true');
    chips.appendChild(d);
  });
  updateSoundButton();
  stageTag.textContent = stage.name;
  fit();
  $('startBtn').focus();
  requestAnimationFrame(frame);
})();
