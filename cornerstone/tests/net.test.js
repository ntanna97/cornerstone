const assert = require('assert');
const E = require('../engine.js');
const Net = require('../net.js');

// ---- fake transport bus: simulates a Supabase realtime channel for N peers ----
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
function setup(n, mode) {
  const bus = makeBus();
  const rooms = [];
  const t0 = bus.join('host');
  const host = new Net.Room(t0, { code: 'ABCDE', name: 'Host', host: true, mode, engine: E });
  rooms.push(host);
  for (let i = 1; i < n; i++) {
    const t = bus.join('p' + i);
    const r = new Net.Room(t, { code: 'ABCDE', name: 'Player' + i, engine: E });
    rooms.push(r);
  }
  return { bus, rooms };
}
function firstMove(room, color) {
  const cells = [E.COLORS[color].corner];
  return room.proposeMove(color, 0, cells); // the 1-square piece always legally covers its own corner
}

// 1) lobby: join, claim seats, reject start with an open seat, start once full
{
  const { rooms } = setup(3, 3);
  const [host, b, c] = rooms;
  assert.strictEqual(host.lobby.seats.length, 3);
  assert.strictEqual(host.lobby.seats[0].owner, 'host');
  b.claimSeat(1); c.claimSeat(2);
  assert.strictEqual(host.lobby.seats[1].owner, 'p1');
  assert.strictEqual(b.lobby.seats[1].owner, 'p1', 'lobby broadcast reached peer b');
  assert.strictEqual(c.lobby.seats[1].owner, 'p1', 'lobby broadcast reached peer c');
  host.startGame(E);
  assert.ok(host.started && b.started && c.started, 'all peers started');
  assert.strictEqual(JSON.stringify(E.serialize(host.game)), JSON.stringify(E.serialize(b.game)));
  assert.strictEqual(JSON.stringify(E.serialize(host.game)), JSON.stringify(E.serialize(c.game)));
  console.log('lobby + start: ok');
}

// 2) moves replicate to everyone, only the owning colour may act, turn cycles 0-3 even with 2 seats
{
  const { rooms } = setup(2, 2); // seat0=host controls colours 0,2 ; seat1 controls 1,3
  const [host, b] = rooms;
  b.claimSeat(1);
  host.startGame(E);
  const bad = b.proposeMove(0, 0, [E.COLORS[0].corner]); // b does not own colour 0
  assert.strictEqual(bad.ok, false); assert.strictEqual(bad.reason, 'not-your-colour');
  assert.ok(firstMove(host, 0).ok);
  assert.strictEqual(host.game.turn, 1); assert.strictEqual(b.game.turn, 1);
  assert.strictEqual(b.game.board[E.COLORS[0].corner[1] * 20 + E.COLORS[0].corner[0]], 0, 'move replicated to peer');
  assert.ok(firstMove(b, 1).ok);
  assert.strictEqual(host.game.turn, 2, 'turn advances to colour 2, not wrapping at seat count');
  const wrongSeat = host.proposeMove(3, 0, [E.COLORS[3].corner]); // host does not own colour 3 yet (turn is 2 anyway)
  assert.strictEqual(wrongSeat.ok, false);
  assert.ok(firstMove(host, 2).ok); // host owns colour 2 (seat0)
  assert.strictEqual(host.game.turn, 3);
  assert.ok(firstMove(b, 3).ok); // b owns colour 3 (seat1)
  assert.strictEqual(host.game.turn, 0, 'wraps back to colour 0 after all four colours');
  console.log('move replication + seat/colour mapping: ok');
}

// 3) 3-player mode: the shared 4th colour rotates across seats as it's played
{
  const { rooms } = setup(3, 3);
  const [host, b, c] = rooms;
  b.claimSeat(1); c.claimSeat(2);
  host.startGame(E);
  assert.strictEqual(host.seatForColor(3).owner, 'host', 'shared colour starts with seat 0');
  assert.deepStrictEqual(host.actingColors().sort(), [0, 3]);
  ['host', 'b', 'c'].length; // noop
  assert.ok(firstMove(host, 0).ok);
  assert.ok(firstMove(b, 1).ok);
  assert.ok(firstMove(c, 2).ok);
  assert.strictEqual(host.game.turn, 3);
  assert.strictEqual(host.seatForColor(3).owner, 'host', 'still seat 0 before it has been played once');
  assert.ok(firstMove(host, 3).ok); // seat 0 plays the shared colour's first turn
  assert.strictEqual(host.game.meta.sharedCount, 1);
  assert.strictEqual(host.seatForColor(3).owner, 'p1', 'shared colour rotates to seat 1 next');
  assert.strictEqual(b.seatForColor(3).owner, 'p1', 'rotation agrees on every peer');
  console.log('3-player shared-colour rotation: ok');
}

