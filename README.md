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
- On phones and tablets the whole game fits on one screen: board, your pieces and the controls are
  visible together, with no scrolling during your turn
- Picking a piece zooms in on it (28-44px squares) and places it where it fits; after your move the
  view zooms back out so you can see everyone else's moves
- Taps don't need to be precise: tap near where you want a piece and it snaps to the closest spot it
  fits (turning it if needed). You can also drag the piece with a finger, or hold an arrow to keep moving

## Play modes

- 2 players (two colours each), 3 players (fourth colour shared), 4 players
- Any seat can be a person or the computer (Gentle, Friendly challenge, Tough)
- Advanced scoring: -1 per square left, +15 for placing every piece, +5 more if the single square goes last
- Every finished game is saved on the device (score, squares left, time); "My scores" can export a CSV

## Online play

"Play online with friends": the host types their name and creates a room. They get a large
5-letter room code and a **Share invite** button (opens the phone's share sheet, so the link can
go straight into a text message). Friends tap the link, type their name, and are seated
automatically. The host can give empty seats to the computer, then presses Start.

Built to survive real phones and real Wi-Fi:

- **Phones locking or Wi-Fi blips:** a player who drops keeps their seat for 45 seconds. Everyone
  else sees "Waiting for Alex to reconnect". After that the computer plays for them, and they get
  the seat back automatically when they return.
- **Page reloads:** reloading mid-game puts you straight back in your own seat.
- **Host leaves:** the next seated player takes over automatically, including running any
  computer players.
- **Missed or out-of-order messages:** every move carries a sequence number and a fingerprint of
  the board. Early moves are held and applied in order, and the host sends a heartbeat every few
  seconds so any device that falls behind catches up. No single lost message can stall the game.
- **No cheating:** every device checks every move with the same rules engine. A move out of turn,
  illegal, or from a device whose board differs is rejected and that device is corrected.
- **Screen stays on** during online play (where the browser supports it).

Online play uses only [Supabase Realtime](https://supabase.com/realtime) as a message relay
(presence + broadcast) on a channel named after the room code. No database table is read or
written, and no game state is stored on a server. `supabase-transport.js` holds the project URL
and a public key (safe to expose; it only allows that relay). The sync protocol is in `net.js`.

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
