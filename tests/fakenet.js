/* A fake realtime network for tests, modelled on how Supabase Realtime behaves:
   - each room code is an isolated channel;
   - every message has random latency, but messages between the same two
     devices arrive in the order they were sent (like a websocket);
   - presence (who's here + their metadata) is pushed to everyone on change;
   - a device can drop off (no goodbye, like a phone locking) and reconnect,
     or be replaced by a new tab with the same key (like a page reload);
   - a test can drop specific messages to simulate packet loss. */
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function makeNet(opts) {
  opts = opts || {};
  const rand = mulberry32(opts.seed || 1);
  const minDelay = opts.minDelay == null ? 1 : opts.minDelay, maxDelay = opts.maxDelay == null ? 12 : opts.maxDelay;
  const rooms = new Map();
  const chains = new Map();
  let dropRule = null;
  const stats = { sent: 0, dropped: 0 };
  const room = (code) => { if (!rooms.has(code)) rooms.set(code, new Map()); return rooms.get(code); };
  function later(pairKey, fn, delay) {
    const prev = chains.get(pairKey) || Promise.resolve();
    const d = delay != null ? delay : minDelay + Math.floor(rand() * (maxDelay - minDelay + 1));
    const next = prev.then(() => new Promise((r) => setTimeout(r, d))).then(fn);
    chains.set(pairKey, next.catch(() => {}));
  }
  function presenceOf(code) { return Array.from(room(code).values()).filter((m) => m.online).map((m) => Object.assign({ key: m.key }, m.meta)); }
  function pushPresence(code) {
    const list = presenceOf(code);
    room(code).forEach((m) => { if (m.online) later('srv>' + m.id, () => { if (m.online) m.presenceCbs.forEach((cb) => cb(list.map((x) => Object.assign({}, x)))); }); });
  }
  let ids = 0;
  const api = {
    stats,
    dropWhen(fn) { dropRule = fn; },
    join(code, key) {
      const r = room(code);
      const old = r.get(key); if (old) old.online = false; // a reload replaces the old tab
      const m = { id: ++ids, key, code, meta: {}, online: true, presenceCbs: [], msgCbs: [], statusCbs: [] };
      r.set(key, m);
      const t = {
        myKey: () => key,
        track(meta) { m.meta = Object.assign({}, meta); if (m.online) pushPresence(code); },
        onPresence(cb) { m.presenceCbs.push(cb); },
        onMessage(cb) { m.msgCbs.push(cb); },
        onStatus(cb) { m.statusCbs.push(cb); },
        send(event, payload) {
          if (!m.online) return;
          const data = JSON.parse(JSON.stringify(payload));
          r.forEach((q) => {
            if (q === m || !q.online) return;
            stats.sent++;
            if (dropRule && dropRule(event, data, key, q.key)) { stats.dropped++; return; }
            const slow = opts.delayFor ? opts.delayFor(key, q.key) : null; // lets a test make one link slower than the rest
            later(m.id + '>' + q.id, () => { if (q.online && m.id) q.msgCbs.forEach((cb) => cb(event, JSON.parse(JSON.stringify(data)), key)); }, slow);
          });
        },
        leave() { m.online = false; pushPresence(code); }
      };
      pushPresence(code);
      return t;
    },
    goOffline(code, key) { const m = room(code).get(key); if (m) { m.online = false; pushPresence(code); } },
    goOnline(code, key) {
      const m = room(code).get(key); if (!m) return;
      m.online = true; pushPresence(code);
      setTimeout(() => m.statusCbs.forEach((cb) => cb('reconnected')), 2);
    }
  };
  return api;
}
module.exports = { makeNet };
