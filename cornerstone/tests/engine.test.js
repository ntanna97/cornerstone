const E = require('../engine.js');
const assert = require('assert');
// piece set
assert.strictEqual(E.PIECES.length, 21);
const sizes = E.PIECES.map(p => p.size);
assert.deepStrictEqual([1,2,3,4,5].map(s => sizes.filter(x => x===s).length), [1,1,2,5,12]);
assert.strictEqual(sizes.reduce((a,b)=>a+b,0), 89);
// orientation counts (known free-polyomino symmetry classes)
const oc = Object.fromEntries(E.PIECES.map(p => [p.id, p.orients.length]));
assert.strictEqual(oc.f, 8); assert.strictEqual(oc.x, 1); assert.strictEqual(oc.line5, 2); assert.strictEqual(oc.square, 1);
assert.strictEqual(oc.t5, 4); assert.strictEqual(oc.w, 4); assert.strictEqual(oc.z, 4); assert.strictEqual(oc.n, 8);
// all 21 pieces distinct free shapes
const canon = p => { const ks = p.orients.map(o => o.map(c=>c.join(',')).join(';')).sort(); return ks[0]; };
assert.strictEqual(new Set(E.PIECES.map(canon)).size, 21);

// first move rules
let g = E.newGame();
assert.ok(E.check(g, 0, [[19,0]]).ok);
assert.strictEqual(E.check(g, 0, [[5,5]]).reason, 'start');
assert.strictEqual(E.check(g, 0, [[19,0],[20,0]]).reason, 'off');
E.apply(g, 0, 0, [[19,0]]);
assert.strictEqual(E.check(g, 0, [[18,0]]).reason, 'side');
assert.ok(E.check(g, 0, [[18,1]]).ok);
assert.strictEqual(E.check(g, 0, [[10,10]]).reason, 'corner');
assert.strictEqual(E.check(g, 0, [[19,0]]).reason, 'overlap');
// other colours may touch sides freely
assert.ok(E.check(g, 1, [[19,19]]).ok);
// full random games with every bot level, validity + scoring sanity
for (const levels of [['easy','easy','easy','easy'],['hard','medium','easy','hard']]) {
  const t0 = Date.now();
  g = E.newGame();
  let guard = 0;
  while (!g.out.every(Boolean) && guard++ < 400) {
    const c = g.turn;
    if (!g.out[c]) {
      const m = E.botChoose(g, c, levels[c]);
      if (!m) g.out[c] = true;
      else { assert.ok(E.check(g, c, m.cells).ok); E.apply(g, c, m.p, m.cells); }
    }
    g.turn = (c+1)%4;
  }
  assert.ok(g.out.every(Boolean));
  const scores = [0,1,2,3].map(c => E.score(g,c));
  console.log(levels.join('/'), 'scores', scores, 'left', [0,1,2,3].map(c=>E.remaining(g,c)), (Date.now()-t0)+'ms');
  scores.forEach(s => assert.ok(s <= 20 && s >= -89));
}
// hard vs easy, hard should win most games
let hardWins = 0; const R = 12;
for (let i=0;i<R;i++){
  g = E.newGame(); let guard=0; const lv=['hard','easy','hard','easy'];
  while (!g.out.every(Boolean) && guard++<400){ const c=g.turn; if(!g.out[c]){const m=E.botChoose(g,c,lv[c]); if(!m) g.out[c]=true; else E.apply(g,c,m.p,m.cells);} g.turn=(c+1)%4; }
  const h=E.remaining(g,0)+E.remaining(g,2), e=E.remaining(g,1)+E.remaining(g,3);
  if (h<e) hardWins++;
}
console.log('hard team beat easy team', hardWins, '/', R);
assert.ok(hardWins >= R*0.7);
// findTransform round trip
const p = E.PIECES.find(x=>x.id==='f').idx;
const cells = E.transform(p, 3, true).map(([x,y])=>[x+4,y+7]);
const tf = E.findTransform(p, cells);
assert.strictEqual(JSON.stringify(E.transform(p,tf.rot,tf.flip)), JSON.stringify(E.transform(p,3,true)));
console.log('engine tests passed');
