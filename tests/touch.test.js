/* Phone-size touch test in a real (headless) Chromium: tap-to-snap, dragging the piece, panning the close-up,
   hold-to-repeat arrows, hide/show, the game menu, and a whole game played with taps alone.
   Optional (large download):  npm i --no-save @sparticuz/chromium@131 puppeteer-core@23  then  node tests/touch.test.js */
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => { const u = decodeURIComponent(req.url.split('?')[0]); const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(d); }); }).listen(8766);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) fails++; };
(async () => {
  const b = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
  const p = await b.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.setViewport({ width: 390, height: 664, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await p.evaluateOnNewDocument(() => { window.__testFastBots = true; });
  await p.evaluateOnNewDocument(() => { if (!localStorage.getItem('cornerstone.settings')) localStorage.setItem('cornerstone.settings', JSON.stringify({ text: 'large', sound: false, motion: true, speed: 'fast' })); });
  await p.goto('http://localhost:8766/', { waitUntil: 'domcontentloaded' }); await sleep(500);
  await p.tap('#menu-play'); await sleep(200); await p.tap('#setup-start'); await sleep(600);
  const S = () => p.evaluate(() => { const s = window.__cornerstone.S, w = document.querySelector('#boardwrap');
    return { cell: s.cell, closeUp: s.closeUp, cursor: s.cursor, sel: s.sel && { p: s.sel.p, rot: s.sel.rot, flip: s.sel.flip }, humanTurn: s.humanTurn, over: s.over,
      sl: w.scrollLeft, st: w.scrollTop, status: document.querySelector('#status-main').textContent, handShown: getComputedStyle(document.querySelector('#hand')).display !== 'none',
      bodyHidden: document.querySelector('#hand-body').hidden, boardH: Math.round(w.getBoundingClientRect().height), boardTop: Math.round(w.getBoundingClientRect().top),
      canvasW: Math.round(document.querySelector('#board').getBoundingClientRect().width), wrapW: Math.round(w.clientWidth), wrapH: Math.round(w.clientHeight),
      piecesShown: getComputedStyle(document.querySelector('.tray')).display !== 'none', pageH: document.documentElement.scrollHeight,
      scrollY: Math.round(window.scrollY), scoresTop: Math.round(document.querySelector('.scoreboard').getBoundingClientRect().top),
      statusBottom: Math.round(document.querySelector('#status').getBoundingClientRect().bottom),
      trayBottom: Math.round(document.querySelector('.tray').getBoundingClientRect().bottom),
      trayV: [document.querySelector('#tray').scrollHeight, document.querySelector('#tray').clientHeight] }; });
  // screen position of a board square
  const sq = (x, y) => p.evaluate((x, y) => { const c = document.querySelector('#board').getBoundingClientRect(), n = window.__cornerstone.S.cell; return { x: c.left + (x + .5) * n, y: c.top + (y + .5) * n }; }, x, y);

  // 1. picking a piece shows it on the whole board, in a spot where it fits; the view does NOT change by itself
  let s0 = await S();
  ok(s0.canvasW >= Math.min(s0.wrapW, s0.wrapH) - 12, `the board fills its space (${s0.canvasW}px in a ${s0.wrapW}x${s0.wrapH} area, ${s0.cell}px squares)`);
  ok(s0.scoresTop >= 0 && s0.scoresTop < 16 && s0.statusBottom <= 4, `the game opens with the players at the top; menu/status/zoom are just above (players at ${s0.scoresTop}px, status ends at ${s0.statusBottom}px)`);
  ok(s0.piecesShown && s0.handShown && s0.trayBottom <= 664, `players, board, controls row and pieces row all on screen (pieces end at ${s0.trayBottom}px of 664)`);
  ok(s0.trayV[0] <= s0.trayV[1], `the pieces row never scrolls up and down (content ${s0.trayV[0]}px in a ${s0.trayV[1]}px bar)`);
  await p.tap('#tray .piece'); await sleep(300);
  let s = await S();
  ok(!s.closeUp && s.cell === s0.cell && s.sl === s0.sl && s.st === s0.st, `picking a piece leaves the view alone (still the whole board, ${s.cell}px squares)`);
  ok(s.boardH === s0.boardH && s.boardTop === s0.boardTop, `the board does not move or resize when a piece is picked (${s0.boardTop}/${s0.boardH} -> ${s.boardTop}/${s.boardH})`);
  ok(/fits/.test(s.status), `the piece starts in a spot where it fits ("${s.status}")`);

  // 2. on the whole board, a sloppy tap one square off a legal spot still snaps into place
  await p.evaluate(() => { const S = window.__cornerstone.S; S.cursor = { x: 5, y: 12 }; }); // move the ghost somewhere illegal first
  let t = await sq(17, 2); await p.touchscreen.tap(t.x, t.y); await sleep(250); s = await S();
  ok(/fits/.test(s.status), `imprecise tap near the corner snaps to a legal spot ("${s.status}", now at ${JSON.stringify(s.cursor)})`);

  // 3. zoom only when the player asks for it; then drag the piece with a finger
  await p.tap('#view-toggle'); await sleep(250); s = await S();
  ok(s.closeUp && s.cell >= 28, `pressing Zoom in zooms in (${s.cell}px squares)`);
  const g0 = s.cursor;
  const ghost = await p.evaluate(() => { const S = window.__cornerstone.S; return null; });
  const cellOnGhost = await p.evaluate(() => { const E = window.Cornerstone, S = window.__cornerstone.S, o = E.transform(S.sel.p, S.sel.rot, S.sel.flip);
    const w = Math.max(...o.map((q) => q[0])) + 1, h = Math.max(...o.map((q) => q[1])) + 1, ox = S.cursor.x - Math.floor(w / 2), oy = S.cursor.y - Math.floor(h / 2);
    return { x: o[0][0] + ox, y: o[0][1] + oy }; });
  t = await sq(cellOnGhost.x, cellOnGhost.y);
  await p.touchscreen.touchStart(t.x, t.y);
  for (let i = 1; i <= 6; i++) { await p.touchscreen.touchMove(t.x - i * s.cell / 2, t.y + i * s.cell / 2); await sleep(20); }
  await p.touchscreen.touchEnd(); await sleep(200); s = await S();
  ok(s.cursor.x === g0.x - 3 && s.cursor.y === g0.y + 3, `dragging the piece moves it with the finger (${JSON.stringify(g0)} -> ${JSON.stringify(s.cursor)}, expected 3 left, 3 down)`);

  // 4. swiping on an empty part of the close-up scrolls the view instead
  const before = { sl: s.sl, st: s.st };
  t = await p.$eval('#boardwrap', (w) => { const r = w.getBoundingClientRect(); return { x: r.left + 40, y: r.bottom - 40 }; }); // a visible spot away from the piece
  await p.touchscreen.touchStart(t.x, t.y);
  for (let i = 1; i <= 6; i++) { await p.touchscreen.touchMove(t.x + i * 15, t.y - i * 15); await sleep(20); }
  await p.touchscreen.touchEnd(); await sleep(150); s = await S();
  ok(s.sl !== before.sl || s.st !== before.st, `swiping elsewhere on the board looks around (scroll ${before.sl},${before.st} -> ${s.sl},${s.st})`);
  ok(s.cursor.x === g0.x - 3, 'swiping the view did not move the piece');

  // 5. press and hold an arrow to keep moving
  const c0 = s.cursor;
  const r = await p.$eval('#dpad-left', (e) => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await p.touchscreen.touchStart(r.x, r.y); await sleep(1100); await p.touchscreen.touchEnd(); await sleep(100); s = await S();
  ok(c0.x - s.cursor.x >= 4, `holding ◀ for a second keeps moving (${c0.x} -> ${s.cursor.x})`);
  await p.tap('#dpad-right'); await sleep(100); const s2 = await S();
  ok(s2.cursor.x === s.cursor.x + 1, 'a single tap on ▶ moves exactly one square');

  // 6. Hide / Show the controls; menu dialog
  await p.tap('#hand-toggle'); await sleep(250); s = await S();
  ok(s.bodyHidden && /Show/.test(await p.$eval('#hand-toggle', (e) => e.textContent)), 'Hide folds the controls away, leaving a Show button');
  await p.tap('#hand-toggle'); await sleep(250); s = await S();
  ok(!s.bodyHidden, 'Show brings the controls back');
  await p.tap('#game-menu'); await sleep(150);
  ok(await p.$eval('#dlg-menu', (d) => d.open), 'Menu opens the game menu');
  await p.tap('#dlg-menu [data-close]'); await sleep(150);
  ok(!(await p.$eval('#dlg-menu', (d) => d.open)), '"Back to the game" closes it');

  // 7. play the whole game with taps only: pick a piece that fits, then Place
  let turns = 0;
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    s = await S(); if (s.over) break;
    if (!s.humanTurn) { await sleep(40); continue; }
    if (s.sel && /fits/.test(s.status)) { await p.tap('#btn-place'); turns++; await sleep(120); continue; } // a piece is picked and fits: place it
    const idx = await p.evaluate(() => Array.from(document.querySelectorAll('#tray .piece')).findIndex((b) => !b.classList.contains('nofit') && !b.disabled));
    if (idx < 0) { await sleep(40); continue; }
    const before = await S();
    const pieces = await p.$$('#tray .piece'); await pieces[idx].tap(); await sleep(120);
    const mid = await S();
    const placeDisabled = await p.$eval('#btn-place', (e) => e.disabled);
    await p.tap('#btn-place'); await sleep(120); turns++;
    s = await S();
    if (s.humanTurn && JSON.stringify(s.sel) === JSON.stringify(mid.sel) && mid.sel) { console.log('STUCK turn', turns, 'idx', idx, 'status', mid.status, 'placeDisabled', placeDisabled, 'sel', JSON.stringify(mid.sel), 'cursor', JSON.stringify(mid.cursor), 'after', s.status); break; }
  }
  s = await S();
  ok(s.over, `a full game played with taps alone reaches the end (${turns} turns)`);
  ok(s.closeUp, 'the zoom the player chose stays through every move (nothing zooms by itself)');
  await p.reload({ waitUntil: 'domcontentloaded' }); await sleep(400);
  ok(await p.evaluate(() => window.__cornerstone.S.closeUp), 'the zoom choice is remembered after a reload');
  await p.tap('#menu-play'); await sleep(200); await p.tap('#setup-start'); await sleep(500);
  await p.tap('#view-toggle'); await sleep(200);
  const z = await S(); ok(!z.closeUp && z.cell < 20, `pressing Zoom out returns to the whole board (${z.cell}px squares)`);
  await p.tap('#tray .piece'); await sleep(300);
  const z2 = await S(); ok(!z2.closeUp && /fits/.test(z2.status), 'and picking a piece still does not zoom');
  ok(errors.length === 0, 'no errors on the page' + (errors.length ? ': ' + errors.join('; ') : ''));
  await b.close(); server.close();
  console.log(fails ? fails + ' FAILED' : 'touch tests passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERR', e.stack); process.exit(1); });
