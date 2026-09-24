Run with `npm install` (installs jsdom, dev-only) then:

    node tests/engine.test.js        # rules, piece set, computer players
    node tests/net.test.js           # online play protocol: lobby, moves, host failover,
                                      # mid-game orphaning, resync, colour/seat rotation
    node tests/smoke.test.js         # plays full 2/3/4-player local games through the real UI
    node tests/online-smoke.test.js  # same, but through the online lobby + a faked realtime bus

None of these touch the network or Supabase. net.test.js and online-smoke.test.js use an
in-memory fake transport with the same shape as the real one in supabase-transport.js.
