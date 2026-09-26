/* Cornerstone — online play protocol.

   Every device runs the same rules engine. Whoever's colour it is proposes a
   move, applies it locally and broadcasts it; everyone else validates and
   applies it. The only backend is a Supabase Realtime channel for the room
   code, used as a message relay plus a presence list. Nothing is stored
   server-side.

   Seats vs colours:
     a "seat" (0..seatCount-1) is a place a person or the computer sits;
     a "colour" (0..3: blue, yellow, red, green) is what the engine plays.
     4 players: seat == colour. 2 players: seat i plays colours i and i+2.
     3 players: seat i plays colour i; green (3) is shared and rotates.

   Robustness rules (each exists because of a real failure mode):
   - Host = the lowest-numbered seat whose device is connected AND in sync
     ("ready"). No clocks involved, so devices with different clocks agree,
     and a device that is still catching up can never take charge.
   - Only the host changes the lobby. Lobby changes carry a revision number;
     everyone keeps the highest revision they've seen.
   - Moves carry a sequence number, the colour, and a fingerprint of the
     board after the move. A move is only applied if it is exactly the next
     one, for the colour whose turn it is, and legal. Anything else triggers a
     resync from the host.
   - The host sends a heartbeat every few seconds. A device that is behind,
     or whose board fingerprint differs, asks for the host's state. A device
     that is ahead (the host missed one of its moves) re-sends those moves.
     So a dropped message can't stall the game.
   - A player whose connection drops keeps their seat for a grace period
     (phones lock, Wi-Fi blips). After that the computer plays for them, and
     they get the seat back automatically when they reconnect.

   Room depends only on this transport interface, so it can be tested
   without a network:
     transport.myKey()                 stable id for this tab
     transport.track(meta)             set my presence metadata
     transport.onPresence(cb)          cb([{key, name, ready, t}])
     transport.onMessage(cb)           cb(event, payload, fromKey)
     transport.onStatus(cb)            optional; cb('lost' | 'reconnected')
     transport.send(event, payload)    broadcast to everyone else in the room
     transport.leave()
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CornerstoneNet = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function makeCode() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
    let s = ''; for (let i = 0; i < 5; i++) s += abc[Math.floor(Math.random() * abc.length)];
    return s;
  }
  const seatCountFor = (mode) => (mode === 2 ? 2 : mode === 3 ? 3 : 4);
  const emptySeat = () => ({ type: 'open', owner: null, name: '', level: 'medium' });
  const emptySeats = (mode) => Array.from({ length: seatCountFor(mode) }, emptySeat);
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // Cheap order-sensitive fingerprint of everything that must match on every device.
  function fingerprint(g, n) {
    let h = 2166136261 >>> 0;
    const mix = (v) => { h ^= (v & 0xff); h = Math.imul(h, 16777619) >>> 0; };
    for (let i = 0; i < g.board.length; i++) mix(g.board[i] + 2);
    mix(g.turn); for (let c = 0; c < 4; c++) mix(g.out[c] ? 1 : 0);
    mix(n & 0xff); mix((n >> 8) & 0xff); mix((g.meta && g.meta.sharedCount) || 0);
    return h.toString(36);
  }

  const DEFAULT_TIMING = {
    graceLobbyMs: 20000,   // lobby: an absent player's seat reopens after this
    gracePlayMs: 45000,    // game: the computer takes over an absent player's seat after this
    helloRetryMs: 1500,    // how often a device that isn't in sync asks again
    soloReadyMs: 6000,     // if nobody answers for this long, assume I'm the most up-to-date device
    noHostMs: 8000,        // no lobby after this long -> tell the user nobody seems to be in the room
    beatMs: 5000,          // host heartbeat
    gapMs: 1200,           // how long to hold a move that arrived early before asking for help
    resyncThrottleMs: 800
  };

  function Room(transport, opts) {
    const self = this;
    const E = opts.engine;
    const T = Object.assign({}, DEFAULT_TIMING, opts.timing || {});
    const handlers = {};
    self.on = (ev, cb) => { (handlers[ev] = handlers[ev] || []).push(cb); };
    const emit = (ev, a, b) => { (handlers[ev] || []).slice().forEach((cb) => cb(a, b)); };

    self.code = opts.code;
    self.myName = opts.name || 'Player';
    self.myKey = transport.myKey();
    self.lobby = null;        // { rev, mode, phase: 'lobby'|'playing', gameId, seats: [...] }
    self.game = null;
    self.moveN = 0;
    self.presence = [];
    self.hostKey = null;
    self.ready = false;       // "I have the current room state" — only ready devices can be host
    let log = {};             // moves applied this game, by sequence number (for re-sending)
    let pending = {};         // moves that arrived before the one they follow
    let gapTimer = null;
    let early = {};           // moves that arrived before their game did (by game id): held, then applied when it arrives
    let closed = false;
    let wantSeat = opts.autoSeat !== false;
    let presenceSeen = !!opts.host;   // until my first presence list arrives, trust whoever sent me the room state
    let hostHint = null;
    const leftKeys = new Set();       // people who pressed Leave (no grace period, no auto-reseat)
    const graceTimers = {};
    const timers = new Set();
    function later(fn, ms) { const id = setTimeout(() => { timers.delete(id); if (!closed) fn(); }, ms); timers.add(id); return id; }
    function cancel(id) { if (id) { clearTimeout(id); timers.delete(id); } }

    Object.defineProperty(self, 'started', { get: () => !!(self.lobby && self.lobby.phase === 'playing' && self.game) });

    if (opts.host) {
      const mode = opts.mode || 4;
      self.lobby = { rev: 1, mode, phase: 'lobby', gameId: null, seats: emptySeats(mode) };
      self.lobby.seats[0] = { type: 'human', owner: self.myKey, name: self.myName, level: 'medium' };
      self.ready = true;
    }

    // ---------- who is here, who is in charge ----------
    function presentKeys() {
      const s = new Set(self.presence.filter((p) => !leftKeys.has(p.key)).map((p) => p.key));
      if (!presenceSeen && hostHint) s.add(hostHint);
      s.add(self.myKey); return s;
    }
    function readyKeys() {
      const s = new Set(self.presence.filter((p) => p.ready && !leftKeys.has(p.key)).map((p) => p.key));
      if (!presenceSeen && hostHint) s.add(hostHint);
      if (self.ready) s.add(self.myKey); else s.delete(self.myKey);
      return s;
    }
    function computeHost() {
      if (!self.lobby) return null;
      const rk = readyKeys();
      for (const s of self.lobby.seats) if (s.type === 'human' && s.owner && rk.has(s.owner)) return s.owner;
      return Array.from(rk).sort()[0] || null;
    }
    const amHost = () => !!self.lobby && self.hostKey === self.myKey;
    self.amHost = amHost;
    self.isPresent = (key) => presentKeys().has(key);

    function refreshHost() {
      const prev = self.hostKey;
      self.hostKey = computeHost();
      if (self.hostKey === prev) return;
      if (amHost()) { reconcileSeats(); if (self.started) emit('resume'); }
      else clearGrace();
      emit('host', self.hostKey);
    }

    // ---------- colour <-> seat ----------
    function seatIndexForColor(c) {
      const mode = self.lobby.mode;
      if (mode === 2) return c % 2;
      if (mode === 3) return c < 3 ? c : ((self.game && self.game.meta.sharedCount) || 0) % 3;
      return c;
    }
    const seatForColor = (c) => self.lobby.seats[seatIndexForColor(c)];
    self.seatIndexForColor = seatIndexForColor;
    self.seatForColor = seatForColor;
    self.myColors = () => (self.lobby ? [0, 1, 2, 3].filter((c) => seatForColor(c).owner === self.myKey) : []);
    self.mySeat = () => (self.lobby ? self.lobby.seats.findIndex((s) => s.owner === self.myKey) : -1);
    self.actingColors = () => {
      if (!self.lobby || self.lobby.phase !== 'playing') return [];
      return [0, 1, 2, 3].filter((c) => {
        const s = seatForColor(c);
        return s.type === 'human' ? s.owner === self.myKey : amHost();
      });
    };

    // ---------- presence ----------
    function setReady(v) {
      if (self.ready === v) return;
      self.ready = v;
      track();
      refreshHost();
      if (v) { cancel(helloTimer); helloTimer = null; maybeAutoSeat(); }
    }
    function track() { transport.track({ name: self.myName, ready: self.ready, t: Date.now() }); }

    transport.onPresence((list) => {
      self.presence = list;
      presenceSeen = true;
      refreshHost();
      if (amHost()) reconcileSeats();
      emit('presence', list);
    });

    // ---------- seats (host only) ----------
    function commitLobby() {
      self.lobby.rev++;
      transport.send('lobby', self.lobby);
      emit('lobby', self.lobby);
    }
    function clearGrace() { Object.keys(graceTimers).forEach((k) => { cancel(graceTimers[k]); delete graceTimers[k]; }); }
    function reconcileSeats() {
      if (!amHost() || !self.lobby) return;
      const present = presentKeys();
      let changed = false;
      self.lobby.seats.forEach((s) => {
        if (s.type === 'human' && s.owner && leftKeys.has(s.owner)) { const k = s.owner; later(() => expire(k, true), 0); return; }
        if (s.type === 'human' && s.owner && !present.has(s.owner) && !graceTimers[s.owner]) {
          const k = s.owner;
          graceTimers[k] = later(() => expire(k, false), self.lobby.phase === 'playing' ? T.gracePlayMs : T.graceLobbyMs);
        }
        if (s.type === 'bot' && s.prevOwner && present.has(s.prevOwner) && self.lobby.phase === 'playing') {
          s.type = 'human'; s.owner = s.prevOwner; delete s.prevOwner; changed = true; // they're back: hand the seat over
        }
      });
      Object.keys(graceTimers).forEach((k) => { if (present.has(k)) { cancel(graceTimers[k]); delete graceTimers[k]; } });
      if (changed) { commitLobby(); if (self.started) emit('resume'); }
    }
    function expire(key, force) {
      cancel(graceTimers[key]); delete graceTimers[key];
      if (!amHost() || (!force && presentKeys().has(key))) return;
      let changed = false;
      self.lobby.seats.forEach((s, i) => {
        if (s.type !== 'human' || s.owner !== key) return;
        if (self.lobby.phase === 'playing') { s.type = 'bot'; s.owner = null; if (!force) s.prevOwner = key; }
        else self.lobby.seats[i] = emptySeat();
        changed = true;
      });
      if (changed) { commitLobby(); emit('seat-orphaned', key); if (self.started) emit('resume'); }
    }
    function seatPerson(i, key, name) {
      const seats = self.lobby.seats;
      const cur = seats.findIndex((s) => s.owner === key);
      if (cur >= 0 && (i < 0 || i === cur)) { if (seats[cur].name !== name) { seats[cur].name = name; return true; } return false; }
      if (i < 0 || !seats[i] || seats[i].type !== 'open') i = seats.findIndex((s) => s.type === 'open');
      if (i < 0) return false; // room is full: they can watch
      if (cur >= 0) seats[cur] = emptySeat();
      seats[i] = { type: 'human', owner: key, name, level: 'medium' };
      return true;
    }

    self.setMode = function (mode) {
      if (!amHost() || self.lobby.phase !== 'lobby' || mode === self.lobby.mode) return;
      const n = seatCountFor(mode), old = self.lobby.seats;
      const humans = old.filter((s) => s.type === 'human' && s.owner), bots = old.filter((s) => s.type === 'bot');
      const seats = emptySeats(mode);
      let k = 0;
      humans.forEach((s) => { if (k < n) seats[k++] = s; });   // keep everyone who is seated, in order
      bots.forEach((s) => { if (k < n) seats[k++] = s; });
      self.lobby.mode = mode; self.lobby.seats = seats;
      commitLobby();
    };
    self.setSeat = function (i, patch) {
      if (!amHost() || self.lobby.phase !== 'lobby' || !self.lobby.seats[i]) return;
      const s = self.lobby.seats[i];
      if (patch.type === 'open') self.lobby.seats[i] = emptySeat();
      else if (patch.type === 'bot') self.lobby.seats[i] = { type: 'bot', owner: null, name: '', level: patch.level || s.level || 'medium' };
      else Object.assign(s, patch);
      commitLobby();
    };
    self.claimSeat = function (i) {
      wantSeat = true;
      if (amHost()) { if (self.lobby.phase === 'lobby' && seatPerson(i, self.myKey, self.myName)) commitLobby(); return; }
      transport.send('claim', { seat: i, name: self.myName });
    };
    self.leaveSeat = function (i) {
      wantSeat = false;
      if (amHost()) { const s = self.lobby.seats[i]; if (s && s.owner === self.myKey) self.setSeat(i, { type: 'open' }); return; }
      transport.send('unclaim', { seat: i });
    };
    function maybeAutoSeat() {
      if (!wantSeat || !self.ready || !self.lobby || self.lobby.phase !== 'lobby') return;
      if (self.mySeat() >= 0 || !self.lobby.seats.some((s) => s.type === 'open')) return;
      self.claimSeat(-1);
    }

    // ---------- game lifecycle ----------
    self.startGame = function () {
      if (!amHost() || self.lobby.phase !== 'lobby') return;
      if (self.lobby.seats.some((s) => s.type === 'open')) { emit('start-blocked'); return; }
      const g = E.newGame(); g.meta = { sharedCount: 0, moves: 0, last: null };
      self.game = g; self.moveN = 0; log = {};
      self.lobby.phase = 'playing';
      self.lobby.gameId = Math.random().toString(36).slice(2, 10);
      self.lobby.rev++;
      transport.send('start', { lobby: self.lobby, game: E.serialize(g), n: 0 });
      emit('start', self.lobby, g);
    };
    self.rematch = function () {
      if (!amHost() || self.lobby.phase !== 'playing') return;
      self.lobby.phase = 'lobby'; self.lobby.gameId = null;
      self.lobby.seats.forEach((s, i) => { // anyone the computer was covering for who is gone gets their seat reopened
        if (s.type === 'bot' && s.prevOwner) { if (presentKeys().has(s.prevOwner)) { s.type = 'human'; s.owner = s.prevOwner; } else self.lobby.seats[i] = emptySeat(); delete s.prevOwner; }
      });
      self.game = null; self.moveN = 0; log = {};
      commitLobby();
      emit('rematch', self.lobby);
    };

    // ---------- moves ----------
    function applyMove(m, local) {
      const g = self.game, c = m.color;
      if (m.pass) g.out[c] = true;
      else {
        E.apply(g, c, m.p, m.cells);
        g.meta.last = { c, cells: m.cells, p: m.p };
        g.meta.moves++;
      }
      if (self.lobby.mode === 3 && c === 3) g.meta.sharedCount = (g.meta.sharedCount || 0) + 1;
      let nxt = (c + 1) % 4;
      while (g.out[nxt] && !g.out.every(Boolean)) nxt = (nxt + 1) % 4;
      g.turn = nxt;
      self.moveN = m.n;
      log[m.n] = m;
      // No emit here: callers notify listeners only after the move is fully recorded and sent.
      // (Listeners can react by proposing the next move straight away, which must go out after this one.)
    }
    function propose(m) {
      const g = self.game;
      if (!self.started) return { ok: false, reason: 'no-game' };
      if (g.turn !== m.color || g.out[m.color]) return { ok: false, reason: 'not-your-turn' };
      if (!self.actingColors().includes(m.color)) return { ok: false, reason: 'not-your-colour' };
      if (m.pass) { if (E.hasMove(g, m.color)) return { ok: false, reason: 'has-moves' }; }
      else { const r = E.check(g, m.color, m.cells); if (!r.ok) return r; }
      m.gid = self.lobby.gameId; m.n = self.moveN + 1;
      applyMove(m, true);
      m.h = fingerprint(self.game, self.moveN);
      log[m.n] = m;
      transport.send('move', m);
      emit('move', m, true);
      return { ok: true };
    }
    self.proposeMove = (color, p, cells) => propose({ color, p, cells });
    self.proposePass = (color) => propose({ color, pass: true });

    function onMove(m) {
      if (!self.started || m.gid !== self.lobby.gameId) { // e.g. a player's reply overtook the host's "game started" message
        if (m.gid) { const b = early[m.gid] = early[m.gid] || {}; if (Object.keys(b).length < 200) b[m.n] = m; }
        return;
      }
      const g = self.game;
      if (m.n <= self.moveN) { // duplicate or re-send; only interesting if it disagrees with what I have
        if (m.n === self.moveN && m.h && m.h !== fingerprint(g, self.moveN)) { emit('debug', 'dup-mismatch n=' + m.n); outOfSync(); }
        return;
      }
      if (m.n !== self.moveN + 1) { // arrived early (players on different servers): hold it briefly
        pending[m.n] = m;
        if (!gapTimer) gapTimer = later(() => {
          gapTimer = null;
          if (!pending[self.moveN + 1] && Object.keys(pending).some((k) => +k > self.moveN)) {
            if (amHost()) sendBeat(); else behind(); // host: nudge whoever is ahead to re-send; others: ask the host
          }
        }, T.gapMs);
        return;
      }
      const ok = m.color === g.turn && !g.out[m.color] &&
        (m.pass ? !E.hasMove(g, m.color) : E.check(g, m.color, m.cells).ok);
      if (!ok) { emit('debug', 'illegal n=' + m.n + ' c=' + m.color + ' turn=' + g.turn); return outOfSync(); }
      applyMove(m);
      if (m.h && m.h !== fingerprint(g, self.moveN)) {
        // Same move, different resulting board: two devices had drifted apart.
        emit('debug', 'hash-mismatch n=' + m.n); pending = {};
        outOfSync();                                 // host: push my board to everyone; others: ask the host for its board
        if (amHost()) emit('move', m, false);        // the host's board is the reference, so the host's own screen must move on too
        return;
      }
      emit('move', m, false);
      if (self.game !== g) return; // a listener's action replaced the game (e.g. a resync)
      Object.keys(pending).forEach((k) => { if (+k <= self.moveN) delete pending[k]; });
      const next = pending[self.moveN + 1];
      if (next) { delete pending[next.n]; onMove(next); }
      else if (!Object.keys(pending).length && gapTimer) { cancel(gapTimer); gapTimer = null; }
    }

    // ---------- keeping everyone in sync ----------
    let lastResync = 0, helloTimer = null, helloStarted = 0, noHostTold = false;
    function sendHello(reason) { transport.send('hello', { reason, n: self.moveN, gid: self.lobby && self.lobby.gameId }); }
    function behind() { throttled('behind'); }
    function outOfSync() {
      if (amHost()) { // the host's state is the reference: push it to everyone
        const now = Date.now(); if (now - lastResync < T.resyncThrottleMs) return; lastResync = now;
        transport.send('sync', syncPayload(null, true));
      } else throttled('desync');
    }
    function throttled(reason) {
      const now = Date.now(); if (now - lastResync < T.resyncThrottleMs) return; lastResync = now;
      sendHello(reason);
    }
    self.requestResync = (reason) => { if (!amHost()) throttled(reason || 'check'); };
    function syncPayload(to, force) {
      return { to, force: !!force, lobby: self.lobby, game: self.started ? E.serialize(self.game) : null, n: self.moveN };
    }
    function startHelloLoop(reason) {
      cancel(helloTimer); helloStarted = Date.now(); noHostTold = false;
      const tick = () => {
        helloTimer = null;
        if (self.ready) return;
        sendHello(reason);
        const waited = Date.now() - helloStarted;
        if (self.lobby && waited >= T.soloReadyMs) { setReady(true); return; } // nobody answered: I'm as current as anyone
        if (!self.lobby && waited >= T.noHostMs && !noHostTold) { noHostTold = true; emit('no-host'); }
        helloTimer = later(tick, T.helloRetryMs);
      };
      tick();
    }

    function adoptLobby(l, live) {
      if (self.lobby && l.rev < self.lobby.rev) return false;
      const prevPhase = self.lobby && self.lobby.phase, prevGid = self.lobby && self.lobby.gameId;
      const wasSeated = self.mySeat() >= 0;
      if (live && wasSeated && l.phase === 'lobby' && !l.seats.some((s) => s.owner === self.myKey)) wantSeat = false; // the host cleared my seat
      self.lobby = clone(l);
      if (self.lobby.phase === 'lobby') { self.game = null; self.moveN = 0; log = {}; }
      else if (self.lobby.gameId !== prevGid) { self.game = null; self.moveN = 0; log = {}; }
      refreshHost();
      emit('lobby', self.lobby);
      if (prevPhase === 'playing' && self.lobby.phase === 'lobby') emit('rematch', self.lobby);
      if (self.lobby.phase === 'playing' && !self.game) { if (self.ready) setReady(false); if (!helloTimer) startHelloLoop('behind'); }
      else if (!self.ready && self.lobby.phase === 'lobby') setReady(true);
      maybeAutoSeat();
      return true;
    }
    function adoptGame(p) {
      const sameGame = self.game && self.lobby && self.lobby.gameId === p.lobby.gameId;
      if (sameGame && !p.force && p.n < self.moveN) return false; // older than what I have
      if (sameGame && !p.force && p.n === self.moveN && fingerprint(E.deserialize(p.game), p.n) === fingerprint(self.game, self.moveN)) return false; // nothing changed
      if (!self.lobby || p.lobby.rev >= self.lobby.rev) self.lobby = clone(p.lobby);
      self.game = E.deserialize(p.game); self.moveN = p.n; log = {}; pending = {};
      // apply any moves for this game that got here first, before telling anyone the game is ready
      const held = early[self.lobby.gameId]; early = {};
      if (held) {
        let m;
        while ((m = held[self.moveN + 1])) {
          const g = self.game;
          const ok = m.color === g.turn && !g.out[m.color] && (m.pass ? !E.hasMove(g, m.color) : E.check(g, m.color, m.cells).ok);
          if (!ok) break;
          applyMove(m);
          if (m.h && m.h !== fingerprint(g, self.moveN)) { outOfSync(); break; }
        }
      }
      emit(sameGame ? 'sync' : 'start', self.lobby, self.game);
      if (held) Object.values(held).filter((x) => x.n > self.moveN).sort((a, b) => a.n - b.n).forEach((x) => onMove(x)); // any after a gap: normal holding
      return true;
    }

    transport.onMessage((event, p, fromKey) => {
      if (closed) return;
      if (event !== 'bye' && leftKeys.has(fromKey)) leftKeys.delete(fromKey); // they came back
      switch (event) {
        case 'lobby': hostHint = fromKey; adoptLobby(p, true); break;
        case 'start': hostHint = fromKey; adoptGame({ lobby: p.lobby, game: p.game, n: p.n, force: true }); setReady(true); refreshHost(); break;
        case 'move': onMove(p); break;
        case 'sync':
          if (p.to && p.to !== self.myKey) break;
          hostHint = fromKey;
          if (p.game && p.lobby.phase === 'playing') adoptGame(p);
          else adoptLobby(p.lobby);
          setReady(true); refreshHost(); maybeAutoSeat();
          break;
        case 'hello':
          if (amHost()) { emit('debug', 'hello from ' + fromKey.slice(-4) + ' reason=' + p.reason); transport.send('sync', syncPayload(fromKey, p.reason === 'desync')); }
          break;
        case 'beat':
          if (!self.lobby || p.rev > self.lobby.rev) { throttled('behind'); break; }
          if (!self.started || p.gid !== self.lobby.gameId) break;
          if (p.n > self.moveN) { // probably just a move still on its way: give it a moment before asking for a catch-up
            const want = p.n, gid = p.gid;
            later(() => { if (self.started && self.lobby.gameId === gid && self.moveN < want) throttled('behind'); }, T.gapMs);
          }
          else if (p.n === self.moveN && p.h !== fingerprint(self.game, self.moveN)) { emit('debug', 'beat-mismatch n=' + p.n); throttled('desync'); }
          else if (p.n < self.moveN) for (let k = p.n + 1; k <= self.moveN; k++) if (log[k]) transport.send('move', log[k]); // host missed these
          break;
        case 'claim':
          if (!amHost()) break;
          if (self.lobby.phase === 'lobby') { if (seatPerson(p.seat, fromKey, p.name)) commitLobby(); }
          else reconcileSeats();
          break;
        case 'unclaim':
          if (amHost() && self.lobby.phase === 'lobby') { const s = self.lobby.seats[p.seat]; if (s && s.owner === fromKey) self.setSeat(p.seat, { type: 'open' }); }
          break;
        case 'bye':
          leftKeys.add(fromKey);
          refreshHost();
          if (amHost()) expire(fromKey, true);
          break;
      }
    });

    if (transport.onStatus) transport.onStatus((status) => {
      emit('connection', status);
      if (status === 'reconnected' && !closed) { track(); setReady(false); startHelloLoop('reconnect'); }
    });

    function sendBeat() {
      if (!amHost() || !self.lobby) return;
      const b = { rev: self.lobby.rev, gid: self.lobby.gameId, n: self.moveN };
      if (self.started) b.h = fingerprint(self.game, self.moveN);
      transport.send('beat', b);
    }
    (function beat() { sendBeat(); later(beat, T.beatMs); })();

    self.leave = function () {
      if (closed) return;
      try { transport.send('bye', {}); } catch (e) {}
      closed = true;
      timers.forEach((id) => clearTimeout(id)); timers.clear();
      transport.leave();
    };

    // Every handler is registered; now announce myself and, if I'm joining, ask for the room state.
    track();
    refreshHost();
    if (!self.ready) startHelloLoop('join');
  }

  return { Room, makeCode, seatCountFor, fingerprint, DEFAULT_TIMING };
});
