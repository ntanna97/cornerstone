/* Adapts a Supabase Realtime channel to the transport interface net.js expects.
   Uses only Realtime broadcast + presence on a channel named after the room code.
   No database tables are read or written. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CornerstoneSupabaseTransport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const URL = 'https://hzjpxzptgiocpkxnzfsd.supabase.co';
  const KEY = 'sb_publishable_vcLy8pj4AsaOTGavLwJbtA_Ld3UuGG0';

  // opts.key: a stable id for this browser tab, so a page reload rejoins as the same player.
  function connect(client, code, onReady, onError, opts) {
    opts = opts || {};
    const key = opts.key || ('p-' + Math.random().toString(36).slice(2, 10));
    const channel = client.channel('cornerstone-room-' + code, { config: { presence: { key }, broadcast: { self: false, ack: false } } });
    const presenceCbs = [], msgCbs = [], statusCbs = [];
    let myMeta = { name: 'Player' };
    let everSubscribed = false, lost = false;
    // Back online: re-announce presence and tell the room so it can catch up on anything missed.
    // Called from the subscribe callback, and also if traffic arrives after a drop (in case the
    // library rejoins without calling the subscribe callback again).
    function recovered() {
      if (!lost) return;
      lost = false;
      try { channel.track(myMeta); } catch (e) {}
      statusCbs.forEach((cb) => cb('reconnected'));
    }

    channel.on('presence', { event: 'sync' }, () => {
      recovered();
      const state = channel.presenceState();
      const list = Object.keys(state).map((k) => {
        // the same key can briefly appear twice (old socket + new one after a reload): use the newest
        const metas = (state[k] || []).slice().sort((a, b) => (b.t || 0) - (a.t || 0));
        const m = metas[0] || {};
        return { key: k, name: m.name || 'Player', ready: !!m.ready, t: m.t || 0 };
      });
      presenceCbs.forEach((cb) => cb(list));
    });
    channel.on('broadcast', { event: 'msg' }, ({ payload }) => {
      if (!payload || payload.from === key) return;
      recovered();
      msgCbs.forEach((cb) => cb(payload.event, payload.data, payload.from));
    });
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        channel.track(myMeta);
        if (!everSubscribed) { everSubscribed = true; onReady(transport); }
        else recovered();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (!everSubscribed) { onError && onError(status, err); return; }
        if (!lost && status !== 'CLOSED') { lost = true; statusCbs.forEach((cb) => cb('lost')); }
      }
    });

    const transport = {
      myKey: () => key,
      track(meta) { myMeta = meta; if (everSubscribed) channel.track(meta); },
      onPresence(cb) { presenceCbs.push(cb); },
      onMessage(cb) { msgCbs.push(cb); },
      onStatus(cb) { statusCbs.push(cb); },
      send(event, data) { channel.send({ type: 'broadcast', event: 'msg', payload: { event, data, from: key } }); },
      leave() { try { channel.untrack(); } catch (e) {} client.removeChannel(channel); }
    };
    return transport;
  }

  return { connect, URL, KEY };
});
