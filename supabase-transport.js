/* Adapts a Supabase Realtime channel to the transport interface Room expects.
   Uses only Realtime (broadcast + presence) on a room-scoped channel name —
   no database tables are read or written. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CornerstoneSupabaseTransport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const URL = 'https://hzjpxzptgiocpkxnzfsd.supabase.co';
  const KEY = 'sb_publishable_vcLy8pj4AsaOTGavLwJbtA_Ld3UuGG0';

  function makeKey() {
    return 'p-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function connect(client, code, onReady, onError) {
    const key = makeKey();
    const joinedAt = Date.now();
    const channel = client.channel('cornerstone-room-' + code, { config: { presence: { key }, broadcast: { self: false, ack: false } } });
    const presenceCbs = [], msgCbs = [];
    let myMeta = { name: 'Player' };

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      const list = Object.keys(state).map((k) => {
        const entries = state[k];
        const e = entries[0] || {};
        return { key: k, joinedAt: e.joinedAt || 0, name: e.name || 'Player' };
      });
      presenceCbs.forEach((cb) => cb(list));
    });
    channel.on('broadcast', { event: 'msg' }, ({ payload }) => {
      msgCbs.forEach((cb) => cb(payload.event, payload.data, payload.from));
    });
    channel.subscribe((status, err) => {
      console.log('[Cornerstone] realtime channel status:', status, err || '');
      if (status === 'SUBSCRIBED') {
        channel.track(Object.assign({ joinedAt }, myMeta));
        onReady(transport);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        onError && onError(status, err);
      }
    });

    const transport = {
      myKey: () => key,
      track(meta) { myMeta = meta; channel.track(Object.assign({ joinedAt }, myMeta)); },
      onPresence(cb) { presenceCbs.push(cb); },
      onMessage(cb) { msgCbs.push(cb); },
      send(event, data) { channel.send({ type: 'broadcast', event: 'msg', payload: { event, data, from: key } }); },
      leave() { channel.untrack(); client.removeChannel(channel); }
    };
    return transport;
  }

  return { connect, URL, KEY };
});
