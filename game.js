// Coin Rush - a small HTML5 canvas game. No libraries needed.
(() => {
  'use strict';

  // ---- Settings you can safely tweak ----------------------------------
  const CONFIG = {
    gameSeconds: 60,       // length of one round
    startLives: 3,
    coinPoints: 10,        // points per coin
    playerSpeed: 280,      // pixels per second
    playerRadius: 16,
    maxCoins: 4,           // coins on screen at once
    diamondMinDelay: 9,    // seconds between possible time-bonus spawns
    diamondMaxDelay: 15,
    diamondChance: 0.82,
    startObstacles: 3,
    maxObstacles: 7,
    obstacleEvery: 15,     // seconds until one more obstacle appears
    invincibleSeconds: 1.5 // safe time after being hit
  };
  const TOP = 62; // HUD height
  const CONTROL_H = 190; // reserved mobile touch-control zone at the bottom
  const isPortrait = () => H > W;
  const playBottom = () => isPortrait() ? H - CONTROL_H : H;

  // ---- Page elements ---------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const gameEl = $('game'), canvas = $('canvas'), ctx = canvas.getContext('2d');
  const hud = $('hud'), scoreEl = $('score'), timeEl = $('time'), livesEl = $('lives');
  const startScreen = $('start'), overScreen = $('over');
  const soundBtn = $('soundBtn');

  // ---- Game state ------------------------------------------------------
  let W = 800, H = 600;          // arena size (switches to tall shape on phones)
  let state = 'menu';            // 'menu' | 'playing' | 'over'
  let score, lives, timeLeft, elapsed, invincible, shake, clock = 0;
  let player, coins, diamonds, obstacles, effects;
  let nextDiamondAt = 0;
  const keys = {};
  const joy = { active: false, id: null, ox: 0, oy: 0, x: 0, y: 0, px: 0, py: 0 };
  let soundOn = true, audio = null, master = null;

  const rand = (a, b) => a + Math.random() * (b - a);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // ---- Sizing: keep the arena fitting any screen ------------------------
  function chooseShape() {
    const tall = window.innerHeight > window.innerWidth * 1.05;
    W = tall ? 600 : 800;
    // Match the phone's available aspect ratio so the playfield sits high and
    // the bottom control zone remains visible instead of letterboxing heavily.
    H = tall ? Math.max(900, Math.ceil(W * window.innerHeight / window.innerWidth)) : 600;
  }
  function fit() {
    const s = Math.min(window.innerWidth / W, window.innerHeight / H);
    const cw = Math.floor(W * s), ch = Math.floor(H * s);
    gameEl.style.width = cw + 'px';
    gameEl.style.height = ch + 'px';
    gameEl.style.setProperty('--u', s.toFixed(3));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(cw * dpr);
    canvas.height = Math.floor(ch * dpr);
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
  }
  window.addEventListener('resize', () => {
    if (state !== 'playing') chooseShape();
    fit();
  });

  // ---- Sound (made with the browser, no sound files) --------------------
  // soundOn is the ONE switch for sound. The button label and the real audio
  // (a master volume control called "master") are always set from it together.
  function ensureAudio() {
    if (!audio) {
      try {
        audio = new (window.AudioContext || window.webkitAudioContext)();
        master = audio.createGain();
        master.connect(audio.destination);
      } catch (e) { audio = null; return false; }
    }
    // Browsers can put the audio engine to sleep. Wake it up whenever we need sound.
    if (audio.state !== 'running') { try { audio.resume(); } catch (e) {} }
    master.gain.value = soundOn ? 1 : 0;
    return true;
  }
  function updateSoundButton() {
    soundBtn.textContent = 'Sound: ' + (soundOn ? 'On' : 'Off');
    soundBtn.setAttribute('aria-pressed', String(soundOn));
  }
  function beep(freq, dur, type, vol, slideTo) {
    if (!soundOn || !ensureAudio()) return;
    try {
      const o = audio.createOscillator(), g = audio.createGain();
      const t = audio.currentTime;
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(vol || 0.1, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + dur);
    } catch (e) { /* sound is optional */ }
  }
  soundBtn.addEventListener('click', () => {
    soundOn = !soundOn;
    updateSoundButton();
    ensureAudio();                          // wakes the audio engine and sets the volume
    if (soundOn) beep(660, 0.1, 'triangle', 0.1, 990); // short "sound is back" blip
    soundBtn.blur();
  });
  // If the tab was hidden and the browser paused audio, wake it when the player returns.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && audio && soundOn) ensureAudio();
  });
  // iPhones can switch the audio engine to "interrupted" (phone call, app switch). Browsers only
  // allow waking it from a real tap, click or key press, so we also do it on those events.
  ['pointerup', 'touchend', 'keydown'].forEach((type) =>
    window.addEventListener(type, () => {
      if (audio && soundOn && audio.state !== 'running') ensureAudio();
    }, { passive: true }));

  // ---- Starting a round -------------------------------------------------
  function startGame() {
    ensureAudio();
    chooseShape(); fit();
    score = 0; lives = CONFIG.startLives; timeLeft = CONFIG.gameSeconds;
    elapsed = 0; invincible = 0; shake = 0;
    player = { x: W / 2, y: (TOP + playBottom()) / 2, r: CONFIG.playerRadius, face: 0 };
    coins = []; diamonds = []; obstacles = []; effects = [];
    nextDiamondAt = rand(CONFIG.diamondMinDelay, CONFIG.diamondMaxDelay);
    for (let i = 0; i < CONFIG.startObstacles; i++) spawnObstacle();
    while (coins.length < CONFIG.maxCoins) spawnCoin();
    startScreen.classList.add('hidden');
    overScreen.classList.add('hidden');
    hud.classList.remove('hidden');
    state = 'playing';
    beep(520, 0.15, 'triangle', 0.1, 880);
  }

  function endGame(reason) {
    state = 'over';
    hud.classList.add('hidden');
    let best = 0;
    try { best = Number(localStorage.getItem('coinRushBest')) || 0; } catch (e) {}
    const isNew = score > best;
    if (isNew) { best = score; try { localStorage.setItem('coinRushBest', String(best)); } catch (e) {} }
    $('reason').textContent = reason;
    $('finalScore').textContent = score;
    $('best').textContent = isNew && score > 0 ? 'New best score!' : 'Best: ' + best;
    overScreen.classList.remove('hidden');
    $('restartBtn').focus();
    beep(400, 0.5, 'sawtooth', 0.1, 120);
  }

  // ---- Spawning ---------------------------------------------------------
  function spawnCoin() {
    const c = { x: 0, y: 0, r: 13, phase: rand(0, 6) };
    for (let i = 0; i < 40; i++) {
      c.x = rand(40, W - 40); c.y = rand(TOP + 40, playBottom() - 40);
      const ok = dist(c, player) > 90 &&
        obstacles.every((o) => dist(c, o) > 70) &&
        coins.every((o) => dist(c, o) > 45);
      if (ok) break;
    }
    coins.push(c);
  }
  function spawnObstacle() {
    const o = { x: 0, y: 0, r: 18, age: 0, rot: 0 };
    for (let i = 0; i < 40; i++) {
      o.x = rand(40, W - 40); o.y = rand(TOP + 40, playBottom() - 40);
      if (dist(o, player) > 220) break;
    }
    const a = rand(0, Math.PI * 2), sp = rand(90, 150);
    o.vx = Math.cos(a) * sp; o.vy = Math.sin(a) * sp;
    obstacles.push(o);
  }
  function spawnDiamond() {
    const d = { x: W / 2, y: (TOP + playBottom()) / 2, r: 16, phase: 0 };
    for (let i = 0; i < 40; i++) {
      d.x = rand(42, W - 42); d.y = rand(TOP + 48, playBottom() - 48);
      if (dist(d, player) > 100 && obstacles.every((o) => dist(d, o) > 60) && coins.every((c) => dist(d, c) > 45)) break;
    }
    diamonds.push(d);
  }

  function burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, 6.28), s = rand(60, 200);
      effects.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.5, max: 0.5, color });
    }
  }

  // ---- Updating the game each frame ---------------------------------------
  function update(dt) {
    elapsed += dt; timeLeft -= dt;
    if (invincible > 0) invincible -= dt;
    if (shake > 0) shake -= dt;

    // Rare time-bonus diamond. +5 seconds is less common than +3.
    if (elapsed >= nextDiamondAt && diamonds.length === 0) {
      if (Math.random() < CONFIG.diamondChance) spawnDiamond();
      nextDiamondAt = elapsed + rand(CONFIG.diamondMinDelay, CONFIG.diamondMaxDelay);
    }

    // One more obstacle appears every few seconds
    const want = Math.min(CONFIG.maxObstacles, CONFIG.startObstacles + Math.floor(elapsed / CONFIG.obstacleEvery));
    while (obstacles.length < want) spawnObstacle();

    // Player movement (keyboard + touch)
    let dx = 0, dy = 0;
    if (keys.ArrowLeft || keys.KeyA) dx -= 1;
    if (keys.ArrowRight || keys.KeyD) dx += 1;
    if (keys.ArrowUp || keys.KeyW) dy -= 1;
    if (keys.ArrowDown || keys.KeyS) dy += 1;
    if (joy.active) { dx += joy.x; dy += joy.y; }
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    player.x += dx * CONFIG.playerSpeed * dt;
    player.y += dy * CONFIG.playerSpeed * dt;
    player.x = Math.max(player.r, Math.min(W - player.r, player.x));
    player.y = Math.max(TOP + player.r, Math.min(playBottom() - player.r, player.y));
    if (len > 0.05) player.face = Math.atan2(dy, dx);

    // Obstacles roam and bounce off the walls
    for (const o of obstacles) {
      o.age += dt; o.rot += dt * 2;
      o.x += o.vx * dt; o.y += o.vy * dt;
      if (o.x < o.r) { o.x = o.r; o.vx = Math.abs(o.vx); }
      if (o.x > W - o.r) { o.x = W - o.r; o.vx = -Math.abs(o.vx); }
      if (o.y < TOP + o.r) { o.y = TOP + o.r; o.vy = Math.abs(o.vy); }
      if (o.y > playBottom() - o.r) { o.y = playBottom() - o.r; o.vy = -Math.abs(o.vy); }
      // Hit? (new obstacles are harmless for their first second)
      if (o.age > 1 && invincible <= 0 && dist(o, player) < o.r + player.r - 4) {
        lives--; invincible = CONFIG.invincibleSeconds; shake = 0.3;
        burst(player.x, player.y, '#ff5a4e', 14);
        beep(220, 0.3, 'square', 0.1, 70);
        if (lives <= 0) { endGame('You ran out of lives.'); return; }
      }
    }

    // Collect coins
    for (let i = coins.length - 1; i >= 0; i--) {
      if (dist(coins[i], player) < coins[i].r + player.r) {
        score += CONFIG.coinPoints;
        burst(coins[i].x, coins[i].y, '#ffc928', 10);
        effects.push({ x: coins[i].x, y: coins[i].y, vx: 0, vy: -50, life: 0.7, max: 0.7, text: '+' + CONFIG.coinPoints });
        coins.splice(i, 1);
        beep(880, 0.12, 'triangle', 0.1, 1320);
      }
    }
    while (coins.length < CONFIG.maxCoins) spawnCoin();

    // Collect a time diamond. Give immediate feedback and a small time bonus.
    for (let i = diamonds.length - 1; i >= 0; i--) {
      const d = diamonds[i];
      d.phase += dt;
      if (dist(d, player) < d.r + player.r) {
        const bonus = Math.random() < 0.28 ? 5 : 3;
        timeLeft += bonus;
        burst(d.x, d.y, '#69e6ff', 22);
        effects.push({ x: d.x, y: d.y - 8, vx: 0, vy: -58, life: 1, max: 1, text: '+' + bonus + ' SEC', color: '#8af4ff' });
        diamonds.splice(i, 1);
        beep(660, 0.16, 'triangle', 0.12, 1320);
        beep(990, 0.22, 'sine', 0.08, 1760);
      }
    }

    // Particles and floating text
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      e.x += e.vx * dt; e.y += e.vy * dt; e.life -= dt;
      if (e.life <= 0) effects.splice(i, 1);
    }

    if (timeLeft <= 0) { timeLeft = 0; endGame("Time's up!"); }
  }

  // ---- Drawing -----------------------------------------------------------
  function drawArena() {
    ctx.fillStyle = '#0b1026'; ctx.fillRect(0, 0, W, H);
    const arenaGrad = ctx.createLinearGradient(0, TOP, W, playBottom());
    arenaGrad.addColorStop(0, '#1a2850'); arenaGrad.addColorStop(0.55, '#202654'); arenaGrad.addColorStop(1, '#301d52');
    ctx.fillStyle = arenaGrad; ctx.fillRect(0, TOP, W, playBottom() - TOP);
    ctx.strokeStyle = '#382d68'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 40) { ctx.moveTo(x, TOP); ctx.lineTo(x, playBottom()); }
    for (let y = TOP; y <= playBottom(); y += 40) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    const g = ctx.createRadialGradient(W / 2, (TOP + playBottom()) / 2, 20, W / 2, (TOP + playBottom()) / 2, Math.max(W, playBottom()) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(10,5,25,0.5)');
    ctx.fillStyle = g; ctx.fillRect(0, TOP, W, playBottom() - TOP);
    // Soft ambient lights and an inset neon arena border.
    ctx.save(); ctx.shadowBlur = 18; ctx.shadowColor = '#39d9ff';
    ctx.strokeStyle = '#5be5ff'; ctx.lineWidth = 3;
    ctx.strokeRect(3, TOP + 3, W - 6, playBottom() - TOP - 6); ctx.restore();
    if (isPortrait()) {
      ctx.fillStyle = '#0b1026'; ctx.fillRect(0, playBottom(), W, CONTROL_H);
      ctx.strokeStyle = 'rgba(105,230,255,.32)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, playBottom()); ctx.lineTo(W, playBottom()); ctx.stroke();
      const cy = playBottom() + CONTROL_H * 0.53;
      ctx.save(); ctx.globalAlpha = .7; ctx.strokeStyle = '#6deaff'; ctx.fillStyle = 'rgba(70,190,255,.08)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(W / 2, cy, 64, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.globalAlpha = .45; ctx.beginPath(); ctx.arc(W / 2, cy, 34, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = .75; ctx.fillStyle = '#d5faff'; ctx.font = 'bold 17px Trebuchet MS, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('TOUCH & DRAG TO MOVE', W / 2, playBottom() + 28); ctx.restore();
    }
  }

  function drawCoin(c) {
    const w = Math.max(0.25, Math.abs(Math.cos(clock * 3 + c.phase)));
    ctx.save(); ctx.translate(c.x, c.y);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(0, c.r + 4, c.r * 0.8, 4, 0, 0, 6.28); ctx.fill();
    ctx.shadowColor = '#ffc928'; ctx.shadowBlur = 13;
    ctx.fillStyle = '#c98a00';
    ctx.beginPath(); ctx.ellipse(0, 0, c.r * w, c.r, 0, 0, 6.28); ctx.fill();
    ctx.fillStyle = '#ffc928';
    ctx.beginPath(); ctx.ellipse(0, 0, c.r * w * 0.85, c.r * 0.85, 0, 0, 6.28); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = '#ffe680';
    ctx.beginPath(); ctx.ellipse(-c.r * w * 0.25, -c.r * 0.3, c.r * w * 0.25, c.r * 0.25, 0, 0, 6.28); ctx.fill();
    ctx.restore();
  }

  function drawDiamond(d) {
    const pulse = 1 + Math.sin(clock * 5 + d.phase) * 0.09;
    ctx.save(); ctx.translate(d.x, d.y); ctx.rotate(Math.sin(clock * 1.8 + d.phase) * 0.12); ctx.scale(pulse, pulse);
    ctx.globalAlpha = .25 + .12 * (1 + Math.sin(clock * 6)); ctx.fillStyle = '#53eaff';
    ctx.beginPath(); ctx.arc(0, 0, d.r + 13, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
    ctx.shadowColor = '#49e9ff'; ctx.shadowBlur = 22;
    ctx.beginPath(); ctx.moveTo(0, -d.r - 3); ctx.lineTo(d.r * .82, -2); ctx.lineTo(0, d.r + 4); ctx.lineTo(-d.r * .82, -2); ctx.closePath();
    ctx.fillStyle = '#37cfff'; ctx.fill(); ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.moveTo(0, -d.r - 3); ctx.lineTo(0, d.r + 4); ctx.lineTo(-d.r * .82, -2); ctx.closePath(); ctx.fillStyle = '#b9f8ff'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, -d.r - 3); ctx.lineTo(d.r * .82, -2); ctx.lineTo(0, -2); ctx.closePath(); ctx.fillStyle = '#efffff'; ctx.fill();
    ctx.restore();
  }

  function drawObstacle(o) {
    const grow = Math.min(1, o.age);           // pops in during the first second
    ctx.save(); ctx.translate(o.x, o.y); ctx.scale(grow, grow);
    ctx.globalAlpha = o.age < 1 ? 0.5 + 0.5 * Math.abs(Math.sin(o.age * 12)) : 1;
    ctx.rotate(o.rot);
    ctx.fillStyle = '#ff5a4e';
    for (let i = 0; i < 8; i++) {
      ctx.rotate(Math.PI / 4);
      ctx.beginPath(); ctx.moveTo(o.r - 4, -6); ctx.lineTo(o.r + 9, 0); ctx.lineTo(o.r - 4, 6); ctx.fill();
    }
    ctx.beginPath(); ctx.arc(0, 0, o.r, 0, 6.28); ctx.fill();
    ctx.fillStyle = '#7a1a2e';
    ctx.beginPath(); ctx.arc(0, 0, o.r * 0.6, 0, 6.28); ctx.fill();
    ctx.fillStyle = '#fff4d6';
    ctx.beginPath(); ctx.arc(-4, -2, 3, 0, 6.28); ctx.arc(4, -2, 3, 0, 6.28); ctx.fill();
    ctx.restore();
  }

  function drawPlayer(p) {
    if (invincible > 0 && Math.floor(invincible * 10) % 2 === 0) return; // blink when hurt
    ctx.save(); ctx.translate(p.x, p.y);
    ctx.shadowColor = '#5ee6c1'; ctx.shadowBlur = 18;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(0, p.r + 3, p.r * 0.9, 5, 0, 0, 6.28); ctx.fill();
    ctx.fillStyle = '#5ee6c1'; ctx.strokeStyle = '#1d8f78'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, p.r, 0, 6.28); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
    const ex = Math.cos(p.face) * 3, ey = Math.sin(p.face) * 3;
    for (const sx of [-6, 6]) {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(sx, -3, 5, 0, 6.28); ctx.fill();
      ctx.fillStyle = '#17112b';
      ctx.beginPath(); ctx.arc(sx + ex * 0.6, -3 + ey * 0.6, 2.5, 0, 6.28); ctx.fill();
    }
    ctx.restore();
  }

  function drawEffects() {
    for (const e of effects) {
      ctx.globalAlpha = Math.max(0, e.life / e.max);
      if (e.text) {
        ctx.fillStyle = e.color || '#fff4d6'; ctx.font = 'bold 20px Trebuchet MS, sans-serif';
        ctx.textAlign = 'center'; ctx.fillText(e.text, e.x, e.y);
      } else {
        ctx.fillStyle = e.color; ctx.fillRect(e.x - 2, e.y - 2, 4, 4);
      }
    }
    ctx.globalAlpha = 1;
  }

  function draw() {
    ctx.save();
    if (shake > 0) ctx.translate(rand(-5, 5), rand(-5, 5));
    drawArena();
    if (state !== 'menu') {
      coins.forEach(drawCoin);
      diamonds.forEach(drawDiamond);
      obstacles.forEach(drawObstacle);
      drawPlayer(player);
      drawEffects();
    }
    // Touch joystick
    if (joy.active) {
      const s = W / gameEl.clientWidth;
      ctx.globalAlpha = 0.35; ctx.strokeStyle = '#fff4d6'; ctx.fillStyle = '#fff4d6'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(joy.ox * s, joy.oy * s, 50 * s, 0, 6.28); ctx.stroke();
      ctx.beginPath(); ctx.arc(joy.px * s, joy.py * s, 20 * s, 0, 6.28); ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function updateHud() {
    scoreEl.textContent = score;
    const t = Math.ceil(timeLeft);
    timeEl.textContent = t;
    timeEl.classList.toggle('low', t <= 10);
    let h = '';
    for (let i = 0; i < CONFIG.startLives; i++) h += '<span class="heart' + (i < lives ? '' : ' lost') + '">&#9829;</span>';
    if (livesEl.dataset.h !== h) { livesEl.innerHTML = h; livesEl.dataset.h = h; }
  }

  // ---- Main loop ---------------------------------------------------------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); // capped so pausing a tab never causes a jump
    last = now; clock += dt;
    if (state === 'playing') { update(dt); if (state === 'playing') updateHud(); }
    draw();
    requestAnimationFrame(frame);
  }

  // ---- Controls ----------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (state === 'playing' && e.code.startsWith('Arrow')) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

  // Touch / mouse drag: press anywhere on the arena and drag to steer
  gameEl.addEventListener('pointerdown', (e) => {
    if (state !== 'playing' || e.target.closest('button')) return;
    const r = gameEl.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const scale = W / gameEl.clientWidth;
    if (isPortrait() && py * scale < playBottom()) return; // keep fingers out of the visible playfield
    joy.active = true; joy.id = e.pointerId;
    joy.ox = joy.px = px; joy.oy = joy.py = py;
    joy.x = joy.y = 0;
    gameEl.setPointerCapture(e.pointerId);
  });
  gameEl.addEventListener('pointermove', (e) => {
    if (!joy.active || e.pointerId !== joy.id) return;
    const r = gameEl.getBoundingClientRect();
    let vx = e.clientX - r.left - joy.ox, vy = e.clientY - r.top - joy.oy;
    const m = Math.hypot(vx, vy), max = 50;
    if (m > max) { vx = vx / m * max; vy = vy / m * max; }
    joy.px = joy.ox + vx; joy.py = joy.oy + vy;
    joy.x = m < 6 ? 0 : vx / max; joy.y = m < 6 ? 0 : vy / max;
  });
  const releaseJoy = (e) => { if (e.pointerId === joy.id) { joy.active = false; joy.x = joy.y = 0; } };
  gameEl.addEventListener('pointerup', releaseJoy);
  gameEl.addEventListener('pointercancel', releaseJoy);

  $('startBtn').addEventListener('click', startGame);
  $('restartBtn').addEventListener('click', startGame);

  // ---- Go! -----------------------------------------------------------------
  chooseShape(); fit();
  $('startBtn').focus();
  requestAnimationFrame(frame);
})();
