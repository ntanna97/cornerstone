/* Four "devices", each a separate copy of the real app (index.html + app.js), connected
   through the simulated network in fakenet.js. Everything is driven through the UI. */
const { JSDOM } = require('jsdom');
const fs = require('fs'), path = require('path');
const { makeNet } = require('./fakenet.js');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script src[^>]*><\/script>/g, '');
const SRC = ['engine.js', 'net.js', 'app.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8'));
const TIMING = { graceLobbyMs: 400, gracePlayMs: 700, helloRetryMs: 50, soloReadyMs: 400, noHostMs: 500, beatMs: 80, resyncThrottleMs: 30, gapMs: 150 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for: ' + what); await sleep(10); } }

function openDevice(net, label, url, session) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: url || 'http://localhost/' });
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  w.HTMLCanvasElement.prototype.getContext = () => ctx;
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  w.scrollTo = () => {}; w.confirm = () => true;
  w.__testFastBots = true; w.__testTiming = TIMING;
  w.localStorage.setItem('cornerstone.settings', JSON.stringify({ sound: false, motion: true }));
  Object.entries(session || {}).forEach(([k, v]) => w.sessionStorage.setItem(k, v));
  w.supabase = { createClient: () => ({}) };
  w.CornerstoneSupabaseTransport = { URL: 'fake', KEY: 'fake', connect(client, code, onReady, onError, opts) { const t = net.join(code, opts.key); setTimeout(() => onReady(t), 5); } };
  SRC.forEach((src) => w.eval(src));
  const $ = (s) => w.document.querySelector(s);
  return { w, $, label, errors, api: w.__cornerstone, dom };
}
const TRACE = new Map();
function trace(d) {
  const r = d.api.S.online; if (!r || r.__traced) return; r.__traced = true;
  const t = []; TRACE.set(d.label, t);
  ['move', 'sync', 'start', 'lobby', 'host', 'resume', 'debug'].forEach((ev) => r.on(ev, (m, local) => t.push(ev + (ev === 'move' ? ` n=${m.n} c=${m.color}${m.pass ? ' PASS' : ''}${local ? ' (mine)' : ''}` : ev === 'debug' ? ' ' + m : '') + ` | moveN=${r.moveN} turn=${r.game ? r.game.turn : '-'} fp=${r.game ? require('../net.js').fingerprint(r.game, r.moveN) : '-'}`)));
}
function type(d, sel, value) { const el = d.$(sel); el.value = value; el.dispatchEvent(new d.w.Event('input')); }
function pressEnter(d, sel) { d.$(sel).dispatchEvent(new d.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
// Play my turns the way a person would: "Suggested move", then "Place piece".
function autoplay(devs) {
  let on = true;
  (async function loop() {
    while (on) {
      for (const d of devs) {
        if (d.closed || d.paused) continue;
        trace(d);
        const S = d.api.S;
        if (S.online && S.humanTurn && !S.over && !d.$('#btn-hint').disabled) {
          d.$('#btn-hint').click();
          if (!d.$('#btn-place').disabled) d.$('#btn-place').click();
        }
      }
      await sleep(6);
    }
  })();
  return () => { on = false; };
}
function resultRows(d) { return Array.from(d.w.document.querySelectorAll('#over-body tbody tr')).map((tr) => tr.textContent.replace(/winner/, '').replace(/\s+/g, ' ').trim()); }
function dump(devs) {
  TRACE.forEach((t, label) => console.log('--- ' + label + ' last events:\n  ' + t.slice(-14).join('\n  ')));
  devs.forEach((d) => { const r = d.api.S.online, S = d.api.S; console.log(d.label, JSON.stringify({ moveN: r.moveN, turn: r.game && r.game.turn, out: r.game && r.game.out.map(Number).join(''), ready: r.ready, host: r.hostKey === r.myKey ? 'ME' : r.hostKey, seat: r.mySeat(), humanTurn: S.humanTurn, over: S.over, same: S.game === r.game, status: d.$('#status-main').textContent, seats: r.lobby.seats.map((x) => x.type + ':' + (x.owner || '').slice(-4) + (x.prevOwner ? '<' + x.prevOwner.slice(-4) : '')) })); });
}
function checkNoErrors(devs) { devs.forEach((d) => { if (d.errors.length) throw new Error(d.label + ' had errors: ' + d.errors.join('; ')); }); }

async function fourDevicesJoinViaInvite(net, names) {
  const host = openDevice(net, names[0]);
  host.$('#menu-online').click();
  type(host, '#online-name', names[0]);
  host.$('#online-create').click();
  await until(() => !host.$('#screen-lobby').hidden && host.$('#lobby-code').textContent.length === 5, 2000, 'host lobby');
  const code = host.$('#lobby-code').textContent;
  const devs = [host];
  for (const n of names.slice(1)) {
    const d = openDevice(net, n, 'http://localhost/?room=' + code); // opened the invite link
    await until(() => !d.$('#screen-online').hidden, 1000, n + ' join screen');
    if (d.$('#online-code').value !== code) throw new Error('invite link should fill in the code');
    if (!d.$('#online-create-box').hidden) throw new Error('invite link page should not offer "Create a room"');
    type(d, '#online-name', n);
    pressEnter(d, '#online-name'); // Enter on the name field joins (it used to create a new room)
    devs.push(d);
    await sleep(20);
  }
  return { code, devs };
}

(async () => {
  // ---------- Test 1: four people, four devices, invite link, full game, one mid-game page reload ----------
  const net = makeNet({ seed: 7 });
  const { code, devs } = await fourDevicesJoinViaInvite(net, ['Neil', 'Alex', 'Bea', 'Cy']);
  const [host] = devs;
  await until(() => devs.every((d) => d.api.S.online && d.api.S.online.mySeat() >= 0), 3000, 'everyone seated automatically');
  await until(() => /Everyone is here/.test(host.$('#lobby-note').textContent), 2000, 'host sees everyone is here');
  if (host.$('#lobby-start').disabled) throw new Error('Start should be enabled with 4 people seated');
  if (!devs[1].$('#lobby-start').hidden) throw new Error('only the host sees Start');
  if (!/You're in!/.test(devs[2].$('#lobby-note').textContent)) throw new Error('joiner should be told they are in: ' + devs[2].$('#lobby-note').textContent);
  if (!/Neil \(you\) \(host\)/.test(host.$('#lobby-people').textContent)) throw new Error('people list: ' + host.$('#lobby-people').textContent);
  console.log('lobby: 4 devices joined via invite link and were seated automatically');

  host.$('#lobby-start').click();
  await until(() => devs.every((d) => !d.$('#screen-game').hidden), 2000, 'game screen on all 4 devices');
  // Each device should show its own colour and "(you)" next to its own name only
  devs.forEach((d, i) => {
    const mine = Array.from(d.w.document.querySelectorAll('.sc-name')).filter((el) => /\(you\)/.test(el.textContent));
    if (mine.length !== 1) throw new Error(d.label + ' should see exactly one "(you)" on the scoreboard, saw ' + mine.length);
  });
  const stop = autoplay(devs);

  // Bea reloads her page mid-game
  await until(() => host.api.S.online.moveN >= 10, 20000, 'some moves');
  const bea = devs[2];
  const session = { 'cornerstone.pid': bea.w.sessionStorage.getItem('cornerstone.pid'), 'cornerstone.activeRoom': bea.w.sessionStorage.getItem('cornerstone.activeRoom') };
  bea.closed = true; net.goOffline(code, JSON.parse(JSON.stringify(session['cornerstone.pid'])).replace(/"/g, ''));
  const bea2 = openDevice(net, 'Bea (reloaded)', 'http://localhost/', session);
  devs[2] = bea2;
  await until(() => bea2.api.S.online && bea2.api.S.online.started && !bea2.$('#screen-game').hidden, 3000, 'Bea back in the game after reload');
  if (bea2.api.S.online.mySeat() !== bea.api.S.online.mySeat()) throw new Error('Bea should have her own seat back after reloading');
  console.log('reload: Bea reloaded mid-game and was put straight back in her own seat');

  try { await until(() => devs.every((d) => d.api.S.over), 30000, 'game over on all 4 devices'); }
  catch (e) {
    TRACE.forEach((t, label) => console.log('--- ' + label + ' last events:\n  ' + t.slice(-14).join('\n  ')));
    devs.forEach((d) => { const r = d.api.S.online, S = d.api.S; console.log(d.label, JSON.stringify({ moveN: r.moveN, turn: r.game && r.game.turn, out: r.game && r.game.out, ready: r.ready, host: r.hostKey, me: r.myKey, seat: r.mySeat(), humanTurn: S.humanTurn, over: S.over, sameGame: S.game === r.game, screen: ['menu','online','lobby','game'].find((x) => !d.$('#screen-' + x).hidden), status: d.$('#status-main').textContent, hint: d.$('#btn-hint').disabled, seats: r.lobby.seats.map((x) => x.type + ':' + x.owner) })); });
    throw e;
  }
  stop();
  await until(() => devs.every((d) => d.$('#dlg-over').hasAttribute('open')), 3000, 'results shown everywhere');
  const rows0 = JSON.stringify(resultRows(devs[0]));
  devs.forEach((d) => { if (JSON.stringify(resultRows(d)) !== rows0) throw new Error(d.label + ' shows different results'); });
  const titles = devs.map((d) => d.$('#over-title').textContent);
  const youWin = titles.filter((t) => /You win|you share/.test(t)).length;
  if (!(youWin >= 1 && youWin <= 4)) throw new Error('someone should see a win on their own device: ' + titles.join(' | '));
  if (!/tie/i.test(titles[0]) && youWin !== 1) throw new Error('without a tie, exactly one device says "You win!": ' + titles.join(' | '));
  console.log('finish: all 4 devices agree on the results; titles: ' + titles.join(' | '));

  // Play again: host rematches, everyone lands back in the room still seated
  host.$('#over-again').click();
  await until(() => devs.every((d) => !d.$('#screen-lobby').hidden), 2000, 'everyone back in the lobby');
  await until(() => devs.every((d) => d.api.S.online.mySeat() >= 0), 2000, 'still seated');
  console.log('rematch: everyone back in the room and still seated');
  checkNoErrors(devs);
  devs.forEach((d) => d.api.leaveOnline());

  // ---------- Test 2: host's device drops mid-game; a computer seat keeps going; host rejoins ----------
  const net2 = makeNet({ seed: 9 });
  const r2 = await fourDevicesJoinViaInvite(net2, ['Neil', 'Alex', 'Bea']);
  const [h2, a2, b2] = r2.devs;
  await until(() => r2.devs.every((d) => d.api.S.online && d.api.S.online.mySeat() >= 0), 3000, 'seated');
  h2.$('[data-setbot="3"]').click();
  await until(() => !h2.$('#lobby-start').disabled, 2000, 'start enabled once seat 4 is the computer');
  h2.$('#lobby-start').click();
  await until(() => r2.devs.every((d) => !d.$('#screen-game').hidden), 2000, 'game on all');
  const stop2 = autoplay(r2.devs);
  await until(() => a2.api.S.online.moveN >= 8, 20000, 'some moves');
  const hs = { 'cornerstone.pid': h2.w.sessionStorage.getItem('cornerstone.pid'), 'cornerstone.activeRoom': h2.w.sessionStorage.getItem('cornerstone.activeRoom') };
  h2.closed = true; net2.goOffline(r2.code, JSON.parse(hs['cornerstone.pid']));
  await until(() => /Waiting for Neil to reconnect|Neil/.test(a2.$('#online-banner').textContent), 2000, 'others are told Neil dropped');
  await until(() => a2.api.S.online.amHost(), 2000, 'Alex takes over hosting');
  const at = a2.api.S.online.moveN;
  await until(() => a2.api.S.online.moveN > at + 2, 20000, 'game keeps going (computer seat now run by Alex)');
  const h2b = openDevice(net2, 'Neil (reloaded)', 'http://localhost/', hs);
  r2.devs[0] = h2b;
  await until(() => h2b.api.S.online && h2b.api.S.online.started && !h2b.$('#screen-game').hidden, 3000, 'Neil back');
  try { await until(() => r2.devs.every((d) => d.api.S.over), 30000, 'game over'); } catch (e) { dump(r2.devs); throw e; }
  stop2();
  const rowsA = JSON.stringify(resultRows(r2.devs[1]));
  r2.devs.forEach((d) => { if (JSON.stringify(resultRows(d)) !== rowsA) throw new Error(d.label + ' disagrees on results'); });
  console.log('host drop: computer seat kept playing under a new host, Neil rejoined, all devices agree');
  checkNoErrors(r2.devs);
  r2.devs.forEach((d) => d.api.leaveOnline());

  // ---------- Undo online: Alex takes back a move; the computer moves after it are taken back too ----------
  const net5 = makeNet({ seed: 21 });
  const r5 = await fourDevicesJoinViaInvite(net5, ['Neil', 'Alex']);
  const [n5, a5] = r5.devs;
  await until(() => a5.api.S.online && a5.api.S.online.mySeat() === 1, 3000, 'Alex seated');
  await until(() => !n5.$('#lobby-seats [data-setbot="2"]') === false, 2000, 'seat buttons');
  n5.$('[data-setbot="2"]').click(); await sleep(30); n5.$('[data-setbot="3"]').click();
  await until(() => !n5.$('#lobby-start').disabled, 2000, 'start enabled');
  n5.$('#lobby-start').click();
  await until(() => r5.devs.every((d) => !d.$('#screen-game').hidden), 2000, 'game on');
  let undoDone = false;
  const stop5 = autoplay(r5.devs);
  // let the game run until Alex has placed 10 pieces, then take over Alex's next turn by hand
  a5.paused = true;
  await until(() => { const S = a5.api.S; if (S.humanTurn && S.game.placed[1] < 10) { a5.$('#btn-hint').click(); a5.$('#btn-place').click(); } return S.humanTurn && S.game.placed[1] >= 10; }, 40000, 'Alex reaches 10 pieces');
  n5.paused = true; // Neil waits, so only computer players move after Alex
  const A = a5.api.S, before = A.game.placed[1];
  a5.$('#btn-hint').click(); a5.$('#btn-place').click();
  if (a5.$('#btn-undo').disabled) throw new Error('Alex should be offered Undo right after placing his 11th piece');
  await until(() => A.online.game.turn === 0 || A.online.game.out[0], 3000, 'computer players moved');
  a5.$('#btn-undo').click();
  await until(() => A.online.game.placed[1] === before && A.online.game.turn === 1 && A.humanTurn && A.sel, 3000, "Alex's piece is back and it's his turn");
  const NS = n5.api.S;
  await until(() => NS.online.moveN === A.online.moveN && require('../net.js').fingerprint(NS.game, NS.online.moveN) === require('../net.js').fingerprint(A.game, A.online.moveN), 3000, "Neil's board matches");
  undoDone = true;
  console.log('undo online: Alex took back his move (and the computer moves after it) on both devices');
  n5.paused = false; a5.paused = false;
  await until(() => r5.devs.every((d) => d.api.S.over), 60000, 'game over after undo');
  stop5();
  if (JSON.stringify(resultRows(r5.devs[0])) !== JSON.stringify(resultRows(r5.devs[1]))) throw new Error('devices disagree after undo');
  checkNoErrors(r5.devs); r5.devs.forEach((d) => d.api.leaveOnline());

  // ---------- Test 3: a wrong code says so instead of spinning forever ----------
  const net3 = makeNet({ seed: 3 });
  const lone = openDevice(net3, 'Lone');
  lone.$('#menu-online').click(); type(lone, '#online-name', 'Pat'); type(lone, '#online-code', 'ZZZZZ'); lone.$('#online-join').click();
  await until(() => /No one seems to be in room ZZZZZ/.test(lone.$('#lobby-note').textContent), 3000, 'wrong-code message');
  // and a missing name is caught before connecting
  const n4 = openDevice(net3, 'NoName'); n4.$('#menu-online').click(); type(n4, '#online-name', ''); n4.$('#online-create').click();
  if (!/type your name/i.test(n4.$('#online-error').textContent)) throw new Error('should ask for a name');
  console.log('errors: wrong room code and missing name are explained');
  checkNoErrors([lone, n4]); lone.api.leaveOnline();

  console.log('online smoke tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
