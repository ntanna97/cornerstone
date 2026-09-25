# Cornerstone

A game of corners for 1 to 4 players. Fit as many of your 21 pieces on a 20 x 20 board as you can, and let your pieces touch only at the corners.

Built to be comfortable for older players and anyone with low vision.

## Accessibility

- Atkinson Hyperlegible typeface (designed by the Braille Institute for low-vision readers)
- Three text sizes, plus a high-contrast mode
- Colour is never the only signal: every colour has its own shape (circle, triangle, square, diamond)
- Large tap targets and a "Place piece" confirm step
- On-screen ▲ ◀ ▶ ▼ buttons to move a selected piece one square at a time, no dragging required
- A collapsible bottom control panel ("Hide controls") to free up screen space on small phones
- A ghost preview of the selected piece appears on the board immediately, before you tap anywhere
- "Show me where I can play" markers and a "Suggested move" button
- Plain-language reasons when a move isn't allowed ("It touches one of your own pieces along a side...")
- Full keyboard play, screen-reader announcements, optional read-aloud turns
- Board zoom up to 230%, reduce-movement option

## Play modes

- 2 players (two colours each), 3 players (fourth colour shared), 4 players
- Any seat can be a person or the computer (Gentle, Friendly challenge, Tough)
- Advanced scoring: -1 per square left, +15 for placing every piece, +5 more if the single square goes last
- Every finished game is saved on the device (score, squares left, time); "My scores" can export a CSV

## Online play

"Play online with friends" creates a 5-letter room code; anyone with the code can join from
their own device (each browser tab is one seat). One player hosts and can assign any open
seat to another person or to the computer, then starts the game. From there:

- Every move is validated by the same rules engine on every device — nobody can cheat by
  sending an illegal move, and no server ever runs game logic.
- If the host disconnects, another connected player automatically takes over hosting.
- If a person disconnects mid-game, the computer quietly takes their seat so the game
  doesn't stall; if they come back, they'd need to rejoin as a new seat.
- Someone can join a room in progress and watch, or rejoin after a refresh, and gets caught
  up to the current board automatically.

Online play uses only [Supabase Realtime](https://supabase.com/realtime) as a message relay
(presence + broadcast) scoped to that one room code — no database table is read or written,
and no game state is stored on a server anywhere. `supabase-transport.js` holds the project
URL and a public anon key (safe to expose; it grants no access beyond that relay), and
`net.js` holds the actual sync protocol and is fully unit-tested with a fake in-memory
transport, so it never needs a live connection to verify correctness (see `tests/README.md`).

## Run it

No build step. Open `index.html`, or serve the folder:

```bash
python3 -m http.server 8000
```

## Tests

See `tests/README.md`. In short:

```bash
npm install
npm test
```

## Deploy to GitHub Pages

1. Push this folder to a new repo on your GitHub.
2. In the repo: Settings > Pages > Build and deployment > Source: **GitHub Actions**.
3. Push to `main`. The included workflow publishes it at `https://<your-username>.github.io/<repo-name>/`.

## Credits and IP

Cornerstone is an original implementation of a corner-touching tile-placement game. It is not affiliated with or endorsed by Mattel. "Blokus" is a trademark of its owner and is not used in the game, its art or its name. The game's underlying idea is credited by its publisher to Bernard Tavitian.
