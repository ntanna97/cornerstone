/* Cornerstone — game engine (rules, legal moves, scoring, computer players).
   No DOM in here, so it can be tested in Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Cornerstone = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const N = 20;

  // Play order is clockwise: blue, yellow, red, green.
  // corner = [x, y] of the square each colour's first piece must cover.
  const COLORS = [
    { id: 'blue',   name: 'Blue',   corner: [N - 1, 0] },
    { id: 'yellow', name: 'Yellow', corner: [N - 1, N - 1] },
    { id: 'red',    name: 'Red',    corner: [0, N - 1] },
    { id: 'green',  name: 'Green',  corner: [0, 0] }
  ];

  const DEFS = [
    ['dot', 'Dot', [[0,0]]],
    ['domino', 'Domino', [[0,0],[1,0]]],
    ['line3', 'Line of 3', [[0,0],[1,0],[2,0]]],
    ['bend3', 'Bend of 3', [[0,0],[0,1],[1,1]]],
    ['line4', 'Line of 4', [[0,0],[1,0],[2,0],[3,0]]],
    ['square', 'Square', [[0,0],[1,0],[0,1],[1,1]]],
    ['t4', 'Small T', [[0,0],[1,0],[2,0],[1,1]]],
    ['l4', 'Small L', [[0,0],[0,1],[0,2],[1,2]]],
    ['s4', 'Zig-zag', [[0,0],[1,0],[1,1],[2,1]]],
    ['f', 'F-shape', [[1,0],[2,0],[0,1],[1,1],[1,2]]],
    ['line5', 'Line of 5', [[0,0],[1,0],[2,0],[3,0],[4,0]]],
    ['l5', 'Long L', [[0,0],[0,1],[0,2],[0,3],[1,3]]],
    ['n', 'N-shape', [[0,0],[0,1],[1,1],[1,2],[1,3]]],
    ['p', 'P-shape', [[0,0],[1,0],[0,1],[1,1],[0,2]]],
    ['t5', 'Big T', [[0,0],[1,0],[2,0],[1,1],[1,2]]],
    ['u', 'U-shape', [[0,0],[2,0],[0,1],[1,1],[2,1]]],
    ['v', 'Big corner', [[0,0],[0,1],[0,2],[1,2],[2,2]]],
    ['w', 'Staircase', [[0,0],[0,1],[1,1],[1,2],[2,2]]],
    ['x', 'Plus', [[1,0],[0,1],[1,1],[2,1],[1,2]]],
    ['y', 'Y-shape', [[0,0],[0,1],[0,2],[0,3],[1,1]]],
    ['z', 'Z-shape', [[0,0],[1,0],[1,1],[1,2],[2,2]]]
  ];

  function normalize(cells) {
    let mx = Infinity, my = Infinity;
    for (const [x, y] of cells) { if (x < mx) mx = x; if (y < my) my = y; }
    return cells.map(([x, y]) => [x - mx, y - my]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  }
  function transformRaw(cells, rot, flip) {
    let c = cells.map(([x, y]) => (flip ? [-x, y] : [x, y]));
    for (let i = 0; i < (rot % 4); i++) c = c.map(([x, y]) => [-y, x]);
    return normalize(c);
  }
  const key = (cells) => cells.map((c) => c.join(',')).join(';');

  const PIECES = DEFS.map(([id, name, base], idx) => {
    const seen = new Map();
    for (let f = 0; f < 2; f++) for (let r = 0; r < 4; r++) {
      const o = transformRaw(base, r, !!f);
      const k = key(o);
      if (!seen.has(k)) seen.set(k, o);
    }
    return { idx, id, name, size: base.length, base: normalize(base), orients: [...seen.values()] };
  });

  function transform(p, rot, flip) { return transformRaw(PIECES[p].base, rot, flip); }
  function findTransform(p, absCells) {
    const target = key(normalize(absCells));
    for (let f = 0; f < 2; f++) for (let r = 0; r < 4; r++) {
      if (key(transform(p, r, !!f)) === target) return { rot: r, flip: !!f };
    }
    return { rot: 0, flip: false };
  }

  function newGame() {
    return {
      board: new Int8Array(N * N).fill(-1),
      used: [0, 1, 2, 3].map(() => new Array(PIECES.length).fill(false)),
      first: [true, true, true, true],
      lastPiece: [null, null, null, null],
      placed: [0, 0, 0, 0],
      out: [false, false, false, false],
      turn: 0,
      meta: {}
    };
  }
  function cloneGame(g) {
    return {
      board: Int8Array.from(g.board),
      used: g.used.map((u) => u.slice()),
      first: g.first.slice(),
      lastPiece: g.lastPiece.slice(),
      placed: g.placed.slice(),
      out: g.out.slice(),
      turn: g.turn,
      meta: JSON.parse(JSON.stringify(g.meta || {}))
    };
  }

  const EDGE = [[1,0],[-1,0],[0,1],[0,-1]];
  const DIAG = [[1,1],[1,-1],[-1,1],[-1,-1]];
  const inB = (x, y) => x >= 0 && y >= 0 && x < N && y < N;

  // Returns { ok, reason } — reason is one of: off, overlap, side, start, corner
  function check(g, c, cells) {
    const b = g.board;
    for (const [x, y] of cells) {
      if (!inB(x, y)) return { ok: false, reason: 'off' };
      if (b[y * N + x] !== -1) return { ok: false, reason: 'overlap' };
    }
    let diag = false, start = false;
    const [sx, sy] = COLORS[c].corner;
    for (const [x, y] of cells) {
      for (const [dx, dy] of EDGE) {
        const nx = x + dx, ny = y + dy;
        if (inB(nx, ny) && b[ny * N + nx] === c) return { ok: false, reason: 'side' };
      }
      for (const [dx, dy] of DIAG) {
        const nx = x + dx, ny = y + dy;
        if (inB(nx, ny) && b[ny * N + nx] === c) diag = true;
      }
      if (x === sx && y === sy) start = true;
    }
    if (g.first[c]) return start ? { ok: true } : { ok: false, reason: 'start' };
    return diag ? { ok: true } : { ok: false, reason: 'corner' };
  }

  // Empty squares where colour c could attach a new piece.
  function frontier(g, c) {
    const out = [];
    const b = g.board;
    if (g.first[c]) {
      const [sx, sy] = COLORS[c].corner;
      if (b[sy * N + sx] === -1) out.push([sx, sy]);
      return out;
    }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (b[y * N + x] !== -1) continue;
      let ok = true;
      for (const [dx, dy] of EDGE) {
        const nx = x + dx, ny = y + dy;
        if (inB(nx, ny) && b[ny * N + nx] === c) { ok = false; break; }
      }
      if (!ok) continue;
      for (const [dx, dy] of DIAG) {
        const nx = x + dx, ny = y + dy;
        if (inB(nx, ny) && b[ny * N + nx] === c) { out.push([x, y]); break; }
      }
    }
    return out;
  }

  function legalMoves(g, c, onlyOne) {
    const fr = frontier(g, c);
    const moves = [];
    if (!fr.length) return moves;
    for (let p = 0; p < PIECES.length; p++) {
      if (g.used[c][p]) continue;
      const orients = PIECES[p].orients;
      const seen = new Set();
      for (let o = 0; o < orients.length; o++) {
        const orient = orients[o];
        for (let i = 0; i < fr.length; i++) {
          const fx = fr[i][0], fy = fr[i][1];
          for (let j = 0; j < orient.length; j++) {
            const ox = fx - orient[j][0], oy = fy - orient[j][1];
            const k = o * 100000 + (ox + 50) * 200 + (oy + 50);
            if (seen.has(k)) continue;
            seen.add(k);
            const cells = orient.map(([a, b2]) => [a + ox, b2 + oy]);
            if (check(g, c, cells).ok) {
              moves.push({ p, o, ox, oy, cells });
              if (onlyOne) return moves;
            }
          }
        }
      }
    }
    return moves;
  }
  const hasMove = (g, c) => legalMoves(g, c, true).length > 0;

  function apply(g, c, p, cells) {
    for (const [x, y] of cells) g.board[y * N + x] = c;
    g.used[c][p] = true;
    g.first[c] = false;
    g.lastPiece[c] = p;
    g.placed[c]++;
  }

  function remaining(g, c) {
    let s = 0;
    for (let p = 0; p < PIECES.length; p++) if (!g.used[c][p]) s += PIECES[p].size;
    return s;
  }
  function piecesLeft(g, c) { return g.used[c].filter((u) => !u).length; }
  // Advanced scoring: -1 per square left; +15 for placing everything; +5 more if the dot went last.
  function score(g, c) {
    const r = remaining(g, c);
    let s = -r;
    if (r === 0) { s += 15; if (g.lastPiece[c] === 0) s += 5; }
    return s;
  }

  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  // level: 'easy' | 'medium' | 'hard'
  function botChoose(g, c, level) {
    const moves = legalMoves(g, c);
    if (!moves.length) return null;
    if (level === 'easy') {
      const big = moves.filter((m) => m.cells.length >= 4);
      return pick(Math.random() < 0.5 && big.length ? big : moves);
    }
    const hard = level === 'hard';
    const left = piecesLeft(g, c);
    const maxSize = Math.max(...moves.map((m) => m.cells.length));
    let pool = moves.filter((m) => m.cells.length >= maxSize - 1);
    if (left > 1) { const noDot = pool.filter((m) => m.cells.length > 1); if (noDot.length) pool = noDot; }
    shuffle(pool);
    pool = pool.slice(0, hard ? 300 : 120);

    const ownBefore = frontier(g, c).length;
    const foes = [0, 1, 2, 3].filter((k) => k !== c && !g.out[k]);
    const foeBefore = hard ? foes.reduce((s, k) => s + frontier(g, k).length, 0) : 0;
    let best = null, bestScore = -Infinity;
    for (const m of pool) {
      const wasFirst = g.first[c];
      for (const [x, y] of m.cells) g.board[y * N + x] = c;
      g.first[c] = false;
      const ownAfter = frontier(g, c).length;
      const foeAfter = hard ? foes.reduce((s, k) => s + frontier(g, k).length, 0) : 0;
      for (const [x, y] of m.cells) g.board[y * N + x] = -1;
      g.first[c] = wasFirst;

      let s = m.cells.length * (hard ? 4 : 3);
      s += (ownAfter - ownBefore) * (hard ? 1.3 : 0.6);
      if (hard) s += (foeBefore - foeAfter) * 1.5;
      s += Math.random() * (hard ? 0.6 : 2.5);
      if (hard && g.placed[c] < 5) {
        const d = m.cells.reduce((t, [x, y]) => t + Math.hypot(x - 9.5, y - 9.5), 0) / m.cells.length;
        s -= d * 0.5;
      }
      if (m.cells.length === 1 && left > 1) s -= 12;
      if (s > bestScore) { bestScore = s; best = m; }
    }
    return best;
  }

  function serialize(g) {
    return {
      board: Array.from(g.board),
      used: g.used,
      first: g.first,
      lastPiece: g.lastPiece,
      placed: g.placed,
      out: g.out,
      turn: g.turn,
      meta: g.meta
    };
  }
  function deserialize(s) {
    return {
      board: Int8Array.from(s.board),
      used: s.used.map((u) => u.slice()),
      first: s.first.slice(),
      lastPiece: s.lastPiece.slice(),
      placed: s.placed.slice(),
      out: s.out.slice(),
      turn: s.turn,
      meta: JSON.parse(JSON.stringify(s.meta || {}))
    };
  }

  return { N, COLORS, PIECES, newGame, cloneGame, check, frontier, legalMoves, hasMove, apply,
           remaining, piecesLeft, score, botChoose, transform, findTransform, serialize, deserialize };
});
