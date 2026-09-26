/* Online protocol tests: simulated devices on a realistic fake network. */
const assert = require('assert');
const E = require('../engine.js');
const Net = require('../net.js');
const { makeNet } = require('./fakenet.js');

const TIMING = { graceLobbyMs: 300, gracePlayMs: 400, helloRetryMs: 40, soloReadyMs: 250, noHostMs: 300, beatMs: 60, resyncThrottleMs: 20 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for: ' + what); await sleep(5); }
}

// A "device": a Room plus the same turn-taking behaviour the app has (event-driven, no polling).
function device(net, code, key, name, extra) {
  const room = new Net.Room(net.join(code, key), Object.assign({ code, name, engine: E, timing: TIMING }, extra || {}));
  let timer = null;
  const act = () => {
    if (room.dead || !room.started) return;
    const g = room.game; if (g.out.every(Boolean)) return;
    const c = g.turn;
    if (!room.actingColors().includes(c)) return;
    if (room.botsOnly && room.seatForColor(c).type === 'human') return; // test controls this person's moves by hand
    if (extra && extra.beforeAct) extra.beforeAct(room, g, c);
    if (!E.hasMove(g, c)) room.proposePass(c);
    else { const mv = E.botChoose(g, c, 'easy'); room.proposeMove(c, mv.p, mv.cells); }
  };
  // instant: react synchronously inside the event, with no guard, exactly like the app's onlineTick.
  // When it's my turn again straight after my own move (everyone else is out), the next move is
  // proposed from inside the notification for the previous one. That exposed a real ordering bug.
  const tick = (extra && extra.instant) ? () => act()
    : () => {
      if (timer || room.dead) return;
      timer = setTimeout(() => { timer = null; act(); tick(); }, 3);
    };
  ['move', 'start', 'sync', 'resume', 'host', 'lobby'].forEach((ev) => room.on(ev, tick));
  room.kill = () => { room.dead = true; };
  return room;
}
const fp = (r) => Net.fingerprint(r.game, r.moveN);
const finished = (r) => r.started && r.game.out.every(Boolean);
async function finishAll(rooms, ms, what) {
  await until(() => rooms.every(finished), ms || 20000, what || 'game to finish on every device');
  await until(() => rooms.every((r) => r.moveN === rooms[0].moveN), 3000, 'everyone to agree on the move count');
  // a correction for a conflict on the very last move may still be on its way: allow it to land, then insist on agreement
  try { await until(() => rooms.every((r) => fp(r) === fp(rooms[0])), 3000, 'boards to converge'); } catch (e) {}
  const f = fp(rooms[0]);
  rooms.forEach((r, i) => assert.strictEqual(fp(r), f, 'device ' + i + ' ended with a different board'));
}
function closeAll(rooms) { rooms.forEach((r) => { r.kill && r.kill(); try { r.leave(); } catch (e) {} }); }

