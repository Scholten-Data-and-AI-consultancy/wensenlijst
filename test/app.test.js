const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-'));
process.env.AANMAAKCODE = ' "Pepernoot" ';
const lib = require('../lib.js');
const { server } = require('../server.js');

function setup() {
  const db = lib.emptyDb();
  const { event, token } = lib.createEvent(db, { name: 'Kerst 2026', kind: 'kerst', date: '2026-12-25', organizerName: 'Rene', participants: ['Anna', 'Piet', 'anna', ''] });
  const [rene, anna, piet] = event.participants;
  return { db, event, token, rene, anna, piet };
}

test('creating an event makes the organizer a participant and drops duplicate names', () => {
  const { event, token, rene } = setup();
  assert.deepStrictEqual(event.participants.map(p => p.name), ['Rene', 'Anna', 'Piet']);
  assert.strictEqual(event.organizerId, rene.id);
  assert.strictEqual(rene.token, token);
  assert.strictEqual(new Set(event.participants.map(p => p.token)).size, 3);
});

test('the wisher never sees that a wish was bought, the others do', () => {
  const { db, event, rene, anna, piet } = setup();
  const { id } = lib.applyOp(db, event, anna, { type: 'addWish', title: 'Boek', url: 'bol.com/boek', price: '12,50' });
  lib.applyOp(db, event, piet, { type: 'buy', id });

  const forAnna = lib.viewEvent(event, anna);
  const own = forAnna.wishes.find(w => w.id === id);
  assert.ok(own);
  assert.ok(!('purchase' in own));
  assert.ok(!JSON.stringify(forAnna).includes('purchase'));
  assert.ok(!JSON.stringify(forAnna).includes(piet.token));

  const forRene = lib.viewEvent(event, rene);
  assert.strictEqual(forRene.wishes.find(w => w.id === id).purchase.byName, 'Piet');
  assert.strictEqual(forRene.wishes[0].url, 'https://bol.com/boek');
  assert.strictEqual(forRene.wishes[0].price, 12.5);
});

test('only the organizer sees the tokens', () => {
  const { event, rene, anna } = setup();
  assert.ok(lib.viewEvent(event, rene).participants.every(p => p.token));
  assert.ok(lib.viewEvent(event, anna).participants.every(p => !('token' in p)));
});

test('a second buyer is refused and only the buyer can undo', () => {
  const { db, event, rene, anna, piet } = setup();
  const { id } = lib.applyOp(db, event, anna, { type: 'addWish', title: 'Trui' });
  lib.applyOp(db, event, piet, { type: 'buy', id });
  assert.throws(() => lib.applyOp(db, event, rene, { type: 'buy', id }), /Piet heeft dit al gekocht/);
  assert.throws(() => lib.applyOp(db, event, rene, { type: 'unbuy', id }), e => e.status === 403);
  assert.throws(() => lib.applyOp(db, event, anna, { type: 'buy', id }), e => e.status === 403);
  lib.applyOp(db, event, piet, { type: 'unbuy', id });
  lib.applyOp(db, event, rene, { type: 'buy', id });
});

test('deleting a bought wish hides it from the wisher but tells the buyer', () => {
  const { db, event, rene, anna, piet } = setup();
  const { id } = lib.applyOp(db, event, anna, { type: 'addWish', title: 'Spel' });
  const { id: other } = lib.applyOp(db, event, anna, { type: 'addWish', title: 'Sokken' });
  lib.applyOp(db, event, piet, { type: 'buy', id });
  lib.applyOp(db, event, anna, { type: 'deleteWish', id });
  lib.applyOp(db, event, anna, { type: 'deleteWish', id: other });

  assert.strictEqual(lib.viewEvent(event, anna).wishes.length, 0);
  assert.strictEqual(lib.viewEvent(event, rene).wishes.length, 0);
  const forPiet = lib.viewEvent(event, piet).wishes;
  assert.strictEqual(forPiet.length, 1);
  assert.strictEqual(forPiet[0].deleted, true);
  assert.throws(() => lib.applyOp(db, event, piet, { type: 'buy', id }), e => e.status === 409);

  lib.applyOp(db, event, piet, { type: 'dismiss', id });
  assert.strictEqual(event.wishes.length, 0);
});

test('only the owner edits or deletes a wish', () => {
  const { db, event, anna, piet } = setup();
  const { id } = lib.applyOp(db, event, anna, { type: 'addWish', title: 'Pet' });
  assert.throws(() => lib.applyOp(db, event, piet, { type: 'editWish', id, title: 'Iets anders' }), e => e.status === 403);
  assert.throws(() => lib.applyOp(db, event, piet, { type: 'deleteWish', id }), e => e.status === 403);
  lib.applyOp(db, event, anna, { type: 'editWish', id, title: 'Rode pet', note: 'maat L' });
  assert.strictEqual(event.wishes[0].title, 'Rode pet');
});

