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
function makeBus() {
  const peers = [];
  function presenceList() { return peers.filter((p) => p.online).map((p) => ({ key: p.key, joinedAt: p.joinedAt, name: p.meta.name })); }
  function broadcastPresence() { const list = presenceList(); peers.forEach((p) => p.online && p.presenceHandlers.forEach((cb) => cb(list))); }
  return {
    join(key) {
      const p = { key, joinedAt: peers.length, presenceHandlers: [], msgHandlers: [], meta: {}, online: true };
      peers.push(p);
      return {
        myKey: () => key,
        track(meta) { p.meta = meta; broadcastPresence(); },
        onPresence(cb) { p.presenceHandlers.push(cb); if (p.online) cb(presenceList()); },
        onMessage(cb) { p.msgHandlers.push(cb); },
        send(event, payload) { peers.forEach((q) => { if (q.online && q.key !== key) q.msgHandlers.forEach((cb) => cb(event, payload, key)); }); },
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
    const t = bus.join('app-' + (nextKey++));
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
  const peerTransport = bus.join('peer-1');
  const peer = new w.CornerstoneNet.Room(peerTransport, { code: code2, name: 'Friend', engine: w.Cornerstone });
  await sleep(20);
  if (peer.lobby.hostKey === undefined) throw new Error('peer did not receive lobby state from host');
  peer.claimSeat(1);
  await sleep(20);
  if (S.online.lobby.seats[1].owner !== 'peer-1') throw new Error('host did not see the peer claim seat 2');
  console.log('cross-peer join via a real second Room: ok');

  if (errors.length) throw new Error('runtime errors: ' + errors.join('; '));
  console.log('online smoke tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
