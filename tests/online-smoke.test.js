const { JSDOM } = require('jsdom');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script src[^>]*><\/script>/g, '');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window;
const errors = [];
w.addEventListener('error', (e) => errors.push(e.message));

const ctxStub = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
w.scrollTo = () => {}; w.confirm = () => true;
w.navigator.clipboard = { writeText: () => Promise.resolve() };

// ---- fake realtime bus, shared between "app" (host, run through app.js) and a raw Room peer we drive by hand ----
// Delivery is deferred a tick (setTimeout 0), like a real network round-trip — a fully synchronous
// fake bus previously masked a race where the UI read room.lobby before the host's data had arrived.
// Partitioned by room code, exactly like real Supabase channels (`cornerstone-room-<CODE>`) are
// isolated from each other — without this, a leftover room from an earlier scenario in the same
// test run could leak its broadcasts into an unrelated later room.
function makeBus() {
  const rooms = new Map(); // code -> peers[]
  function peersFor(code) { if (!rooms.has(code)) rooms.set(code, []); return rooms.get(code); }
  return {
    join(code, key) {
      const peers = peersFor(code);
      function presenceList() { return peers.filter((p) => p.online).map((p) => ({ key: p.key, joinedAt: p.joinedAt, name: p.meta.name })); }
      function broadcastPresence() {
        const list = presenceList();
        peers.forEach((p) => { if (p.online) setTimeout(() => p.presenceHandlers.forEach((cb) => cb(list)), 0); });
      }
      const p = { key, joinedAt: peers.length, presenceHandlers: [], msgHandlers: [], meta: {}, online: true };
      peers.push(p);
      return {
        myKey: () => key,
        track(meta) { p.meta = meta; broadcastPresence(); },
        onPresence(cb) { p.presenceHandlers.push(cb); if (p.online) setTimeout(() => cb(presenceList()), 0); },
        onMessage(cb) { p.msgHandlers.push(cb); },
        send(event, payload) { peers.forEach((q) => { if (q.online && q.key !== key) setTimeout(() => q.msgHandlers.forEach((cb) => cb(event, payload, key)), 0); }); },
        leave() { p.online = false; broadcastPresence(); }
      };
    }
  };
}
const bus = makeBus();
let nextKey = 0;
w.__testFastBots = true;
w.supabase = { createClient: () => ({}) };
w.CornerstoneSupabaseTransport = {
  URL: 'fake', KEY: 'fake',
  connect(client, code, onReady, onError) {
    const t = bus.join(code, 'app-' + (nextKey++));
    setTimeout(() => onReady(t), 0);
  }
};

w.eval(fs.readFileSync(path.join(root, 'engine.js'), 'utf8'));
w.eval(fs.readFileSync(path.join(root, 'net.js'), 'utf8'));
w.eval(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));

