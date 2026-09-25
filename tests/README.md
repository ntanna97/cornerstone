Run with `npm install` (installs jsdom, dev-only) then `npm test`, or individually:

    node tests/engine.test.js        # rules, piece set, computer players
    node tests/net.test.js           # online protocol: 19 scenarios with simulated devices
    node tests/smoke.test.js         # full 2/3/4-player local games through the real UI
    node tests/online-smoke.test.js  # 4 copies of the real app playing online through the UI

None of these touch the internet or Supabase. `fakenet.js` simulates the realtime network, and
is deliberately harsher than the real one: random delay on every message, devices dropping off
and reconnecting, page reloads, and lost messages.

The online tests involve timing, so run them a few times after changing `net.js` or the online
part of `app.js`. A rare failure is a real bug, not noise. Both bugs found this way were ones
real players would have hit.
