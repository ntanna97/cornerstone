const { JSDOM } = require('jsdom');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script src[^>]*><\/script>/g, '');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window;
const errors = [];
w.addEventListener('error', e => errors.push(e.message));
// stubs
const ctxStub = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
w.scrollTo = () => {}; w.confirm = () => true;
w.eval(fs.readFileSync(path.join(root, 'engine.js'), 'utf8'));
w.eval(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
const $ = s => w.document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const api = w.__cornerstone;
  // make bots instant
  w.localStorage.setItem('cornerstone.settings', JSON.stringify({ speed: 'fast', sound: false, motion: true }));
  $('#menu-play').click();
  if ($('#screen-setup').hidden) throw new Error('setup not shown');
  // switch to 2 players and back to 4
  w.document.querySelector('input[name=mode][value="2"]').checked = true;
  w.document.querySelector('input[name=mode][value="2"]').dispatchEvent(new w.Event('change'));
  if (w.document.querySelectorAll('.seat').length !== 2) throw new Error('2 seats expected');
  w.document.querySelector('input[name=mode][value="4"]').checked = true;
  w.document.querySelector('input[name=mode][value="4"]').dispatchEvent(new w.Event('change'));
  if (w.document.querySelectorAll('.seat').length !== 4) throw new Error('4 seats expected');
  $('#setup-start').click();
  await sleep(50);
  if ($('#screen-game').hidden) throw new Error('game not shown');
  const S = api.S;
  if (!S.humanTurn) throw new Error('should be human turn (blue first)');
  if (w.document.querySelectorAll('#tray .piece').length !== 21) throw new Error('21 pieces expected');
  if ($('#btn-undo') || $('#hand-preview')) throw new Error('undo button / piece showcase should have been removed');
  // selecting a piece from the tray should immediately drop a ghost cursor on the board, no board tap needed
  [...w.document.querySelectorAll('#tray .piece')][0].click();
  if (!S.sel) throw new Error('selecting a tray piece should set S.sel');
  if (!S.cursor) throw new Error('selecting a piece should auto-place a ghost cursor on the board');
  const before = { x: S.cursor.x, y: S.cursor.y };
  // the on-screen d-pad should move that cursor one square at a time and lock it
  if ($('#dpad-right').disabled) throw new Error('dpad-right should be enabled once a piece is selected');
  $('#dpad-right').click();
  if (S.cursor.x !== Math.min(19, before.x + 1) || S.cursor.y !== before.y) throw new Error('dpad-right did not move the cursor by one square');
  if (!S.locked) throw new Error('moving via the dpad should lock the cursor');
  $('#dpad-down').click();
  if (S.cursor.y !== Math.min(19, before.y + 1)) throw new Error('dpad-down did not move the cursor');
  // hide/show the bottom control panel
  if ($('#hand-body').hidden) throw new Error('controls should start visible');
if ($('#hand-toggle')) throw new Error('the Hide button should be gone');
  // illegal placement shows a reason
  $('#board').dispatchEvent(new w.MouseEvent('click', { clientX: 0, clientY: 0 }));
  if (!/first piece/.test($('#status-sub').textContent)) throw new Error('expected first-piece reason, got: ' + $('#status-sub').textContent);
  // play the whole game through the UI using the hint button
  let turns = 0;
  while (!S.over && turns < 60) {
    for (let i = 0; i < 800 && !S.humanTurn && !S.over; i++) await sleep(10);
    if (S.over) break;
    $('#btn-hint').click();
    if ($('#btn-place').disabled) throw new Error('place disabled after hint; turn '+turns+' humanTurn '+S.humanTurn+' sel '+JSON.stringify(S.sel)+' cur '+JSON.stringify(S.cursor)+' gturn '+S.game.turn);
    $('#btn-place').click();
    turns++;
  }
  for (let i = 0; i < 1500 && !S.over; i++) await sleep(20);
  if (!S.over) throw new Error('game did not finish, turns ' + turns);
  await sleep(900);
  if (!$('#dlg-over').hasAttribute('open')) throw new Error('results dialog not open');
  console.log('title:', $('#over-title').textContent);
  console.log($('#over-body').textContent.replace(/\s+/g,' ').slice(0,300));
  // undo test: new 3-player game
  $('#over-again').click(); await sleep(30);
  // stats
  $('#menu-stats') ; 
  const hist = JSON.parse(w.localStorage.getItem('cornerstone.games'));
  if (hist.length !== 1) throw new Error('history not saved');
  // 3-player & 2-player smoke
  for (const mode of [3, 2]) {
    api.config.mode = mode; api.config.seats.forEach((s, i) => { s.type = i === 0 ? 'human' : 'bot'; });
    api.startGame(); await sleep(30);
    let t = 0;
    while (!api.S.over && t < 80) {
      for (let i = 0; i < 800 && !api.S.humanTurn && !api.S.over; i++) await sleep(10);
      if (api.S.over) break;
      $('#btn-hint').click(); $('#btn-place').click(); t++;
    }
    for (let i = 0; i < 1500 && !api.S.over; i++) await sleep(20);
    if (!api.S.over) throw new Error('mode ' + mode + ' did not finish');
    console.log('mode', mode, 'finished:', w.document.querySelector('#over-title').textContent);
    w.document.querySelector('#over-menu').click();
  }
  if (errors.length) throw new Error('runtime errors: ' + errors.join('; '));
  console.log('smoke tests passed');
  process.exit(0);
})().catch(e => { console.error('FAIL', e.stack || e.message); process.exit(1); });