const $ = (s) => w.document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  w.localStorage.setItem('cornerstone.settings', JSON.stringify({ speed: 'fast', sound: false, motion: true }));

  // menu -> online entry -> create a 4-player room, host + 3 bots
  $('#menu-online').click();
  if ($('#screen-online').hidden) throw new Error('online screen not shown');
  $('#online-name').value = 'You';
  $('#online-create').click();
  await sleep(50);
  if ($('#screen-lobby').hidden) throw new Error('lobby screen not shown after create');
  const roomCode = $('#lobby-code').textContent;
  if (roomCode.length !== 5) throw new Error('bad room code: ' + roomCode);

  // set the other three seats to Computer from the host UI
  [1, 2, 3].forEach((i) => { const b = w.document.querySelector(`[data-setbot="${i}"]`); if (!b) throw new Error('no set-bot button for seat ' + i); b.click(); });
  if ($('#lobby-start').disabled) throw new Error('start should be enabled once every seat has an occupant');
  $('#lobby-start').click();
  await sleep(50);
  if ($('#screen-game').hidden) throw new Error('game screen not shown after start');

  const api = w.__cornerstone, S = api.S;
  if (!S.online) throw new Error('S.online not set');
  if ($('#online-banner').hidden) throw new Error('online banner should show');

  // play the whole game via hint + place whenever it's our turn; bots run themselves
  let guard = 0, lastLog = 0, lastPlaced = null;
  while (!S.over && guard++ < 8000) {
    if (S.humanTurn && !$('#btn-hint').disabled) { $('#btn-hint').click(); if (!$('#btn-place').disabled) $('#btn-place').click(); }
    if (guard - lastLog > 500) {
      lastLog = guard;
      const p = S.game.placed.slice();
      const stuck = lastPlaced && JSON.stringify(p) === JSON.stringify(lastPlaced);
      console.log('guard', guard, 'turn', S.game.turn, 'out', S.game.out, 'humanTurn', S.humanTurn, 'sel', !!S.sel, 'cursor', !!S.cursor, 'botTimer', !!S.onlineBotTimer, 'placed', p, stuck ? 'STUCK' : '');
      lastPlaced = p;
    }
    await sleep(2);
  }
  if (!S.over) throw new Error('online game did not finish, guard=' + guard);
  await sleep(900);
  if (!$('#dlg-over').hasAttribute('open')) throw new Error('results dialog not open');
  console.log('online 4p vs bots finished:', $('#over-title').textContent);

  // rematch as host: should return to the lobby with the same seats, then play a short 2-player game
  $('#over-again').click();
  await sleep(30);
  if ($('#screen-lobby').hidden) throw new Error('rematch should return host to the lobby');
  w.document.querySelector('input[name=lmode][value="2"]').checked = true;
  w.document.querySelector('input[name=lmode][value="2"]').dispatchEvent(new w.Event('change'));
  await sleep(20);
  const bot1 = w.document.querySelector('[data-setbot="1"]');
  if (!bot1) throw new Error('expected a seat 2 in 2-player mode');
  bot1.click();
  $('#lobby-start').click();
  await sleep(30);
  guard = 0;
  while (!S.over && guard++ < 4000) {
    if (S.humanTurn && !$('#btn-hint').disabled) { $('#btn-hint').click(); if (!$('#btn-place').disabled) $('#btn-place').click(); }
    await sleep(5);
  }
  if (!S.over) throw new Error('2p rematch did not finish, guard=' + guard);
  console.log('rematch finished:', $('#over-title').textContent);

  // leaving online play restores the local (non-mirrored) config
  $('#over-menu').click();
  await sleep(20);
  if (S.online) throw new Error('S.online should be cleared after leaving');
  if ($('#screen-menu').hidden) throw new Error('should be back at the main menu');

  // a second, independent peer can join the same room code and see the lobby (host must create a fresh room first)
  $('#menu-online').click();
  $('#online-name').value = 'You';
  $('#online-create').click();
  await sleep(30);
  const code2 = $('#lobby-code').textContent;
  const peerTransport = bus.join(code2, 'peer-1');
  const peer = new w.CornerstoneNet.Room(peerTransport, { code: code2, name: 'Friend', engine: w.Cornerstone });
  await sleep(20);
  if (peer.lobby.hostKey === undefined) throw new Error('peer did not receive lobby state from host');
  peer.claimSeat(1);
  await sleep(20);
  if (S.online.lobby.seats[1].owner !== 'peer-1') throw new Error('host did not see the peer claim seat 2');
  console.log('cross-peer join via a real second Room: ok');

  // --- regression test: the actual bug reported in production ---
  // A synchronous fake bus (like the one above, pre-fix) delivers the host's lobby data to a
  // joiner in the same tick a room is constructed, which hid a real race: over an actual
  // network, a joiner's `room.lobby` is still null for a few ticks after connecting, while the
  // UI waited for the host's first broadcast. The old code read `room.lobby.mode` immediately
  // on connect and crashed with "null is not an object (evaluating 'room.lobby.mode')" on any
  // real network. This drives the join through a SECOND real app.js window, with delivery
  // deferred over multiple setTimeout(0) hops, to reproduce that latency honestly.
  $('#menu-online').click();
  $('#online-name').value = 'You';
  $('#online-create').click();
  await sleep(30);
  const raceCode = $('#lobby-code').textContent;

  const html2 = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script src[^>]*><\/script>/g, '');
  const dom2 = new JSDOM(html2, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w2 = dom2.window;
  const errors2 = [];
  w2.addEventListener('error', (e) => errors2.push(e.message));
  w2.HTMLCanvasElement.prototype.getContext = () => ctxStub;
  w2.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w2.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  w2.scrollTo = () => {}; w2.confirm = () => true;
  w2.navigator.clipboard = { writeText: () => Promise.resolve() };
  w2.__testFastBots = true;
  w2.supabase = { createClient: () => ({}) };
  w2.CornerstoneSupabaseTransport = {
    URL: 'fake', KEY: 'fake',
    connect(client, code, onReady) {
      const t = bus.join(code, 'joiner-' + (nextKey++));
      setTimeout(() => onReady(t), 0); // this hop, plus the bus's own, is the latency that exposed the bug
    }
  };
  w2.eval(fs.readFileSync(path.join(root, 'engine.js'), 'utf8'));
  w2.eval(fs.readFileSync(path.join(root, 'net.js'), 'utf8'));
  w2.eval(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
  const $2 = (s) => w2.document.querySelector(s);

  $2('#menu-online').click();
  $2('#online-name').value = 'Friend';
  $2('#online-code').value = raceCode;
  $2('#online-join').click();
  await sleep(80); // generous: covers connect -> Room construction -> presence -> host's lobby reply
  if (errors2.length) throw new Error('joining over real network latency crashed: ' + errors2.join('; '));
  if ($2('#online-error').textContent) throw new Error('joiner should not see a connection error, got: ' + $2('#online-error').textContent);
  if ($2('#screen-lobby').hidden) throw new Error('joiner should have reached the lobby screen');
  if ($2('#lobby-code').textContent !== raceCode) throw new Error('joiner lobby should show the room code ' + raceCode);
  if (!w2.__cornerstone.S.online || !w2.__cornerstone.S.online.lobby) throw new Error('joiner should have the host lobby state by now');
  console.log('joining over real network latency does not crash on room.lobby: ok');

  if (errors.length) throw new Error('runtime errors: ' + errors.join('; '));
  console.log('online smoke tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