// 4) host disconnect elects a new host who inherits bot/open colours and lobby authority
{
  const { rooms } = setup(3, 3);
  const [host, b, c] = rooms;
  b.claimSeat(1);
  host.setSeat(2, { type: 'bot', level: 'medium' });
  assert.ok(host.actingColors().includes(2), 'host acts for bot seat 2');
  host.startGame(E);
  assert.ok(c.started);
  host.leave();
  assert.strictEqual(b.hostKey, 'p1');
  assert.ok(b.isHost);
  assert.ok(b.actingColors().includes(2), 'new host inherits the bot seat');
  console.log('host failover: ok');
}

// 5) a human seat's owner drops mid-game -> seat flips to bot and host can act for it
{
  const { rooms } = setup(3, 3);
  const [host, b, c] = rooms;
  b.claimSeat(1); c.claimSeat(2);
  host.startGame(E);
  b.leave();
  assert.strictEqual(host.lobby.seats[1].type, 'bot', 'seat orphaned to bot');
  assert.strictEqual(host.lobby.seats[1].owner, null);
  assert.ok(host.actingColors().includes(1), 'host now acts for the orphaned colour');
  assert.strictEqual(c.lobby.seats[1].type, 'bot', 'orphan status reached remaining peer');
  console.log('mid-game orphan takeover: ok');
}

// 6) late joiner resyncs full game state via hello/start
{
  const { rooms, bus } = setup(2, 2);
  const [host, b] = rooms;
  b.claimSeat(1);
  host.startGame(E);
  firstMove(host, 0);
  const t3 = bus.join('late');
  const late = new Net.Room(t3, { code: 'ABCDE', name: 'Late', engine: E });
  late.requestResync();
  assert.ok(late.started, 'late joiner received a start/resync snapshot');
  assert.strictEqual(JSON.stringify(E.serialize(late.game)), JSON.stringify(E.serialize(host.game)));
  console.log('late-join resync: ok');
}

// 7) an illegal proposed move (e.g. stale board) is rejected before touching state
{
  const { rooms } = setup(2, 2);
  const [host, b] = rooms;
  b.claimSeat(1);
  host.startGame(E);
  firstMove(host, 0);
  const again = host.proposeMove(0, 0, [E.COLORS[0].corner]); // same square already filled
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.reason, 'overlap');
  console.log('illegal move rejection: ok');
}


// 8) turn advance skips colours that have already dropped out (not just the one just played)
{
  const { rooms } = setup(4, 4);
  const [host, b, c, d] = rooms;
  b.claimSeat(1); c.claimSeat(2); d.claimSeat(3);
  host.startGame(E);
  host.game.out[1] = true; host.game.out[2] = true; // simulate colours 1 and 2 already having no moves earlier
  b.game.out[1] = true; b.game.out[2] = true;
  c.game.out[1] = true; c.game.out[2] = true;
  d.game.out[1] = true; d.game.out[2] = true;
  host.game.turn = 0;
  assert.ok(firstMove(host, 0).ok);
  assert.strictEqual(host.game.turn, 3, 'turn skips the two out colours and lands on 3');
  assert.strictEqual(b.game.turn, 3, 'every peer computes the same skip');
  assert.ok(firstMove(d, 3).ok);
  assert.strictEqual(host.game.turn, 0, 'wraps back to 0, skipping 1 and 2 again');
  console.log('turn-skip over dropped-out colours: ok');
}

// 9) a newcomer joining mid-game is caught up automatically, without disrupting peers already playing
{
  const { rooms, bus } = setup(3, 3);
  const [host, b, c] = rooms;
  b.claimSeat(1); c.claimSeat(2);
  host.startGame(E);
  firstMove(host, 0);
  const bGameRefBefore = b.game;
  let bGotStartAgain = false;
  b.on('start', () => { bGotStartAgain = true; });
  const t4 = bus.join('spectator');
  const spec = new Net.Room(t4, { code: 'ABCDE', name: 'Spectator', engine: E });
  assert.ok(spec.started, 'newcomer is caught up without an explicit requestResync() call');
  assert.strictEqual(JSON.stringify(E.serialize(spec.game)), JSON.stringify(E.serialize(host.game)));
  assert.strictEqual(b.game, bGameRefBefore, "an already-playing peer's game object is untouched by someone else joining");
  assert.strictEqual(bGotStartAgain, false, "an already-playing peer must not receive a disruptive 'start' event");
  console.log('mid-game newcomer catch-up without disrupting existing players: ok');
}

console.log('net tests passed');
