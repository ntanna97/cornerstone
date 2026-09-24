/* Cornerstone — interface. Uses window.Cornerstone (engine.js). */
(function () {
  'use strict';
  const E = window.Cornerstone;
  const N = E.N, COLORS = E.COLORS, PIECES = E.PIECES;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // ---------- look ----------
  const FILL  = ['#1b5fd1', '#f2b200', '#d62839', '#1e8e4a'];
  const DARK  = ['#0f3a80', '#7a5a00', '#7d1220', '#0e5228'];
  const INK   = ['#ffffff', '#2a1f00', '#ffffff', '#ffffff'];
  const SHAPE = ['circle', 'triangle', 'square', 'diamond'];
  const SHAPE_NAME = ['circle', 'triangle', 'square', 'diamond'];

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('cornerstone.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('cornerstone.' + k, JSON.stringify(v)); } catch (e) {} }
  };
  const settings = Object.assign({
    text: 'large', contrast: false, shapes: true, corners: true,
    sound: true, speak: false, motion: false, speed: 'normal'
  }, store.get('settings', {}));
  const BOT_NAMES = ['Marigold', 'Juniper', 'Basil'];
  const config = Object.assign({
    mode: 4,
    seats: [
      { name: 'You', type: 'human', level: 'medium' },
      { name: BOT_NAMES[0], type: 'bot', level: 'medium' },
      { name: BOT_NAMES[1], type: 'bot', level: 'medium' },
      { name: BOT_NAMES[2], type: 'bot', level: 'medium' }
    ]
  }, store.get('config', {}));

  // ---------- state ----------
  const S = {
    game: null, sel: null, cursor: null, locked: false, hintMsg: '', banner: '',
    snaps: [], token: 0, running: false, humanTurn: false, viewColor: 0,
    start: 0, zoom: 1, cell: 24, anim: null, over: false,
    online: null, onlineBotTimer: null, onlineName: ''
  };
  const ZOOMS = [1, 1.4, 1.8, 2.3];
  let zoomIdx = 0;

  const canvas = $('#board'), ctx = canvas.getContext('2d');
  const reducedMotion = () => settings.motion || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ---------- seats / colours ----------
  const seatCount = () => (config.mode === 2 ? 2 : config.mode === 3 ? 3 : 4);
  function seatIndexFor(c) {            // which seat owns colour c (-1 = shared)
    if (config.mode === 2) return c % 2;
    if (config.mode === 3) return c < 3 ? c : -1;
    return c;
  }
  function currentSeatIndex(c) {
    const i = seatIndexFor(c);
    return i >= 0 ? i : (S.game.meta.sharedCount || 0) % 3;
  }
  function seatFor(c) { return config.seats[currentSeatIndex(c)]; }
  function amActingColor(c) {
    if (!S.online) return true;
    return S.online.actingColors().includes(c);
  }
  const isShared = (c) => config.mode === 3 && c === 3;
  const seatColors = (i) => COLORS.map((_, c) => c).filter((c) => seatIndexFor(c) === i);
  const hasHumanColor = () => [0, 1, 2, 3].some((c) => isShared(c) ? config.seats.slice(0, 3).some((s) => s.type === 'human') : seatFor(c).type === 'human');
  function humansAllOut(g) {
    if (!hasHumanColor()) return false;
    return [0, 1, 2, 3].every((c) => {
      const human = isShared(c) ? config.seats.slice(0, 3).some((s) => s.type === 'human') : config.seats[seatIndexFor(c)].type === 'human';
      return !human || g.out[c];
    });
  }
  const controllerName = (c) => (isShared(c) ? 'Shared' : seatFor(c).name);

  // ---------- svg helpers ----------
  function glyphSvg(c, cx, cy, r) {
    const f = INK[c];
    switch (SHAPE[c]) {
      case 'circle': return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${f}"/>`;
      case 'square': return `<rect x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" fill="${f}"/>`;
      case 'triangle': return `<polygon points="${cx},${cy - r * 1.15} ${cx + r * 1.15},${cy + r * .95} ${cx - r * 1.15},${cy + r * .95}" fill="${f}"/>`;
      default: return `<polygon points="${cx},${cy - r * 1.25} ${cx + r * 1.25},${cy} ${cx},${cy + r * 1.25} ${cx - r * 1.25},${cy}" fill="${f}"/>`;
    }
  }
  function chipHtml(c) {
    return `<svg viewBox="0 0 10 10" aria-hidden="true">${settings.shapes ? glyphSvg(c, 5, 5, 3) : ''}</svg>`;
  }
  function paintChip(el, c) {
    el.style.background = FILL[c];
    el.innerHTML = chipHtml(c);
  }
  function pieceSvg(cells, c, box, withGlyph) {
    const w = Math.max(...cells.map((p) => p[0])) + 1, h = Math.max(...cells.map((p) => p[1])) + 1;
    const ox = (box - w) / 2, oy = (box - h) / 2;
    let s = `<svg viewBox="0 0 ${box} ${box}" aria-hidden="true">`;
    for (const [x, y] of cells) {
      s += `<rect x="${x + ox + .04}" y="${y + oy + .04}" width=".92" height=".92" rx=".14" fill="${FILL[c]}" stroke="${DARK[c]}" stroke-width=".07"/>`;
      if (withGlyph && settings.shapes) s += glyphSvg(c, x + ox + .5, y + oy + .5, .2);
    }
    return s + '</svg>';
  }
  function miniFigure(el, blueCells, tone) {
    let s = '';
    for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) s += `<rect x="${x + .03}" y="${y + .03}" width=".94" height=".94" fill="#fff" stroke="#9aa3ad" stroke-width=".04"/>`;
    for (const [x, y] of blueCells) s += `<rect x="${x + .06}" y="${y + .06}" width=".88" height=".88" rx=".12" fill="${FILL[0]}" stroke="${DARK[0]}" stroke-width=".06"/>`;
    el.innerHTML = s;
  }

  // ---------- sound ----------
  let ac = null;
  function tone(freq, dur, type, gain, delay) {
    if (!settings.sound) return;
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const t = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain || .08, t + .01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + dur + .02);
    } catch (e) {}
  }
  const snd = {
    pick() { tone(560, .07, 'triangle', .06); },
    turn() { tone(440, .06, 'triangle', .05); },
    place() { tone(300, .12, 'triangle', .1); tone(200, .16, 'sine', .09, .05); },
    bot() { tone(360, .1, 'triangle', .06); tone(260, .12, 'sine', .05, .04); },
    no() { tone(150, .18, 'sawtooth', .04); },
    pass() { tone(330, .12, 'sine', .05); tone(247, .18, 'sine', .05, .12); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, .28, 'triangle', .08, i * .13)); }
  };

  // ---------- announcements ----------
  const live = $('#live');
  function say(text, speak) {
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 30);
    if (speak !== false && settings.speak && 'speechSynthesis' in window) {
      try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = .95; speechSynthesis.speak(u); } catch (e) {}
    }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pieceLabel = (p) => `${PIECES[p].name} (${PIECES[p].size} square${PIECES[p].size > 1 ? 's' : ''})`;

  // ---------- screens & dialogs ----------
  function show(id) {
    ['menu', 'setup', 'online', 'lobby', 'game'].forEach((n) => { $('#screen-' + n).hidden = n !== id; });
    window.scrollTo(0, 0);
    const h = $('#screen-' + id + ' h1, #screen-' + id + ' h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }
  function openDlg(id) { const d = $('#' + id); if (!d.open) d.showModal(); }
  $$('dialog').forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    $$('[data-close]', d).forEach((b) => b.addEventListener('click', () => d.close()));
  });

  // ---------- settings ----------
  function applySettings() {
    document.documentElement.dataset.text = settings.text;
    document.body.classList.toggle('hc', !!settings.contrast);
    store.set('settings', settings);
    if (S.game) { fit(); renderAll(); }
  }
  function initSettingsUi() {
    $$('input[name=text]').forEach((i) => { i.checked = i.value === settings.text; i.onchange = () => { settings.text = i.value; applySettings(); }; });
    $$('input[name=speed]').forEach((i) => { i.checked = i.value === settings.speed; i.onchange = () => { settings.speed = i.value; applySettings(); }; });
    const map = { '#set-contrast': 'contrast', '#set-shapes': 'shapes', '#set-corners': 'corners', '#set-sound': 'sound', '#set-speak': 'speak', '#set-motion': 'motion' };
    Object.keys(map).forEach((sel) => { const el = $(sel); el.checked = !!settings[map[sel]]; el.onchange = () => {
      settings[map[sel]] = el.checked; applySettings();
      if (sel === '#set-speak' && el.checked) say('Reading turns aloud is on.');
    }; });
  }

  // ---------- menu / setup ----------
  function drawLogo() {
    const cells = [
      { c: 0, pts: [[0, 0], [1, 0], [1, 1]], at: [0, 0] },
      { c: 1, pts: [[0, 0], [1, 0]], at: [3, 2] },
      { c: 2, pts: [[0, 0], [0, 1], [1, 1]], at: [5, 3] },
      { c: 3, pts: [[0, 0], [1, 0], [2, 0]], at: [7, 5] }
    ];
    let s = '';
    for (const p of cells) for (const [x, y] of p.pts) {
      const X = x + p.at[0], Y = y + p.at[1];
      s += `<rect x="${X + .04}" y="${Y + .04}" width=".92" height=".92" rx=".16" fill="${FILL[p.c]}" stroke="#fff" stroke-width=".07"/>`;
      s += glyphSvg(p.c, X + .5, Y + .5, .2);
    }
    $('#logo').innerHTML = s;
  }
  function renderSetup() {
    $$('input[name=mode]').forEach((i) => { i.checked = +i.value === config.mode; });
    const box = $('#seats'); box.innerHTML = '';
    for (let i = 0; i < seatCount(); i++) {
      const seat = config.seats[i];
      const cols = config.mode === 3 && i === 0 ? seatColors(0) : seatColors(i);
      const el = document.createElement('div'); el.className = 'seat';
      el.innerHTML = `<h3>Seat ${i + 1}</h3>
        <div class="seat-colors" aria-label="Colours for this seat">${cols.map((c) => `<span><svg width="20" height="20" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="${FILL[c]}"/>${settings.shapes ? glyphSvg(c, 5, 5, 2.6) : ''}</svg>${COLORS[c].name}</span>`).join('')}</div>
        <div class="seat-fields">
          <label>Name<input type="text" maxlength="14" value="${seat.name.replace(/"/g, '&quot;')}" data-f="name" data-i="${i}"></label>
          <label>Who plays this seat?<select data-f="type" data-i="${i}">
            <option value="human"${seat.type === 'human' ? ' selected' : ''}>A person</option>
            <option value="bot"${seat.type === 'bot' ? ' selected' : ''}>The computer</option></select></label>
          <label ${seat.type === 'bot' ? '' : 'hidden'}>Computer skill<select data-f="level" data-i="${i}">
            <option value="easy"${seat.level === 'easy' ? ' selected' : ''}>Gentle</option>
            <option value="medium"${seat.level === 'medium' ? ' selected' : ''}>Friendly challenge</option>
            <option value="hard"${seat.level === 'hard' ? ' selected' : ''}>Tough</option></select></label>
        </div>`;
      box.appendChild(el);
    }
    if (config.mode === 3) {
      const n = document.createElement('p'); n.className = 'hint-line';
      n.textContent = 'Green is the shared colour. Each seat plays it in turn, and its score does not count.'; box.appendChild(n);
    }
    $$('#seats [data-f]').forEach((el) => {
      const upd = () => {
        const seat = config.seats[+el.dataset.i];
        seat[el.dataset.f] = el.value;
        if (el.dataset.f === 'type') { renderSetup(); const t = $(`#seats [data-f=type][data-i="${el.dataset.i}"]`); if (t) t.focus(); }
        store.set('config', config);
      };
      el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', upd);
    });
  }
  $$('input[name=mode]').forEach((i) => i.addEventListener('change', () => { config.mode = +i.value; store.set('config', config); renderSetup(); }));

  // ---------- new game ----------
  function startGame() {
    S.token++;
    const g = E.newGame(); g.meta = { sharedCount: 0, moves: 0, last: null };
    S.game = g; S.sel = null; S.cursor = null; S.locked = false; S.snaps = []; S.hintMsg = ''; S.banner = '';
    S.over = false; S.running = false; S.humanTurn = false; S.start = Date.now(); S.anim = null;
    const firstHuman = [0, 1, 2, 3].find((c) => !isShared(c) && seatFor(c).type === 'human');
    S.viewColor = firstHuman === undefined ? 0 : firstHuman;
    zoomIdx = 0;
    show('game');
    fit();
    renderAll();
    say('New game. ' + (hasHumanColor() ? 'Blue goes first.' : 'Watching the computer players.'));
    runTurns();
  }

  // ---------- turn loop ----------
  function botDelay() { return window.__testFastBots ? 4 : ({ slow: 1500, normal: 900, fast: 350 }[settings.speed] || 900); }
  async function runTurns() {
    if (S.running) return;
    S.running = true; const token = S.token;
    try {
      while (token === S.token) {
        const g = S.game;
        if (g.out.every(Boolean)) { finish(); return; }
        const c = g.turn;
        if (g.out[c]) { g.turn = (c + 1) % 4; continue; }
        if (!E.hasMove(g, c)) {
          g.out[c] = true; S.humanTurn = false;
          const who = isShared(c) ? 'The shared colour' : `${seatFor(c).name}`;
          S.banner = `${COLORS[c].name} has no moves left and passes.`;
          say(`${who}, ${COLORS[c].name}, has no moves left and passes.`);
          snd.pass(); renderAll();
          await sleep(humansAllOut(g) ? 80 : 1400);
          if (token !== S.token) return;
          S.banner = ''; g.turn = (c + 1) % 4; continue;
        }
        const seat = seatFor(c);
        S.banner = '';
        if (seat.type === 'human') { beginHumanTurn(c); return; }
        S.humanTurn = false; renderAll();
        await sleep(humansAllOut(g) ? 60 : botDelay());
        if (token !== S.token) return;
        const mv = E.botChoose(g, c, seat.level);
        if (!mv) { g.out[c] = true; continue; }
        commitMove(c, mv.p, mv.cells);
        snd.bot();
        say(`${seat.name} played the ${pieceLabel(mv.p)} as ${COLORS[c].name}.`);
        await sleep(humansAllOut(g) ? 60 : 350);
      }
    } finally { S.running = false; }
  }
  function beginHumanTurn(c) {
    S.humanTurn = true; S.viewColor = c; S.sel = null; S.cursor = null; S.locked = false; S.hintMsg = '';
    S.snaps.push(E.cloneGame(S.game));
    renderAll();
    const seat = seatFor(c);
    const msg = isShared(c) ? `${seat.name}, it is your turn to play the shared colour, Green.` : `${seat.name}, it is your turn. You are ${COLORS[c].name}.`;
    say(msg);
    snd.turn();
  }
  function commitMove(c, p, cells) {
    const g = S.game;
    E.apply(g, c, p, cells);
    g.meta.last = { c, cells, p };
    g.meta.moves++;
    if (isShared(c)) g.meta.sharedCount++;
    g.turn = (c + 1) % 4;
    S.sel = null; S.cursor = null; S.locked = false; S.humanTurn = false; S.hintMsg = '';
    if (!reducedMotion()) { S.anim = { cells, t0: performance.now() }; animate(); }
    renderAll();
  }
  function animate() {
    if (!S.anim) return;
    draw();
    if (performance.now() - S.anim.t0 < 420) requestAnimationFrame(animate); else { S.anim = null; draw(); }
  }

  // ---------- human actions ----------
  const myTurn = () => S.humanTurn && !S.over && S.game && seatFor(S.game.turn).type === 'human';
  function selectPiece(p) {
    if (!myTurn()) return;
    S.sel = { p, rot: 0, flip: false }; S.hintMsg = '';
    snd.pick(); say(`Chosen: ${pieceLabel(p)}.`, false);
    renderAll();
  }
  function ghostCells() {
    if (!S.sel || !S.cursor) return null;
    const o = E.transform(S.sel.p, S.sel.rot, S.sel.flip);
    const w = Math.max(...o.map((c) => c[0])) + 1, h = Math.max(...o.map((c) => c[1])) + 1;
    const ox = S.cursor.x - Math.floor(w / 2), oy = S.cursor.y - Math.floor(h / 2);
    return o.map(([x, y]) => [x + ox, y + oy]);
  }
  const REASONS = {
    off: 'Part of the piece hangs off the board.',
    overlap: 'Some of those squares are already taken.',
    side: 'It touches one of your own pieces along a side. Your pieces may only meet at corners.',
    start: 'Your first piece must cover the marked corner of the board.',
    corner: 'It must touch one of your own pieces at a corner.'
  };
  function ghostState() {
    const cells = ghostCells(); if (!cells) return null;
    return { cells, res: E.check(S.game, S.game.turn, cells) };
  }
  function rotate() { if (!S.sel || !myTurn()) return; S.sel.rot = (S.sel.rot + 1) % 4; snd.pick(); renderAll(); }
  function flip() { if (!S.sel || !myTurn()) return; S.sel.flip = !S.sel.flip; snd.pick(); renderAll(); }
  function placeNow() {
    if (!myTurn()) return;
    if (!S.sel) { snd.no(); say('Choose a piece first.'); return; }
    if (!S.cursor) { snd.no(); say('Tap the board to choose where the piece goes.'); return; }
    const gs = ghostState();
    if (!gs.res.ok) { snd.no(); say(REASONS[gs.res.reason]); return; }
    const c = S.game.turn, seat = seatFor(c), p = S.sel.p, size = PIECES[p].size;
    if (S.online) {
      const res = S.online.proposeMove(c, p, gs.cells);
      if (!res.ok) { snd.no(); say('That move was rejected by the room. Try again.'); return; }
    } else {
      commitMove(c, p, gs.cells);
    }
    snd.place();
    const cheers = size >= 5 ? ['Big one!', 'Nice, a five-square piece.', 'Solid move.'] : size >= 3 ? ['Nicely done.', 'Neat fit.', 'Good spot.'] : ['Tidy.', 'Sneaky little piece.', 'Good use of space.'];
    say(cheers[Math.floor(Math.random() * cheers.length)] + ` ${seat.name} placed the ${PIECES[p].name}.`);
    if (!S.online) runTurns();
  }
  function hint() {
    if (!myTurn()) return;
    const g = S.game, c = g.turn;
    const mv = E.botChoose(g, c, 'hard');
    if (!mv) return;
    const tf = E.findTransform(mv.p, mv.cells);
    S.sel = { p: mv.p, rot: tf.rot, flip: tf.flip };
    const o = E.transform(mv.p, tf.rot, tf.flip);
    const w = Math.max(...o.map((q) => q[0])) + 1, h = Math.max(...o.map((q) => q[1])) + 1;
    S.cursor = { x: mv.ox + Math.floor(w / 2), y: mv.oy + Math.floor(h / 2) }; S.locked = true;
    S.hintMsg = 'Here is one good move. Press Place piece to use it, or choose something else.';
    snd.pick(); say(S.hintMsg);
    renderAll(); scrollToCursor();
  }
  function undo() {
    if (!myTurn() || S.snaps.length < 2) return;
    S.token++; S.running = false;
    S.snaps.pop(); const snap = S.snaps.pop();
    S.game = E.cloneGame(snap); S.sel = null; S.cursor = null; S.locked = false;
    say('Took back your last move.');
    runTurns();
  }

  // ---------- board input ----------
  function cellAt(e) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return { x: 10, y: 10 };
    return { x: Math.max(0, Math.min(N - 1, Math.floor((e.clientX - r.left) / r.width * N))), y: Math.max(0, Math.min(N - 1, Math.floor((e.clientY - r.top) / r.height * N))) };
  }
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !myTurn() || !S.sel || S.locked) return;
    const c = cellAt(e);
    if (!S.cursor || S.cursor.x !== c.x || S.cursor.y !== c.y) { S.cursor = c; renderStatus(); draw(); }
  });
  canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !S.locked && S.cursor) { S.cursor = null; renderStatus(); draw(); } });
  canvas.addEventListener('click', (e) => {
    if (!myTurn()) return;
    if (!S.sel) { snd.no(); say('Choose a piece from the list first.'); return; }
    const c = cellAt(e);
    const gs = ghostState();
    if (S.locked && gs && gs.res.ok && gs.cells.some(([x, y]) => x === c.x && y === c.y)) { placeNow(); return; }
    S.cursor = c; S.locked = true; S.hintMsg = '';
    renderAll();
    const g2 = ghostState();
    if (g2) say(g2.res.ok ? 'This spot works. Press Place piece.' : REASONS[g2.res.reason], false);
  });
  canvas.addEventListener('keydown', (e) => {
    if (!myTurn()) return;
    const k = e.key;
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[k]) {
      e.preventDefault();
      if (!S.sel) { say('Choose a piece first, then move it with the arrow keys.'); return; }
      if (!S.cursor) { const f = E.frontier(S.game, S.game.turn)[0]; S.cursor = f ? { x: f[0], y: f[1] } : { x: 10, y: 10 }; }
      else S.cursor = { x: Math.max(0, Math.min(N - 1, S.cursor.x + arrows[k][0])), y: Math.max(0, Math.min(N - 1, S.cursor.y + arrows[k][1])) };
      S.locked = true; renderAll(); scrollToCursor();
      const gs = ghostState(); if (gs && !gs.res.ok) snd.no();
    } else if (k === 'r' || k === 'R') { e.preventDefault(); rotate(); }
    else if (k === 'f' || k === 'F') { e.preventDefault(); flip(); }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); placeNow(); }
    else if (k === 'Escape') { S.sel = null; S.cursor = null; S.locked = false; renderAll(); }
    else if (k === '[' || k === ']') {
      e.preventDefault();
      const c = S.game.turn; const list = trayList(c); if (!list.length) return;
      const i = S.sel ? list.indexOf(S.sel.p) : -1;
      selectPiece(list[(i + (k === ']' ? 1 : -1) + list.length) % list.length]);
    }
  });
  function scrollToCursor() {
    if (!S.cursor) return;
    const wrap = $('#boardwrap'), cs = S.cell;
    const x = S.cursor.x * cs, y = S.cursor.y * cs;
    if (wrap.scrollWidth > wrap.clientWidth) wrap.scrollLeft = Math.max(0, x - wrap.clientWidth / 2);
    if (wrap.scrollHeight > wrap.clientHeight) wrap.scrollTop = Math.max(0, y - wrap.clientHeight / 2);
  }

  // ---------- sizing ----------
  function fit() {
    const wrap = $('#boardwrap');
    const avail = Math.max(240, wrap.clientWidth - 16);
    const base = Math.max(12, Math.min(40, Math.floor(avail / N)));
    S.cell = Math.round(base * ZOOMS[zoomIdx]);
    $('#zoom-label').textContent = 'Board size: ' + Math.round(ZOOMS[zoomIdx] * 100) + '%';
    $('#zoom-out').disabled = zoomIdx === 0; $('#zoom-in').disabled = zoomIdx === ZOOMS.length - 1;
  }
  $('#zoom-in').onclick = () => { zoomIdx = Math.min(ZOOMS.length - 1, zoomIdx + 1); fit(); draw(); scrollToCursor(); };
  $('#zoom-out').onclick = () => { zoomIdx = Math.max(0, zoomIdx - 1); fit(); draw(); };
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (S.game) { fit(); draw(); } }, 120); });

  // ---------- drawing ----------
  function rr(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function glyphCanvas(c, cx, cy, r) {
    ctx.fillStyle = INK[c]; ctx.beginPath();
    switch (SHAPE[c]) {
      case 'circle': ctx.arc(cx, cy, r, 0, 7); break;
      case 'square': ctx.rect(cx - r, cy - r, 2 * r, 2 * r); break;
      case 'triangle': ctx.moveTo(cx, cy - r * 1.15); ctx.lineTo(cx + r * 1.15, cy + r * .95); ctx.lineTo(cx - r * 1.15, cy + r * .95); ctx.closePath(); break;
      default: ctx.moveTo(cx, cy - r * 1.25); ctx.lineTo(cx + r * 1.25, cy); ctx.lineTo(cx, cy + r * 1.25); ctx.lineTo(cx - r * 1.25, cy); ctx.closePath();
    }
    ctx.fill();
  }
  function drawTile(x, y, c, alpha, scale) {
    const cs = S.cell, s = scale || 1;
    const cx = (x + .5) * cs, cy = (y + .5) * cs, w = (cs - 2) * s;
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.fillStyle = FILL[c]; rr(cx - w / 2, cy - w / 2, w, w, cs * .14); ctx.fill();
    ctx.lineWidth = settings.contrast ? 2.5 : 1.5; ctx.strokeStyle = settings.contrast ? '#000' : DARK[c]; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.2)'; rr(cx - w * .32, cy - w * .32, w * .64, w * .64, cs * .1); ctx.fill();
    if (settings.shapes) glyphCanvas(c, cx, cy, cs * .2 * s);
    ctx.globalAlpha = 1;
  }
  function outline(cells, colorOuter, colorInner, dash) {
    const cs = S.cell, set = new Set(cells.map(([x, y]) => x + ',' + y));
    const segs = [];
    for (const [x, y] of cells) {
      if (!set.has((x) + ',' + (y - 1))) segs.push([x, y, x + 1, y]);
      if (!set.has((x) + ',' + (y + 1))) segs.push([x, y + 1, x + 1, y + 1]);
      if (!set.has((x - 1) + ',' + y)) segs.push([x, y, x, y + 1]);
      if (!set.has((x + 1) + ',' + y)) segs.push([x + 1, y, x + 1, y + 1]);
    }
    const stroke = (col, w, d) => {
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(d || []); ctx.lineCap = 'round'; ctx.beginPath();
      for (const [a, b, c2, d2] of segs) { ctx.moveTo(a * cs, b * cs); ctx.lineTo(c2 * cs, d2 * cs); }
      ctx.stroke(); ctx.setLineDash([]);
    };
    stroke(colorOuter, Math.max(5, cs * .2), null);
    stroke(colorInner, Math.max(2.5, cs * .1), dash);
  }
  function draw() {
    const g = S.game; if (!g) return;
    const cs = S.cell, size = cs * N, dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(size * dpr)) {
      canvas.width = Math.round(size * dpr); canvas.height = Math.round(size * dpr);
      canvas.style.width = size + 'px'; canvas.style.height = size + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);
    // grid
    ctx.strokeStyle = settings.contrast ? '#000' : '#8b95a1'; ctx.lineWidth = settings.contrast ? 1.5 : 1;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) { ctx.moveTo(i * cs + .5, 0); ctx.lineTo(i * cs + .5, size); ctx.moveTo(0, i * cs + .5); ctx.lineTo(size, i * cs + .5); }
    ctx.stroke();
    // start corners
    for (let c = 0; c < 4; c++) if (g.first[c]) {
      const [x, y] = COLORS[c].corner;
      ctx.globalAlpha = .28; ctx.fillStyle = FILL[c]; ctx.fillRect(x * cs + 1, y * cs + 1, cs - 1, cs - 1); ctx.globalAlpha = 1;
      ctx.strokeStyle = FILL[c]; ctx.lineWidth = Math.max(3, cs * .12); ctx.strokeRect(x * cs + 2, y * cs + 2, cs - 4, cs - 4);
      if (settings.shapes) { ctx.globalAlpha = .9; ctx.fillStyle = FILL[c]; const gg = INK[c]; INK[c] = FILL[c]; glyphCanvas(c, (x + .5) * cs, (y + .5) * cs, cs * .2); INK[c] = gg; ctx.globalAlpha = 1; }
    }
    // pieces
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const v = g.board[y * N + x]; if (v < 0) continue;
      let sc = 1;
      if (S.anim && S.anim.cells.some(([ax, ay]) => ax === x && ay === y)) {
        const t = Math.min(1, (performance.now() - S.anim.t0) / 320); sc = 1 + .35 * (1 - t) * (1 - t);
      }
      drawTile(x, y, v, 1, sc);
    }
    // playable markers
    if (settings.corners && myTurn()) {
      const c = g.turn;
      for (const [x, y] of E.frontier(g, c)) {
        if (g.first[c]) continue;
        const cx = (x + .5) * cs, cy = (y + .5) * cs, r = cs * .16;
        ctx.fillStyle = '#fff'; ctx.strokeStyle = FILL[c]; ctx.lineWidth = Math.max(2, cs * .09);
        ctx.beginPath(); ctx.moveTo(cx, cy - r * 1.3); ctx.lineTo(cx + r * 1.3, cy); ctx.lineTo(cx, cy + r * 1.3); ctx.lineTo(cx - r * 1.3, cy); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = DARK[c]; ctx.beginPath(); ctx.arc(cx, cy, r * .4, 0, 7); ctx.fill();
      }
    }
    // last move
    const last = g.meta && g.meta.last;
    if (last) outline(last.cells, '#ffffff', '#14181f', [cs * .18, cs * .12]);
    // ghost
    const gs = myTurn() ? ghostState() : null;
    if (gs) {
      const c = g.turn;
      for (const [x, y] of gs.cells) {
        if (x < 0 || y < 0 || x >= N || y >= N) continue;
        if (gs.res.ok) drawTile(x, y, c, .95);
        else {
          drawTile(x, y, c, .5);
          ctx.strokeStyle = '#14181f'; ctx.lineWidth = Math.max(3, cs * .12); ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo((x + .28) * cs, (y + .28) * cs); ctx.lineTo((x + .72) * cs, (y + .72) * cs);
          ctx.moveTo((x + .72) * cs, (y + .28) * cs); ctx.lineTo((x + .28) * cs, (y + .72) * cs); ctx.stroke();
        }
      }
      const inb = gs.cells.filter(([x, y]) => x >= 0 && y >= 0 && x < N && y < N);
      if (inb.length) {
        if (gs.res.ok) outline(inb, '#ffffff', '#0b6b2e', null);
        else outline(inb, '#ffffff', '#a3121f', [cs * .2, cs * .14]);
      }
    }
  }

  // ---------- rendering ----------
  function statusInfo() {
    const g = S.game;
    if (S.over) return { main: 'Game over', sub: 'See the results.', tone: '', c: g.turn };
    if (S.banner) return { main: S.banner, sub: '', tone: '', c: g.turn };
    const c = g.turn, seat = seatFor(c);
    if (!myTurn()) {
      return { main: `${seat.name} is thinking…`, sub: `Playing ${COLORS[c].name}`, tone: '', c };
    }
    const who = isShared(c) ? `${seat.name}, play the shared colour` : (config.seats.filter((s) => s.type === 'human').length === 1 && seat.name === 'You' ? 'Your turn' : `${seat.name}, your turn`);
    const head = `${who} (${COLORS[c].name})`;
    if (!S.sel) {
      const sub = g.first[c] ? 'Choose a piece. Your first piece must cover the marked corner.' : 'Choose a piece from the list.';
      return { main: head, sub, tone: '', c };
    }
    if (!S.cursor) return { main: head, sub: 'Now tap the board to preview where it goes.', tone: '', c };
    const gs = ghostState();
    if (gs.res.ok) return { main: '✓ This spot works', sub: S.hintMsg || 'Press “Place piece”, or tap the piece again.', tone: 'ok', c };
    return { main: '✗ Not here', sub: REASONS[gs.res.reason], tone: 'bad', c };
  }
  function renderStatus() {
    const st = statusInfo(), el = $('#status');
    el.dataset.tone = st.tone || '';
    paintChip($('#status-chip'), st.c);
    $('#status-main').textContent = st.main; $('#status-sub').textContent = st.sub;
  }
  function renderScoreboard() {
    const g = S.game, box = $('#scoreboard'); box.innerHTML = '';
    for (let c = 0; c < 4; c++) {
      const el = document.createElement('div');
      el.className = 'sc' + (g.turn === c && !S.over ? ' now' : '');
      const left = E.remaining(g, c);
      el.innerHTML = `<span class="chip"></span><div><p class="sc-name">${esc(controllerName(c))}<span class="sr"> plays ${COLORS[c].name}</span></p>
        <p class="sc-left">${COLORS[c].name}: ${g.out[c] ? '<span class="sc-out">done</span>, ' : ''}${left} left${g.turn === c && !S.over ? ' · <b>turn</b>' : ''}</p></div>`;
      paintChip($('.chip', el), c);
      box.appendChild(el);
    }
  }
  function trayList(c) {
    return PIECES.map((p) => p.idx).filter((p) => !S.game.used[c][p]).sort((a, b) => PIECES[b].size - PIECES[a].size || a - b);
  }
  function renderTray() {
    const g = S.game, c = S.viewColor, tray = $('#tray');
    const list = trayList(c);
    $('#tray-title').textContent = `${COLORS[c].name} pieces left: ${list.length}`;
    tray.innerHTML = '';
    const active = myTurn() && g.turn === c;
    for (const p of list) {
      const b = document.createElement('button');
      b.className = 'piece'; b.type = 'button';
      b.setAttribute('aria-label', pieceLabel(p));
      b.setAttribute('aria-pressed', S.sel && S.sel.p === p ? 'true' : 'false');
      b.disabled = !active;
      b.innerHTML = pieceSvg(PIECES[p].base, c, 5, true);
      b.addEventListener('click', () => selectPiece(p));
      tray.appendChild(b);
    }
  }
  function renderHand() {
    const g = S.game, active = myTurn(), c = g.turn;
    const pv = $('#hand-preview');
    if (active && S.sel) pv.innerHTML = pieceSvg(E.transform(S.sel.p, S.sel.rot, S.sel.flip), c, 5, true);
    else pv.innerHTML = active ? 'Pick a piece' : (S.over ? 'Finished' : 'Waiting');
    $('#btn-rotate').disabled = !(active && S.sel);
    $('#btn-flip').disabled = !(active && S.sel);
    $('#btn-place').disabled = !(active && S.sel && S.cursor);
    $('#btn-hint').disabled = !active;
    $('#btn-undo').hidden = !!S.online;
    $('#btn-undo').disabled = !(active && S.snaps.length >= 2);
  }
  function renderAll() {
    if (!S.game) return;
    renderStatus(); renderScoreboard(); renderHand(); renderTray(); draw();
    canvas.setAttribute('aria-describedby', 'status-main status-sub');
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

  $('#btn-rotate').onclick = rotate; $('#btn-flip').onclick = flip;
  $('#btn-place').onclick = placeNow; $('#btn-hint').onclick = hint; $('#btn-undo').onclick = undo;

  // ---------- game over ----------
  function results() {
    const g = S.game;
    const seatsN = config.mode === 2 ? 2 : config.mode === 3 ? 3 : 4;
    const rows = [];
    for (let i = 0; i < seatsN; i++) {
      const cols = seatColors(i);
      const left = cols.reduce((s, c) => s + E.remaining(g, c), 0);
      const pts = cols.reduce((s, c) => s + E.score(g, c), 0);
      const bonus = cols.filter((c) => E.remaining(g, c) === 0).map((c) => COLORS[c].name + (g.lastPiece[c] === 0 ? ' (+20)' : ' (+15)'));
      rows.push({ seat: i, name: config.seats[i].name, type: config.seats[i].type, level: config.seats[i].level, cols, left, pts, bonus });
    }
    const best = Math.max(...rows.map((r) => r.pts));
    rows.forEach((r) => { r.win = r.pts === best; });
    rows.sort((a, b) => b.pts - a.pts);
    return rows;
  }
  function finish() {
    if (S.over) return;
    S.over = true; S.humanTurn = false;
    const rows = results();
    const secs = Math.round((Date.now() - S.start) / 1000);
    const winners = rows.filter((r) => r.win);
    // record
    const hist = store.get('games', []);
    hist.push({ t: Date.now(), mode: config.mode, secs, players: rows.map((r) => ({ name: r.name, type: r.type, level: r.level, colors: r.cols.map((c) => COLORS[c].name).join('+'), left: r.left, pts: r.pts, win: r.win })) });
    store.set('games', hist.slice(-200));
    renderAll();
    const humanWon = winners.some((w) => w.type === 'human');
    $('#over-title').textContent = winners.length > 1 ? 'It is a tie!' : (winners[0].type === 'human' && winners[0].name === 'You' ? 'You win!' : `${winners[0].name} wins!`);
    $('#over-sub').textContent = `${Math.floor(secs / 60)} min ${secs % 60} sec. Highest score wins.`;
    $('#over-body').innerHTML = `<table><thead><tr><th scope="col">Player</th><th scope="col">Squares left</th><th scope="col">Score</th></tr></thead><tbody>` +
      rows.map((r) => `<tr class="${r.win ? 'win' : ''}"><td>${esc(r.name)}${r.win ? '<span class="tag">winner</span>' : ''}<br><small>${r.cols.map((c) => COLORS[c].name).join(' + ')}${r.bonus.length ? ' · all pieces placed ' + r.bonus.join(', ') : ''}</small></td><td>${r.left}</td><td>${r.pts}</td></tr>`).join('') +
      `</tbody></table>${config.mode === 3 ? '<p class="hint-line">The shared colour, Green, is not counted.</p>' : ''}`;
    say($('#over-title').textContent + ' ' + winners.map((w) => `${w.name} scored ${w.pts}`).join(', ') + '.');
    if (humanWon) { snd.win(); confetti(); } else snd.pass();
    setTimeout(() => { if (S.over) openDlg('dlg-over'); }, 700);
  }
  $('#over-again').onclick = () => {
    $('#dlg-over').close();
    if (S.online) { if (S.online.amHost()) S.online.rematch(); else say('Waiting for the host to set up a new game.'); }
    else startGame();
  };
  $('#over-menu').onclick = () => {
    $('#dlg-over').close();
    if (S.online) { leaveOnline(); show('menu'); } else { S.token++; S.game = null; show('menu'); }
  };

  // ---------- confetti ----------
  function confetti() {
    if (reducedMotion()) return;
    const cv = $('#confetti'), cx = cv.getContext('2d');
    cv.width = innerWidth; cv.height = innerHeight;
    const parts = Array.from({ length: 140 }, () => ({ x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * .5, vx: (Math.random() - .5) * 3, vy: 2 + Math.random() * 4, s: 6 + Math.random() * 8, c: FILL[Math.floor(Math.random() * 4)], r: Math.random() * 6 }));
    let f = 0;
    (function tick() {
      cx.clearRect(0, 0, cv.width, cv.height);
      parts.forEach((p) => { p.x += p.vx; p.y += p.vy; p.r += .1; cx.save(); cx.translate(p.x, p.y); cx.rotate(p.r); cx.fillStyle = p.c; cx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s); cx.restore(); });
      if (++f < 220) requestAnimationFrame(tick); else cx.clearRect(0, 0, cv.width, cv.height);
    })();
  }

  // ---------- stats ----------
  function renderStats() {
    const hist = store.get('games', []);
    const body = $('#stats-body');
    if (!hist.length) { body.innerHTML = '<p class="lead-sm">No games yet. Finish a game and your scores will appear here. They stay on this device only.</p>'; return; }
    const humanRows = [];
    hist.forEach((gm) => gm.players.forEach((p) => { if (p.type === 'human') humanRows.push({ p, gm }); }));
    const wins = humanRows.filter((r) => r.p.win).length;
    const avg = humanRows.length ? Math.round(humanRows.reduce((s, r) => s + r.p.pts, 0) / humanRows.length) : 0;
    const best = humanRows.length ? Math.max(...humanRows.map((r) => r.p.pts)) : 0;
    const avgT = Math.round(hist.reduce((s, g) => s + g.secs, 0) / hist.length / 60);
    body.innerHTML = `<div class="bigstats">
      <div class="bigstat"><b>${hist.length}</b><span>games played</span></div>
      <div class="bigstat"><b>${wins}</b><span>wins by people</span></div>
      <div class="bigstat"><b>${best}</b><span>best score</span></div>
      <div class="bigstat"><b>${avg}</b><span>average score</span></div>
      <div class="bigstat"><b>${avgT} min</b><span>average game</span></div></div>
      <table><thead><tr><th scope="col">When</th><th scope="col">Winner</th><th scope="col">Time</th></tr></thead><tbody>` +
      hist.slice(-10).reverse().map((gm) => { const w = gm.players.filter((p) => p.win).map((p) => `${esc(p.name)} (${p.pts})`).join(', ');
        return `<tr><td>${new Date(gm.t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}<br><small>${gm.mode} players</small></td><td>${w}</td><td>${Math.round(gm.secs / 60)} min</td></tr>`; }).join('') + '</tbody></table>';
  }
  $('#stats-csv').onclick = () => {
    const hist = store.get('games', []);
    const lines = ['date,mode,seconds,player,type,level,colours,squares_left,score,won'];
    hist.forEach((g) => g.players.forEach((p) => lines.push([new Date(g.t).toISOString(), g.mode, g.secs, '"' + p.name.replace(/"/g, '""') + '"', p.type, p.level, p.colors, p.left, p.pts, p.win].join(','))));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = 'cornerstone-games.csv'; a.click();
  };
  $('#stats-clear').onclick = () => { if (confirm('Erase all saved games on this device?')) { store.set('games', []); renderStats(); } };

  // ---------- online play ----------
  let sbClient = null;
  function getSupabaseClient() {
    if (!sbClient) sbClient = window.supabase.createClient(window.CornerstoneSupabaseTransport.URL, window.CornerstoneSupabaseTransport.KEY);
    return sbClient;
  }
  function mirrorConfigFromLobby(room) {
    config.mode = room.lobby.mode;
    config.seats = room.lobby.seats.map((s) => ({
      name: s.name || (s.type === 'bot' ? 'Computer' : 'Waiting…'),
      type: s.type === 'open' ? 'human' : s.type, // an open seat is still "a person's seat", just unfilled
      level: s.level || 'medium'
    }));
  }
  function openOnlineEntry() {
    $('#online-name').value = S.onlineName || (config.seats[0] && config.seats[0].name !== 'Computer' ? config.seats[0].name : '') || 'You';
    $('#online-code').value = '';
    $('#online-error').textContent = '';
    $('#online-status').textContent = 'Enter your name, then create a room or join one with a code.';
    show('online');
  }
  function connectRoom(code, asHost) {
    return new Promise((resolve, reject) => {
      const name = (($('#online-name').value || 'You').trim().slice(0, 14)) || 'You';
      S.onlineName = name;
      const client = getSupabaseClient();
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('timeout')); } }, 12000);
      try {
        window.CornerstoneSupabaseTransport.connect(client, code,
          (transport) => {
            if (settled) return; settled = true; clearTimeout(timer);
            const room = new CornerstoneNet.Room(transport, { code, name, host: asHost, mode: config.mode, engine: E });
            resolve(room);
          },
          (status) => { if (settled) return; settled = true; clearTimeout(timer); reject(new Error(status)); }
        );
      } catch (e) { if (!settled) { settled = true; clearTimeout(timer); reject(e); } }
    });
  }
  async function createRoom() {
    const code = CornerstoneNet.makeCode();
    $('#online-error').textContent = ''; $('#online-status').textContent = 'Creating room ' + code + '…';
    try { enterLobby(await connectRoom(code, true)); }
    catch (e) { $('#online-error').textContent = "Couldn't create a room. Check your connection and try again."; $('#online-status').textContent = ''; }
  }
  async function joinRoom() {
    const code = ($('#online-code').value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 5) { $('#online-error').textContent = 'Room codes are 5 letters or numbers.'; return; }
    $('#online-error').textContent = ''; $('#online-status').textContent = 'Joining room ' + code + '…';
    try {
      const room = await connectRoom(code, false);
      enterLobby(room);
      setTimeout(() => { if (S.online === room && !room.started && room.presence.length < 2) $('#lobby-note').textContent = 'No one else is here yet. Double-check the room code with your friend.'; }, 3500);
    } catch (e) { $('#online-error').textContent = "Couldn't join that room. Check the code and try again."; $('#online-status').textContent = ''; }
  }
  function enterLobby(room) {
    S.online = room;
    room.on('lobby', () => { mirrorConfigFromLobby(room); renderLobby(); });
    room.on('presence', () => renderLobby());
    room.on('start-blocked', () => { $('#lobby-note').textContent = 'Every seat needs a person or Computer before you can start.'; });
    room.on('start', () => { mirrorConfigFromLobby(room); beginOnlineGame(room); });
    room.on('seat-orphaned', () => { if (S.game) { renderOnlineBanner(); renderAll(); } });
    room.on('move', onOnlineMove);
    room.on('resume', () => onlineTick());
    room.on('rematch', () => { mirrorConfigFromLobby(room); S.game = null; S.over = false; renderLobby(); show('lobby'); });
    mirrorConfigFromLobby(room);
    renderLobby();
    show('lobby');
  }
  function renderLobby() {
    const room = S.online; if (!room) return;
    $('#lobby-code').textContent = room.code;
    $$('input[name=lmode]').forEach((i) => { i.checked = +i.value === room.lobby.mode; i.disabled = !room.amHost(); });
    const box = $('#lobby-seats'); box.innerHTML = '';
    room.lobby.seats.forEach((seat, i) => {
      const mine = seat.owner === room.myKey;
      const cols = seatColors(i);
      const el = document.createElement('div'); el.className = 'seat';
      const swatches = cols.map((c) => `<span><svg width="20" height="20" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="${FILL[c]}"/>${settings.shapes ? glyphSvg(c, 5, 5, 2.6) : ''}</svg>${COLORS[c].name}</span>`).join('');
      let body = `<h3>Seat ${i + 1}${mine ? ' — you' : ''}</h3><div class="seat-colors">${swatches}</div>`;
      if (seat.type === 'human' && seat.owner) body += `<p class="hint-line">${esc(seat.name || 'A player')} has this seat.</p>`;
      else if (seat.type === 'bot') body += `<p class="hint-line">Computer (${seat.level === 'easy' ? 'Gentle' : seat.level === 'hard' ? 'Tough' : 'Friendly challenge'})</p>`;
      else body += `<p class="hint-line">Open — waiting for a player.</p>`;
      const actions = [];
      if (!mine && seat.type !== 'human' && !room.started) actions.push(`<button class="btn small" data-claim="${i}">Sit here</button>`);
      if (mine && !room.started && i !== 0) actions.push(`<button class="btn small" data-unclaim="${i}">Give up seat</button>`);
      if (room.amHost() && !room.started) {
        if (seat.type !== 'bot') actions.push(`<button class="btn small" data-setbot="${i}">Set to Computer</button>`);
        else actions.push(`<label style="min-width:9rem">Skill<select data-level="${i}"><option value="easy"${seat.level === 'easy' ? ' selected' : ''}>Gentle</option><option value="medium"${seat.level === 'medium' ? ' selected' : ''}>Friendly</option><option value="hard"${seat.level === 'hard' ? ' selected' : ''}>Tough</option></select></label>`);
        if (seat.type !== 'open' && i !== 0) actions.push(`<button class="btn small" data-setopen="${i}">Clear seat</button>`);
      }
      el.innerHTML = body + (actions.length ? `<div class="row">${actions.join('')}</div>` : '');
      box.appendChild(el);
    });
    $$('#lobby-seats [data-claim]').forEach((b) => (b.onclick = () => room.claimSeat(+b.dataset.claim)));
    $$('#lobby-seats [data-unclaim]').forEach((b) => (b.onclick = () => room.leaveSeat(+b.dataset.unclaim)));
    $$('#lobby-seats [data-setbot]').forEach((b) => (b.onclick = () => room.setSeat(+b.dataset.setbot, { type: 'bot', owner: null, level: 'medium' })));
    $$('#lobby-seats [data-setopen]').forEach((b) => (b.onclick = () => room.setSeat(+b.dataset.setopen, { type: 'open', owner: null, name: '' })));
    $$('#lobby-seats [data-level]').forEach((sel) => (sel.onchange = () => room.setSeat(+sel.dataset.level, { level: sel.value })));
    $('#lobby-start').hidden = !room.amHost();
    $('#lobby-start').disabled = room.lobby.seats.some((s) => s.type === 'open');
    const n = room.presence.length;
    $('#lobby-note').textContent = room.amHost()
      ? `${n} connected. ${room.lobby.seats.some((s) => s.type === 'open') ? 'Fill every seat, or set it to Computer, to start.' : 'Ready to start!'}`
      : `${n} connected. Waiting for the host to start the game.`;
  }
  $$('input[name=lmode]').forEach((i) => i.addEventListener('change', () => { if (S.online && S.online.amHost()) S.online.setMode(+i.value); }));
  $('#lobby-copy').onclick = () => { if (S.online && navigator.clipboard) navigator.clipboard.writeText(S.online.code).catch(() => {}); say('Room code copied.'); };
  $('#lobby-copy-link').onclick = () => { if (!S.online) return; const url = location.href.split('?')[0] + '?room=' + S.online.code; if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {}); say('Invite link copied.'); };
  $('#lobby-start').onclick = () => S.online && S.online.startGame(E);
  $('#lobby-leave').onclick = () => { leaveOnline(); show('menu'); };
  $('#online-back').onclick = () => show('menu');
  $('#online-create').onclick = createRoom;
  $('#online-join').onclick = joinRoom;
  $('#online-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  $('#online-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createRoom(); });
  $('#menu-online').onclick = openOnlineEntry;

  function leaveOnline() {
    if (S.online) { try { S.online.leave(); } catch (e) {} S.online = null; }
    if (S.onlineBotTimer) { clearTimeout(S.onlineBotTimer); S.onlineBotTimer = null; }
    S.game = null; S.over = false; S.running = false; S.token++;
    const saved = store.get('config', null); // undo the in-memory mirroring done for the online lobby
    if (saved) { config.mode = saved.mode; config.seats = saved.seats; }
  }
  function beginOnlineGame(room) {
    S.token++; S.game = room.game; S.sel = null; S.cursor = null; S.locked = false; S.hintMsg = ''; S.banner = '';
    S.over = false; S.start = Date.now(); S.anim = null;
    const mine = room.myColors();
    S.viewColor = mine.length ? mine[0] : 0;
    zoomIdx = 0;
    show('game'); fit(); renderOnlineBanner(); renderAll();
    say('The game has started.');
    onlineTick();
  }
  function renderOnlineBanner() {
    const room = S.online, el = $('#online-banner'); if (!el) return;
    if (!room) { el.hidden = true; return; }
    el.hidden = false;
    const n = room.presence.length, need = room.lobby.seats.length;
    el.className = 'hint-line online-banner' + (n < need ? ' warn' : '');
    el.textContent = `Online room ${room.code} · ${n} of ${need} seats connected` + (n < need ? ' · the computer is filling in for anyone who has disconnected' : '');
  }
  function onOnlineMove(payload) {
    if (S.onlineBotTimer) { clearTimeout(S.onlineBotTimer); S.onlineBotTimer = null; }
    S.sel = null; S.cursor = null; S.locked = false; S.humanTurn = false; S.hintMsg = '';
    if (!payload.pass && !reducedMotion()) { S.anim = { cells: payload.cells, t0: performance.now() }; animate(); }
    renderOnlineBanner(); renderAll();
    if (payload.pass) { snd.pass(); say(`${COLORS[payload.color].name} has no moves left and passes.`); }
    else { snd.bot(); say(`${seatFor(payload.color).name} played the ${pieceLabel(payload.p)} as ${COLORS[payload.color].name}.`, false); }
    onlineTick();
  }
  function onlineTick() {
    const room = S.online, g = S.game;
    if (!room || !g) return;
    if (g.out.every(Boolean)) { finish(); return; }
    const c = g.turn;
    if (g.out[c]) { return; } // shouldn't linger: passes flip out[] and advance turn together
    if (!amActingColor(c)) { S.humanTurn = false; renderAll(); return; }
    if (!E.hasMove(g, c)) { room.proposePass(c); return; }
    const seat = room.seatForColor(c);
    if (seat.type === 'bot') {
      S.humanTurn = false; renderAll();
      if (S.onlineBotTimer) return;
      S.onlineBotTimer = setTimeout(() => {
        S.onlineBotTimer = null;
        if (S.online !== room || S.game !== g) return;
        const mv = E.botChoose(g, c, seat.level);
        if (mv) room.proposeMove(c, mv.p, mv.cells); else room.proposePass(c);
      }, botDelay());
    } else {
      S.humanTurn = true; S.viewColor = c;
      renderAll();
      say(`${seatFor(c).name}, it is your turn. You are ${COLORS[c].name}.`);
      snd.turn();
    }
  }

  // ---------- wiring ----------
  $('#menu-play').onclick = () => { if (S.online) leaveOnline(); renderSetup(); show('setup'); };
  $('#menu-help').onclick = () => openDlg('dlg-help');
  $('#menu-stats').onclick = () => { renderStats(); openDlg('dlg-stats'); };
  $('#menu-settings').onclick = () => { initSettingsUi(); openDlg('dlg-settings'); };
  $('#setup-back').onclick = () => show('menu');
  $('#setup-start').onclick = () => {
    for (let i = 0; i < seatCount(); i++) if (!config.seats[i].name.trim()) config.seats[i].name = config.seats[i].type === 'bot' ? BOT_NAMES[i % 3] : 'Player ' + (i + 1);
    store.set('config', config); startGame();
  };
  $('#game-settings').onclick = () => { initSettingsUi(); openDlg('dlg-settings'); };
  $('#game-menu').onclick = () => {
    if (S.online) {
      if (!S.over && !confirm('Leave this online game? Your seat will be handed to the computer.')) return;
      leaveOnline(); show('menu'); return;
    }
    if (!S.over && !confirm('Leave this game? Your progress will be lost.')) return;
    S.token++; S.game = null; S.running = false; show('menu');
  };
  window.addEventListener('keydown', (e) => {
    if (e.target === canvas || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || !S.game || !myTurn()) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'r' || e.key === 'R') rotate(); else if (e.key === 'f' || e.key === 'F') flip();
  });

  // help figures
  miniFigure($('#fig-yes'), [[0, 0], [1, 0], [2, 1], [2, 2]]);
  miniFigure($('#fig-no'), [[0, 0], [1, 0], [2, 0], [2, 1]]);
  drawLogo();
  applySettings();

  // ?room=CODE deep link (from "Copy invite link") — prefill the join screen, don't auto-join without a name
  (function handleRoomLink() {
    const m = /[?&]room=([A-Z0-9]{5})/i.exec(location.search);
    if (!m) return;
    history.replaceState(null, '', location.pathname);
    openOnlineEntry();
    $('#online-code').value = m[1].toUpperCase();
    setTimeout(() => $('#online-name').focus(), 0);
  })();

  // test hook
  window.__cornerstone = { S, config, startGame };
})();