async function fourDeviceLobby(seed, mode) {
  const net = makeNet({ seed });
  const code = 'ROOM' + seed;
  const host = device(net, code, 'k-host', 'Neil', { host: true, mode: mode || 4 });
  const others = [];
  for (const [k, n] of [['k-a', 'Alex'], ['k-b', 'Bea'], ['k-c', 'Cy']].slice(0, (mode || 4) - 1)) { others.push(device(net, code, k, n)); await sleep(15); }
  const all = [host, ...others];
  await until(() => all.every((r) => r.lobby && r.mySeat() >= 0), 3000, 'everyone to be seated automatically');
  await until(() => all.every((r) => r.lobby.rev === host.lobby.rev), 3000, 'lobby to agree everywhere');
  return { net, code, host, others, all };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('4 devices: joiners are seated automatically, distinct seats, host is the creator', async () => {
  const { all, host } = await fourDeviceLobby(11);
  const seats = all.map((r) => r.mySeat()).sort();
  assert.deepStrictEqual(seats, [0, 1, 2, 3]);
  all.forEach((r) => assert.strictEqual(r.hostKey, 'k-host', 'everyone agrees who the host is'));
  assert.strictEqual(host.lobby.seats[1].name, 'Alex');
  closeAll(all);
});

test('4 devices play a whole game to the end and finish with identical boards (several network seeds)', async () => {
  for (const seed of [21, 22, 23]) {
    const { all, host } = await fourDeviceLobby(seed);
    host.startGame();
    await until(() => all.every((r) => r.started), 3000, 'game to start everywhere');
    await finishAll(all);
    closeAll(all);
  }
});

test('players who react instantly (like the app does) still keep every device in sync', async () => {
  for (const seed of [24, 25]) {
    const net = makeNet({ seed });
    const code = 'INST' + seed;
    const host = device(net, code, 'k-host', 'Neil', { host: true, instant: true });
    const others = [];
    for (const [k, n] of [['k-a', 'Alex'], ['k-b', 'Bea'], ['k-c', 'Cy']]) { others.push(device(net, code, k, n, { instant: true })); await sleep(15); }
    const all = [host, ...others];
    await until(() => all.every((r) => r.mySeat() >= 0), 3000, 'seated');
    let resyncs = 0; all.forEach((r) => r.on('sync', () => resyncs++));
    host.startGame();
    await finishAll(all);
    assert.strictEqual(resyncs, 0, 'a clean game needs no corrections (got ' + resyncs + ')');
    closeAll(all);
  }
});

test('two different moves for the same turn (a reloaded tab racing its old self): everyone converges and play continues', async () => {
  for (const seed of [171, 172, 173]) {
    const net = makeNet({ seed, maxDelay: 25 });
    const code = 'DUAL' + seed;
    const host = device(net, code, 'k-host', 'Neil', { host: true, instant: true });
    const a = device(net, code, 'k-a', 'Alex', { instant: true });
    const b = device(net, code, 'k-b', 'Bea', { instant: true });
    const c = device(net, code, 'k-c', 'Cy', { instant: true });
    const all = [host, a, b, c];
    await until(() => all.every((r) => r.mySeat() >= 0), 3000, 'seated');
    const seatA = a.mySeat();
    a.kill(); // take manual control of Alex's colour for the conflicting turn
    host.startGame();
    await until(() => a.started && a.game.turn === seatA && a.moveN === seatA, 5000, "Alex's first turn");
    const g = a.game;
    const moves = E.legalMoves(g, seatA);
    const m1 = moves[0], m2 = moves.find((m) => m.p !== m1.p);
    // the "old tab" sends one move for this turn...
    const ghost = net.join(code, 'k-a-old');
    const alt = E.cloneGame(g); E.apply(alt, seatA, m2.p, m2.cells); alt.turn = (seatA + 1) % 4; alt.meta.last = null;
    ghost.send('move', { gid: a.lobby.gameId, n: a.moveN + 1, color: seatA, p: m2.p, cells: m2.cells, h: Net.fingerprint(alt, a.moveN + 1) });
    // ...and the reloaded tab sends a different one at the same moment
    a.proposeMove(seatA, m1.p, m1.cells);
    a.dead = false; // hand Alex back to normal play
    await finishAll(all, 20000, 'game to finish after the conflicting moves (seed ' + seed + ')');
    closeAll(all); try { ghost.leave(); } catch (e) {}
  }
});

test("a device whose board silently drifted is corrected, and the host still takes its own turn right after", async () => {
  const net = makeNet({ seed: 181 });
  const code = 'DRIFT';
  let drifted = false;
  const host = device(net, code, 'k-host', 'Neil', { host: true, instant: true });
  const others = [];
  for (const [k, n] of [['k-a', 'Alex'], ['k-b', 'Bea'], ['k-c', 'Cy']]) { others.push(device(net, code, k, n, { instant: true, beforeAct: (room, g, c) => {
    // the seat just before the host (colour 3) drifts once, right before it moves: the move is legal
    // everywhere but its board fingerprint won't match, and the next turn is the host's
    if (c === 3 && !drifted && room.moveN >= 8) { drifted = true; g.meta.sharedCount = 99; }
  } })); await sleep(15); }
  const all = [host, ...others];
  await until(() => all.every((r) => r.mySeat() >= 0), 3000, 'seated');
  await until(() => all.every((r) => r.lobby.seats[3].owner && r.lobby.rev === host.lobby.rev), 2000, 'lobby settled');
  const hostSaw = []; host.on('debug', (m) => hostSaw.push(m));
  host.startGame();
  await finishAll(all, 20000, 'game to finish after the drift');
  assert.ok(drifted, 'the drift was actually injected');
  assert.ok(hostSaw.some((m) => /hash-mismatch/.test(m)), 'the host noticed the mismatch: ' + hostSaw.join(', '));
  closeAll(all);
});

test("a move that overtakes the host's 'game started' message is kept, not lost (slow link to one device)", async () => {
  // host -> Bea is slow: Alex's reply to the host's first move reaches Bea before Bea even knows the game started
  const net = makeNet({ seed: 191, minDelay: 1, maxDelay: 3, delayFor: (from, to) => (from === 'k-host' && to === 'k-b' ? 40 : null) });
  const code = 'EARLY';
  const host = device(net, code, 'k-host', 'Neil', { host: true, instant: true });
  const others = [];
  for (const [k, n] of [['k-a', 'Alex'], ['k-b', 'Bea'], ['k-c', 'Cy']]) { others.push(device(net, code, k, n, { instant: true })); await sleep(60); }
  const all = [host, ...others];
  await until(() => all.every((r) => r.mySeat() >= 0) && all.every((r) => r.lobby.rev === host.lobby.rev), 3000, 'seated');
  const asked = []; host.on('debug', (m) => { if (/hello from/.test(m)) asked.push(m); });
  let resyncs = 0; all.forEach((r) => r.on('sync', () => resyncs++));
  host.startGame();
  await finishAll(all);
  assert.strictEqual(resyncs, 0, 'nobody should need catching up: ' + asked.join(', '));
  closeAll(all);
});

async function undoSetup(seed, timing) {
  const net = makeNet({ seed });
  const code = 'UNDO' + seed;
  const t = Object.assign({}, TIMING, timing || {});
  const host = new Net.Room(net.join(code, 'k-host'), { code, name: 'Neil', host: true, mode: 4, engine: E, timing: t });
  const a = new Net.Room(net.join(code, 'k-a'), { code, name: 'Alex', engine: E, timing: t });
  await until(() => a.mySeat() === 1, 2000, 'Alex seated');
  host.setSeat(2, { type: 'bot' }); host.setSeat(3, { type: 'bot' });
  await until(() => a.lobby.seats[3].type === 'bot', 2000, 'bots set');
  host.startGame();
  await until(() => a.started, 2000, 'start');
  const play = (r, c) => { const mv = E.botChoose(r.game, c, 'easy'); return r.proposeMove(c, mv.p, mv.cells); };
  const bots = () => { while (host.started && host.game.turn >= 2 && !host.game.out.every(Boolean)) { const c = host.game.turn; if (!E.hasMove(host.game, c)) host.proposePass(c); else play(host, c); } };
  return { net, host, a, play, bots };
}

test('Undo: takes back my move and the computer moves after it, on every device', async () => {
  const { host, a, play, bots } = await undoSetup(201);
  play(host, 0); await until(() => a.moveN === 1, 1000, 'move 1');
  const beforeMine = fp(a);
  play(a, 1); await until(() => host.game.turn !== 1, 1000, "Alex's move reaches the host"); bots();
  await until(() => a.moveN === 4 && host.moveN === 4, 1000, 'my move + 2 computer moves');
  const last = a.myLastMove();
  assert.ok(last && last.n === 2, 'Alex can see his last move is undoable');
  let undoneOnA = null; a.on('undone', (u) => { undoneOnA = u; });
  a.requestUndo(last.n);
  await until(() => a.moveN === 1 && host.moveN === 1 && a.ep === 1 && host.ep === 1, 1500, 'rolled back everywhere');
  assert.strictEqual(fp(a), beforeMine, "Alex's board is back to just before his move");
  assert.strictEqual(fp(host), beforeMine, "the host's board too");
  assert.strictEqual(a.game.turn, 1, "it's Alex's turn again");
  assert.ok(undoneOnA && undoneOnA.by === 'k-a' && undoneOnA.move.p === last.p, 'Alex is told which piece came back');
  // play on normally afterwards
  play(a, 1); await until(() => host.game.turn !== 1, 1000, "Alex's move reaches the host"); bots();
  await until(() => host.moveN === 4 && a.moveN === 4 && fp(a) === fp(host), 1500, 'game carries on in sync after the undo');
  host.leave(); a.leave();
});

test('Undo is refused once another person has moved; old computer moves after an undo are ignored', async () => {
  const { net, host, a, play, bots } = await undoSetup(202);
  play(host, 0); await until(() => a.moveN === 1, 1000, 'move 1');
  play(a, 1); await until(() => host.game.turn !== 1, 1000, "Alex's move reaches the host"); bots(); await until(() => a.moveN === 4, 1000, 'computer moves');
  play(host, 0); await until(() => a.moveN === 5, 1000, 'Neil moved after Alex');
  assert.strictEqual(a.myLastMove(), null, "Alex's move is no longer undoable on his device");
  let refused = null; a.on('undo-no', (r) => { refused = r; });
  a.requestUndo(2);
  await until(() => refused, 1000, 'host refuses');
  assert.strictEqual(refused, 'someone-moved');
  assert.strictEqual(a.moveN, 5, 'nothing was rolled back');
  // new round: Alex moves, computers move, Alex undoes, then a stale computer move from before the undo arrives
  await until(() => a.game.turn === 1, 1000, "Alex's turn");
  play(a, 1); await until(() => host.game.turn !== 1, 1000, "Alex's move reaches the host"); bots(); await until(() => a.moveN === 8 && host.moveN === 8, 1000, 'round 2');
  a.requestUndo(6);
  await until(() => a.ep === 1 && a.moveN === 5, 1500, 'undone');
  const raw = net.join(host.code, 'k-ghost');
  raw.send('move', { gid: host.lobby.gameId, ep: 0, n: 6, color: 1, p: 0, cells: [[0, 0]], h: 'x' });
  await sleep(80);
  assert.strictEqual(a.moveN, 5, 'a move from before the undo is ignored');
  host.leave(); a.leave(); raw.leave();
});

test('Undo is refused after the time window', async () => {
  const { host, a, play, bots } = await undoSetup(203, { undoMs: 100 });
  play(host, 0); await until(() => a.moveN === 1, 1000, 'move 1');
  play(a, 1); await until(() => host.game.turn !== 1, 1000, "Alex's move reaches the host"); bots(); await until(() => a.moveN === 4, 1000, 'computer moves');
  await sleep(1800); // past 100ms + 1.5s allowance for network delay
  let refused = null; a.on('undo-no', (r) => { refused = r; });
  a.requestUndo(2);
  await until(() => refused, 1000, 'refused');
  assert.strictEqual(refused, 'too-late');
  host.leave(); a.leave();
});

test('host is decided without clocks: a joiner never takes charge before it has the room', async () => {
  const net = makeNet({ seed: 31 });
  const host = device(net, 'CLK', 'k-z-host', 'Host', { host: true });
  const j = device(net, 'CLK', 'k-a-joiner', 'Joiner'); // sorts before the host alphabetically
  assert.strictEqual(j.amHost(), false, 'a brand-new joiner is not host');
  await until(() => j.lobby && j.mySeat() === 1, 2000, 'joiner seated');
  assert.strictEqual(j.hostKey, 'k-z-host');
  assert.strictEqual(host.hostKey, 'k-z-host');
  closeAll([host, j]);
});

test('seat requests never bounce someone who is already seated; two simultaneous joiners get different seats', async () => {
  const net = makeNet({ seed: 41 });
  const host = device(net, 'RACE', 'h', 'H', { host: true });
  const a = device(net, 'RACE', 'a', 'A'), b = device(net, 'RACE', 'b', 'B');
  await until(() => a.mySeat() >= 0 && b.mySeat() >= 0, 2000, 'both seated');
  assert.notStrictEqual(a.mySeat(), b.mySeat());
  const before = a.mySeat();
  a.claimSeat(-1); a.claimSeat(-1); await sleep(80);
  assert.strictEqual(a.mySeat(), before, 'repeated "any seat" requests keep the same seat');
  closeAll([host, a, b]);
});

test('changing the number of players keeps everyone who is seated', async () => {
  const { all, host } = await fourDeviceLobby(51, 3);
  host.setMode(4);
  await until(() => all.every((r) => r.lobby.mode === 4), 2000, 'mode change to arrive');
  all.forEach((r) => assert.ok(r.mySeat() >= 0, 'still seated after going to 4 players'));
  host.setMode(2);
  await until(() => all.every((r) => r.lobby.mode === 2), 2000, 'mode change to arrive');
  assert.strictEqual(host.lobby.seats.filter((s) => s.owner).length, 2, 'two people keep seats when going down to 2');
  closeAll(all);
});

test('a phone that locks briefly keeps its seat and catches up on the moves it missed', async () => {
  const { net, code, all, host, others } = await fourDeviceLobby(61);
  host.startGame();
  await until(() => all.every((r) => r.started), 3000, 'start');
  await until(() => host.moveN >= 6, 5000, 'a few moves');
  net.goOffline(code, 'k-b');
  await sleep(150); // shorter than the 400ms grace period
  assert.strictEqual(host.lobby.seats[2].type, 'human', 'seat is held during the grace period');
  net.goOnline(code, 'k-b');
  await finishAll(all);
  closeAll(all);
});

test('someone gone longer than the grace period: the computer covers, then they get the seat back after a reload', async () => {
  const { net, code, all, host, others } = await fourDeviceLobby(71);
  host.startGame();
  await until(() => all.every((r) => r.started), 3000, 'start');
  await until(() => host.moveN >= 4, 5000, 'a few moves');
  const gone = others[0]; gone.kill(); net.goOffline(code, 'k-a');
  await until(() => host.lobby.seats[1].type === 'bot', 3000, 'computer to take over the seat');
  const at = host.moveN;
  await until(() => host.moveN >= at + 6, 5000, 'game to keep going without them');
  const back = device(net, code, 'k-a', 'Alex'); // same tab id, as after a page reload
  await until(() => host.lobby.seats[1].type === 'human' && host.lobby.seats[1].owner === 'k-a', 3000, 'seat handed back');
  const live = [host, others[1], others[2], back];
  await finishAll(live);
  closeAll(live);
});

test('host drops mid-game: the next seat takes over the computer players; the old host rejoins and catches up', async () => {
  const net = makeNet({ seed: 81 });
  const host = device(net, 'HOST', 'k0', 'H', { host: true, mode: 4 });
  const a = device(net, 'HOST', 'k1', 'A');
  await until(() => a.mySeat() === 1, 2000, 'a seated');
  host.setSeat(2, { type: 'bot' }); host.setSeat(3, { type: 'bot' });
  await until(() => a.lobby.seats[3].type === 'bot', 2000, 'bots set');
  host.startGame();
  await until(() => a.started, 2000, 'start');
  await until(() => a.moveN >= 5, 5000, 'some moves');
  host.kill(); net.goOffline('HOST', 'k0');
  await until(() => a.amHost(), 2000, 'the other player becomes host');
  const at = a.moveN;
  await until(() => a.moveN >= at + 3, 5000, 'computer seats keep playing under the new host');
  const back = device(net, 'HOST', 'k0', 'H');
  await until(() => back.started && back.ready, 3000, 'old host back in sync');
  await finishAll([a, back]);
  closeAll([a, back]);
});

test('pressing Leave hands the seat to the computer straight away (no waiting)', async () => {
  const { all, host, others } = await fourDeviceLobby(91);
  host.startGame();
  await until(() => all.every((r) => r.started), 3000, 'start');
  const seat = others[1].mySeat();
  others[1].kill(); others[1].leave();
  await until(() => host.lobby.seats[seat].type === 'bot', 200, 'immediate handover (well under the 400ms grace), seat ' + seat + ' is ' + JSON.stringify(host.lobby.seats[seat]));
  const live = [host, others[0], others[2]];
  await finishAll(live);
  closeAll(live);
});

test('lost messages: a device that misses moves is healed by the heartbeat', async () => {
  const net = makeNet({ seed: 101 });
  let dropped = 0;
  net.dropWhen((ev, data, from, to) => ev === 'move' && to === 'k-c' && data.n % 7 === 3 && dropped++ < 6);
  const host = device(net, 'LOSS', 'k-host', 'H', { host: true });
  const others = [device(net, 'LOSS', 'k-a', 'A'), device(net, 'LOSS', 'k-b', 'B'), device(net, 'LOSS', 'k-c', 'C')];
  const all = [host, ...others];
  await until(() => all.every((r) => r.mySeat() >= 0), 3000, 'seated');
  host.startGame();
  await finishAll(all);
  assert.ok(dropped > 0, 'the test actually dropped messages');
  closeAll(all);
});

test('lost messages the other way: the host misses a player\'s move and the player re-sends it', async () => {
  const net = makeNet({ seed: 111 });
  let dropped = 0;
  net.dropWhen((ev, data, from, to) => ev === 'move' && from === 'k-a' && to === 'k-host' && dropped++ < 3);
  const host = device(net, 'LOSS2', 'k-host', 'H', { host: true, mode: 2 });
  const a = device(net, 'LOSS2', 'k-a', 'A');
  await until(() => a.mySeat() === 1, 2000, 'seated');
  host.startGame();
  await finishAll([host, a]);
  assert.ok(dropped > 0);
  closeAll([host, a]);
});

test('out-of-turn, forged and duplicate moves are ignored', async () => {
  const net = makeNet({ seed: 121 });
  const host = device(net, 'FORGE', 'k-host', 'H', { host: true, mode: 2 });
  const a = device(net, 'FORGE', 'k-a', 'A');
  await until(() => a.mySeat() === 1, 2000, 'seated');
  host.kill(); a.kill(); // stop autoplay so we control every move
  host.startGame();
  await until(() => a.started, 2000, 'start');
  // a tries to play blue (not theirs, not their turn)
  assert.strictEqual(a.proposeMove(0, 0, [E.COLORS[0].corner]).ok, false);
  // a forges a raw message for yellow while it's blue's turn
  const raw = net.join('FORGE', 'k-evil');
  raw.send('move', { gid: host.lobby.gameId, n: 1, color: 1, p: 0, cells: [E.COLORS[1].corner] });
  await sleep(60);
  assert.strictEqual(host.moveN, 0, 'forged out-of-turn move ignored');
  assert.strictEqual(host.proposeMove(0, 0, [E.COLORS[0].corner]).ok, true);
  await until(() => a.moveN === 1, 1000, 'real move arrives');
  const board = fp(a);
  raw.send('move', { gid: host.lobby.gameId, n: 1, color: 0, p: 0, cells: [E.COLORS[0].corner] }); // replayed duplicate
  await sleep(60);
  assert.strictEqual(a.moveN, 1); assert.strictEqual(fp(a), board, 'duplicate ignored');
  closeAll([host, a]);
});

test('a full room: an extra person watches, and stays in sync with the game', async () => {
  const { net, code, all, host } = await fourDeviceLobby(131);
  const watcher = device(net, code, 'k-watch', 'Wes');
  await until(() => watcher.lobby, 2000, 'watcher gets the room');
  assert.strictEqual(watcher.mySeat(), -1, 'no seat left for the fifth person');
  host.startGame();
  await finishAll([...all, watcher]);
  closeAll([...all, watcher]);
});

test('2-player and 3-player online games finish in sync', async () => {
  for (const mode of [2, 3]) {
    const { all, host } = await fourDeviceLobby(140 + mode, mode);
    assert.strictEqual(all.length, mode);
    host.startGame();
    await finishAll(all);
    closeAll(all);
  }
});

test('rematch brings everyone back to the lobby, still seated, and a second game works', async () => {
  const { all, host } = await fourDeviceLobby(151);
  host.startGame();
  await finishAll(all);
  host.rematch();
  await until(() => all.every((r) => r.lobby.phase === 'lobby' && !r.started), 2000, 'back to lobby');
  all.forEach((r) => assert.ok(r.mySeat() >= 0));
  host.startGame();
  await finishAll(all);
  closeAll(all);
});

test('joining a code nobody is in says so instead of hanging', async () => {
  const net = makeNet({ seed: 161 });
  const lonely = device(net, 'EMPTY', 'k-x', 'X');
  let told = false; lonely.on('no-host', () => { told = true; });
  await until(() => told, 2000, 'no-host event');
  closeAll([lonely]);
});

(async () => {
  let failed = 0;
  for (const t of tests.filter((t) => !process.env.ONLY || t.name.includes(process.env.ONLY))) {
    try { await t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); }
  }
  console.log(failed ? failed + ' failed' : 'net tests passed');
  process.exit(failed ? 1 : 0);
})();