test('input is checked', () => {
  const { db, event, anna } = setup();
  assert.throws(() => lib.applyOp(db, event, anna, { type: 'addWish', title: '' }), e => e.status === 400);
  assert.throws(() => lib.applyOp(db, event, anna, { type: 'addWish', url: 'javascript:alert(1)' }), /http of https/);
  assert.throws(() => lib.applyOp(db, event, anna, { type: 'addWish', title: 'x', price: 'veel' }), /prijs/);
  assert.strictEqual(lib.cleanPrice('1.299,95'), 1299.95);
  assert.strictEqual(lib.cleanPrice('€ 24,99'), 24.99);
  assert.strictEqual(lib.cleanPrice('12.5'), 12.5);
  // a link without a title gets the shop name
  lib.applyOp(db, event, anna, { type: 'addWish', url: 'https://www.coolblue.nl/product/1' });
  assert.strictEqual(event.wishes[0].title, 'coolblue.nl');
});

test('organizer powers: participants, links and the event itself', () => {
  const { db, event, rene, anna, piet } = setup();
  assert.throws(() => lib.applyOp(db, event, anna, { type: 'addParticipant', name: 'Kees' }), e => e.status === 403);
  lib.applyOp(db, event, rene, { type: 'addParticipant', name: 'Kees' });
  assert.throws(() => lib.applyOp(db, event, rene, { type: 'addParticipant', name: 'kees' }), e => e.status === 409);

  const old = anna.token;
  lib.applyOp(db, event, rene, { type: 'newLink', id: anna.id });
  assert.strictEqual(lib.resolve(db, old), null);
  assert.ok(lib.resolve(db, anna.token));

  // removing Piet removes his wishes and frees what he bought
  const { id: forAnna } = lib.applyOp(db, event, anna, { type: 'addWish', title: 'Mok' });
  lib.applyOp(db, event, piet, { type: 'addWish', title: 'Fiets' });
  lib.applyOp(db, event, piet, { type: 'buy', id: forAnna });
  lib.applyOp(db, event, rene, { type: 'removeParticipant', id: piet.id });
  assert.deepStrictEqual(event.wishes.map(w => [w.title, w.purchase]), [['Mok', null]]);
  assert.throws(() => lib.applyOp(db, event, rene, { type: 'removeParticipant', id: rene.id }), e => e.status === 400);

  lib.applyOp(db, event, rene, { type: 'deleteEvent' });
  assert.strictEqual(db.events.length, 0);
});

// ---------- over HTTP ----------
let base;
test.before(() => new Promise(r => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.closeAllConnections(); server.close(); });
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('http: create needs the code, then each token gets its own view', async () => {
  const input = { name: 'Sinterklaas 2026', kind: 'sinterklaas', date: '2026-12-05', organizerName: 'Rene', participants: ['Anna'] };
  assert.strictEqual((await post('/api/create', { ...input, code: 'fout' })).status, 401);
  const r = await post('/api/create', { ...input, code: 'PEPERNOOT ' });
  assert.strictEqual(r.status, 200);
  const { token } = await r.json();

  const st = await (await post('/api/state', { tokens: [token, 'onbekend-token-123'] })).json();
  assert.strictEqual(st.events.length, 1);
  assert.deepStrictEqual(st.unknown, ['onbekend-token-123']);
  const annaToken = st.events[0].participants.find(p => p.name === 'Anna').token;

  const add = await (await post('/api/op', { token: annaToken, op: { type: 'addWish', title: 'Chocoladeletter A' } })).json();
  assert.strictEqual((await post('/api/op', { token, op: { type: 'buy', id: add.result.id } })).status, 200);

  const forAnna = await (await post('/api/state', { tokens: [annaToken] })).json();
  assert.ok(!JSON.stringify(forAnna).includes('purchase'));
  assert.ok(!JSON.stringify(forAnna).includes(token));

  assert.strictEqual((await post('/api/op', { token: 'x'.repeat(22), op: { type: 'addWish', title: 'a' } })).status, 401);
  assert.strictEqual((await post('/api/op', { token: annaToken, op: { type: 'deleteEvent' } })).status, 403);
  // saved to disk
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'wensen.json'), 'utf8'));
  assert.strictEqual(saved.events.length, 1);
});

test('http: static files and no path escape', async () => {
  const r = await fetch(base + '/');
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /Wensenlijst/);
  assert.strictEqual((await fetch(base + '/../server.js')).status, 404);
  assert.strictEqual((await fetch(base + '/%2e%2e/lib.js')).status, 404);
  assert.strictEqual((await fetch(base + '/healthz')).status, 200);
});

test('http: the organizer link comes back with the code and the name', async () => {
  const r = await post('/api/create', { name: 'Kerst 2026', kind: 'kerst', date: '2026-12-25', organizerName: 'René', participants: ['Sandra'], code: 'pepernoot' });
  const { token } = await r.json();
  assert.strictEqual((await post('/api/recover', { name: 'rené', code: 'fout' })).status, 401);
  assert.strictEqual((await post('/api/recover', { name: 'Sandra', code: 'pepernoot' })).status, 404);
  const got = await (await post('/api/recover', { name: ' René ', code: 'Pepernoot' })).json();
  assert.deepStrictEqual(got.tokens, [token]);
});
