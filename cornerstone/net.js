/* Cornerstone — online play. A Room runs the same rules as the local game,
   but moves are proposed by whoever's colour it is and broadcast to
   everyone else, who validate and apply them. No server-side game logic;
   the only shared backend service is a Supabase Realtime channel used as
   a message bus + presence list, scoped to one room code.

   Two kinds of index appear here and must not be confused:
     - a "seat" (0..seatCount-1) is a human slot in the lobby that a person
       can sit in — 2, 3 or 4 of them depending on mode;
     - a "colour" (0..3, always blue/yellow/red/green) is what the engine
       actually plays a turn for. In 4-player mode seat == colour. In
       2-player each seat controls two colours. In 3-player the 4th colour
       is shared and rotates between the three seats as it's played.

   Room depends only on a "transport" with this shape, so it can be unit
   tested without a network:
     transport.onPresence(cb)         // cb(list) list = [{key,name,joinedAt}]
     transport.onMessage(cb)          // cb(event, payload, fromKey)
     transport.send(event, payload)   // broadcast to the room
     transport.track(meta)            // update my own presence payload
     transport.myKey()                // my stable presence key
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
  function emptySeats(mode) {
    return Array.from({ length: seatCountFor(mode) }, (_, i) => ({ type: i === 0 ? 'human' : 'open', owner: null, name: '', level: 'medium' }));
  }

  function Room(transport, opts) {
    const self = this;
    let engineRef = opts.engine || null;
    self.bindEngine = function (E) { engineRef = E; };
    const handlers = {};
    const on = (ev, cb) => { (handlers[ev] = handlers[ev] || []).push(cb); };
    const emit = (ev, a, b) => { (handlers[ev] || []).forEach((cb) => cb(a, b)); };
    self.on = on;

    self.code = opts.code;
    self.myName = opts.name || 'Player';
    self.myKey = transport.myKey();
    self.isHost = !!opts.host;
    self.hostKey = self.isHost ? self.myKey : null;
    self.lobby = opts.host ? { mode: opts.mode || 4, seats: emptySeats(opts.mode || 4), hostKey: self.myKey } : null;
    self.presence = [];
    self.game = null;
    self.moveN = 0;      // last applied move sequence number
    self.started = false;
    self.leftAt = 0;

    if (self.isHost) self.lobby.seats[0] = { type: 'human', owner: self.myKey, name: self.myName, level: 'medium' };

    function amHost() { return self.hostKey === self.myKey; }
    function electHost(list) {
      const alive = list.slice().sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0) || a.key.localeCompare(b.key));
      return alive.length ? alive[0].key : self.myKey;
    }
    // -- colour <-> seat mapping --
    function isSharedColor(c) { return self.lobby.mode === 3 && c === 3; }
    function seatIndexForColor(c) {
      const mode = self.lobby.mode;
      if (mode === 2) return c % 2;
      if (mode === 3) return c < 3 ? c : ((self.game && self.game.meta.sharedCount) || 0) % 3;
      return c;
    }
    function seatForColor(c) { return self.lobby.seats[seatIndexForColor(c)]; }
    function myColors() { return [0, 1, 2, 3].filter((c) => seatForColor(c).owner === self.myKey); }
    // colours this client is responsible for acting on: my own, plus bot/open colours if I'm host
    function actingColors() {
      if (!self.lobby) return [];
      return [0, 1, 2, 3].filter((c) => {
        const s = seatForColor(c);
        if (s.owner === self.myKey) return true;
        return amHost() && (s.type === 'bot' || s.type === 'open');
      });
    }
    self.myColors = myColors;
    self.actingColors = actingColors;
    self.seatForColor = seatForColor;
    self.amHost = amHost;

    let knownPresenceKeys = new Set();
    transport.onPresence((list) => {
      const keys = new Set(list.map((p) => p.key));
      const newcomers = list.filter((p) => !knownPresenceKeys.has(p.key) && p.key !== self.myKey);
      knownPresenceKeys = keys;
      self.presence = list;
      const newHost = electHost(list);
      const hostChanged = self.hostKey && self.hostKey !== newHost && !list.some((p) => p.key === self.hostKey);
      if (!self.hostKey || hostChanged) {
        self.hostKey = newHost;
        if (self.hostKey === self.myKey) {
          self.isHost = true;
          if (self.lobby) self.lobby.hostKey = self.myKey;
          orphanMissing(list);
          broadcastLobby();
          if (self.started) emit('resume');
        }
      }
      // bring a freshly-joined peer up to date, whether they arrived before or during the game.
      // uses a distinct event from 'start' so an already-playing peer isn't reset when a third
      // party joins — only a client that hasn't started yet will act on 'resync'.
      if (amHost() && newcomers.length) {
        if (self.started && engineRef) transport.send('resync', { lobby: self.lobby, game: engineRef.serialize(self.game) });
        else if (!self.started) broadcastLobby();
      }
      emit('presence', self.presence, self.hostKey);
      if (amHost() && self.started) orphanMissing(list);
    });

    function orphanMissing(list) {
      if (!self.lobby) return;
      const keys = new Set(list.map((p) => p.key));
      let changed = false;
      self.lobby.seats.forEach((s) => {
        if (s.owner && !keys.has(s.owner) && s.type === 'human') { s.type = 'bot'; s.level = s.level || 'medium'; s.owner = null; changed = true; }
      });
      if (changed) { broadcastLobby(); emit('seat-orphaned'); if (self.started) emit('resume'); }
    }

    function broadcastLobby() { if (amHost()) transport.send('lobby', self.lobby); }
    self.setMode = function (mode) {
      if (!amHost() || self.started) return;
      self.lobby.mode = mode; self.lobby.seats = emptySeats(mode);
      self.lobby.seats[0] = { type: 'human', owner: self.myKey, name: self.myName, level: 'medium' };
      broadcastLobby(); emit('lobby', self.lobby);
    };
    self.setSeat = function (i, patch) {
      if (!amHost() || self.started || !self.lobby.seats[i]) return;
      Object.assign(self.lobby.seats[i], patch);
      broadcastLobby(); emit('lobby', self.lobby);
    };
    self.claimSeat = function (i) {
      if (amHost()) { self.setSeat(i, { type: 'human', owner: self.myKey, name: self.myName }); return; }
      transport.send('claim', { seat: i, name: self.myName });
    };
    self.leaveSeat = function (i) {
      if (amHost()) { self.setSeat(i, { type: 'open', owner: null, name: '' }); return; }
      transport.send('unclaim', { seat: i });
    };
    self.startGame = function (E) {
      if (!amHost() || self.started) return;
      const bad = self.lobby.seats.some((s) => s.type === 'open');
      if (bad) { emit('start-blocked'); return; }
      self.started = true; self.moveN = 0;
      const g = E.newGame(); g.meta = { sharedCount: 0, moves: 0, last: null };
      self.game = g;
      transport.send('start', { lobby: self.lobby, game: E.serialize(g) });
      emit('start', self.lobby, g);
    };

    self.rematch = function () {
      if (!amHost() || !self.started) return;
      self.started = false; self.game = null; self.moveN = 0;
      transport.send('rematch', { lobby: self.lobby });
      emit('rematch', self.lobby);
    };

    self.proposeMove = function (color, p, cells) {
      if (!actingColors().includes(color)) return { ok: false, reason: 'not-your-colour' };
      const g = self.game, E = engineRef;
      const res = E.check(g, color, cells);
      if (!res.ok) return res;
      self.moveN++;
      const payload = { n: self.moveN, color, p, cells };
      transport.send('move', payload);
      applyMove(payload);
      return { ok: true };
    };
    self.proposePass = function (color) {
      if (!actingColors().includes(color)) return;
      self.moveN++;
      const payload = { n: self.moveN, color, pass: true };
      transport.send('move', payload);
      applyMove(payload);
    };
    function applyMove(payload) {
      const g = self.game, E = engineRef;
      if (payload.n <= self.moveN - 1000) return; // very stale, ignore
      const c = payload.color;
      if (payload.pass) {
        g.out[c] = true;
      } else {
        const res = E.check(g, c, payload.cells);
        if (!res.ok) { emit('desync', payload); requestResync(); return; }
        E.apply(g, c, payload.p, payload.cells);
        g.meta.last = { c, cells: payload.cells, p: payload.p };
        g.meta.moves++;
      }
      if (isSharedColor(c)) g.meta.sharedCount = (g.meta.sharedCount || 0) + 1;
      let nxt = (c + 1) % 4;
      while (g.out[nxt] && !g.out.every(Boolean)) nxt = (nxt + 1) % 4;
      g.turn = nxt;
      if (payload.n > self.moveN) self.moveN = payload.n;
      emit('move', payload);
    }
    function requestResync() { transport.send('hello', {}); }
    self.requestResync = requestResync;

    transport.onMessage((event, payload, fromKey) => {
      if (event === 'lobby') { self.lobby = payload; self.hostKey = payload.hostKey; emit('lobby', self.lobby); return; }
      if (event === 'start') {
        self.lobby = payload.lobby; self.started = true; self.moveN = 0;
        self.game = engineRef.deserialize(payload.game);
        emit('start', self.lobby, self.game); return;
      }
      if (event === 'move') { applyMove(payload); return; }
      if (event === 'resync') {
        if (!self.started) { // only a genuine newcomer acts on this; an already-playing peer ignores it
          self.lobby = payload.lobby; self.started = true; self.moveN = 0;
          self.game = engineRef.deserialize(payload.game);
          emit('start', self.lobby, self.game);
        }
        return;
      }
      if (event === 'rematch') { self.lobby = payload.lobby; self.started = false; self.game = null; self.moveN = 0; emit('rematch', self.lobby); return; }
      if (event === 'claim' && amHost()) {
        const s = self.lobby.seats[payload.seat];
        if (s && s.type === 'open') self.setSeat(payload.seat, { type: 'human', owner: fromKey, name: payload.name });
        return;
      }
      if (event === 'unclaim' && amHost()) {
        const s = self.lobby.seats[payload.seat];
        if (s && s.owner === fromKey) self.setSeat(payload.seat, { type: 'open', owner: null, name: '' });
        return;
      }
      if (event === 'hello' && amHost() && self.started) {
        transport.send('start', { lobby: self.lobby, game: engineRef.serialize(self.game) });
        return;
      }
    });

    self.leave = function () { self.leftAt = Date.now(); transport.leave(); };

    // registered every handler above before announcing ourselves, so a message
    // that arrives synchronously as a side-effect of track() is never missed
    transport.track({ name: self.myName });
  }

  return { Room, makeCode, seatCountFor };
});
