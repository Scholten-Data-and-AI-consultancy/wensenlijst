// Wensenlijst: the data model and every rule about who may see or change what.
// The server is the only place that holds the full picture. view() cuts it down per participant,
// so a wisher's phone never receives whether one of their own wishes was bought.
const crypto = require('crypto');

const KINDS = ['sinterklaas', 'kerst', 'oudnieuw', 'verjaardag', 'anders'];
const LIMITS = { name: 40, eventName: 60, title: 120, url: 1000, note: 300, participants: 40, wishesPerPerson: 100 };

const newId = () => crypto.randomBytes(6).toString('base64url');
const newToken = () => crypto.randomBytes(16).toString('base64url');
const now = () => Date.now();

class OpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new OpError(status, message); };

function cleanText(v, max) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function cleanNote(v) {
  // Notes may keep line breaks; everything else is collapsed.
  return String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, LIMITS.note);
}
function cleanUrl(v) {
  let s = cleanText(v, LIMITS.url);
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { fail(400, 'Dit is geen geldige link'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') fail(400, 'Alleen links die met http of https beginnen');
  return u.href;
}
function cleanPrice(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[€\s]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100000) fail(400, 'Vul een geldige prijs in');
  return Math.round(n * 100) / 100;
}
function cleanDate(v) {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) fail(400, 'Kies een geldige datum');
  return s;
}
function cleanKind(v) { return KINDS.includes(v) ? v : 'anders'; }

function cleanNames(list) {
  const seen = new Set(), out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const name = cleanText(raw, LIMITS.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase()); out.push(name);
  }
  return out;
}

function emptyDb() { return { version: 0, events: [] }; }

// Finds the event and participant a token belongs to, or null.
function resolve(db, token) {
  if (typeof token !== 'string' || token.length < 10) return null;
  for (const event of db.events) {
    const p = event.participants.find(x => x.token === token);
    if (p) return { event, participant: p };
  }
  return null;
}

function createEvent(db, input) {
  const name = cleanText(input && input.name, LIMITS.eventName);
  if (!name) fail(400, 'Geef het evenement een naam');
  const organizerName = cleanText(input.organizerName, LIMITS.name);
  if (!organizerName) fail(400, 'Vul je eigen naam in');
  const others = cleanNames(input.participants).filter(n => n.toLowerCase() !== organizerName.toLowerCase());
  if (others.length + 1 > LIMITS.participants) fail(400, `Maximaal ${LIMITS.participants} deelnemers`);
  const organizer = { id: newId(), name: organizerName, token: newToken() };
  const event = {
    id: newId(),
    name,
    kind: cleanKind(input.kind),
    date: cleanDate(input.date),
    createdAt: now(),
    organizerId: organizer.id,
    participants: [organizer, ...others.map(n => ({ id: newId(), name: n, token: newToken() }))],
    wishes: [],
  };
  db.events.push(event);
  return { event, token: organizer.token };
}

// What one participant may see of one event.
function viewEvent(event, me) {
  const isOrganizer = me.id === event.organizerId;
  const names = Object.fromEntries(event.participants.map(p => [p.id, p.name]));
  const wishes = [];
  for (const w of event.wishes) {
    const base = { id: w.id, ownerId: w.ownerId, title: w.title, url: w.url, price: w.price, note: w.note, createdAt: w.createdAt };
    if (w.ownerId === me.id) {
      // Own wishes: never anything about purchases, and a wish you deleted is gone for you.
      if (!w.deletedAt) wishes.push(base);
      continue;
    }
    if (w.deletedAt) {
      // A deleted wish only lives on for the person who already bought it, so they know.
      if (w.purchase && w.purchase.byId === me.id) wishes.push({ ...base, deleted: true, purchase: { byId: me.id, byName: names[me.id], at: w.purchase.at } });
      continue;
    }
    wishes.push({ ...base, purchase: w.purchase ? { byId: w.purchase.byId, byName: names[w.purchase.byId] || 'Iemand', at: w.purchase.at } : null });
  }
  return {
    id: event.id,
    name: event.name,
    kind: event.kind,
    date: event.date,
    createdAt: event.createdAt,
    organizerId: event.organizerId,
    me: { id: me.id, name: me.name, isOrganizer },
    participants: event.participants.map(p => isOrganizer ? { id: p.id, name: p.name, token: p.token } : { id: p.id, name: p.name }),
    wishes,
  };
}

function findWish(event, id) {
  const w = event.wishes.find(x => x.id === id);
  if (!w) fail(404, 'Deze wens bestaat niet meer');
  return w;
}

// Applies one change made by participant `me` in `event`. Throws OpError when it is not allowed.
// Returns an optional result object for the caller.
function applyOp(db, event, me, op) {
  const type = op && op.type;
  const isOrganizer = me.id === event.organizerId;
  const orgOnly = () => { if (!isOrganizer) fail(403, 'Alleen de organisator kan dit'); };

  switch (type) {
    case 'addWish': {
      const title = cleanText(op.title, LIMITS.title);
      const url = cleanUrl(op.url);
      if (!title && !url) fail(400, 'Vul een omschrijving of een link in');
      if (event.wishes.filter(w => w.ownerId === me.id && !w.deletedAt).length >= LIMITS.wishesPerPerson) fail(400, 'Je lijstje is vol');
      const wish = { id: newId(), ownerId: me.id, title: title || hostOf(url), url, price: cleanPrice(op.price), note: cleanNote(op.note), createdAt: now(), purchase: null, deletedAt: null };
      event.wishes.push(wish);
      return { id: wish.id };
    }
    case 'editWish': {
      const w = findWish(event, op.id);
      if (w.ownerId !== me.id || w.deletedAt) fail(403, 'Je kunt alleen je eigen wensen aanpassen');
      const title = cleanText(op.title, LIMITS.title);
      const url = cleanUrl(op.url);
      if (!title && !url) fail(400, 'Vul een omschrijving of een link in');
      Object.assign(w, { title: title || hostOf(url), url, price: cleanPrice(op.price), note: cleanNote(op.note) });
      return {};
    }
    case 'deleteWish': {
      const w = findWish(event, op.id);
      if (w.ownerId !== me.id) fail(403, 'Je kunt alleen je eigen wensen verwijderen');
      // Bought already: keep it hidden from the wisher but visible to the buyer, so they learn about it.
      if (w.purchase) w.deletedAt = now();
      else event.wishes = event.wishes.filter(x => x !== w);
      return {};
    }
    case 'buy': {
      const w = findWish(event, op.id);
      if (w.ownerId === me.id) fail(403, 'Je kunt je eigen wens niet afvinken');
      if (w.deletedAt) fail(409, 'Deze wens is verwijderd');
      if (w.purchase && w.purchase.byId !== me.id) {
        const by = event.participants.find(p => p.id === w.purchase.byId);
        fail(409, `${by ? by.name : 'Iemand anders'} heeft dit al gekocht`);
      }
      if (!w.purchase) w.purchase = { byId: me.id, at: now() };
      return {};
    }
    case 'unbuy': {
      const w = findWish(event, op.id);
      if (!w.purchase || w.purchase.byId !== me.id) fail(403, 'Alleen wie het kocht kan dit terugdraaien');
      w.purchase = null;
      if (w.deletedAt) event.wishes = event.wishes.filter(x => x !== w);
      return {};
    }
    case 'dismiss': {
      // The buyer has seen that the wish was deleted; now it can go for good.
      const w = findWish(event, op.id);
      if (!w.deletedAt || !w.purchase || w.purchase.byId !== me.id) fail(403, 'Dit kan niet');
      event.wishes = event.wishes.filter(x => x !== w);
      return {};
    }
    case 'editEvent': {
      orgOnly();
      const name = cleanText(op.name, LIMITS.eventName);
      if (!name) fail(400, 'Geef het evenement een naam');
      Object.assign(event, { name, kind: cleanKind(op.kind), date: cleanDate(op.date) });
      return {};
    }
    case 'addParticipant': {
      orgOnly();
      const name = cleanText(op.name, LIMITS.name);
      if (!name) fail(400, 'Vul een naam in');
      if (event.participants.some(p => p.name.toLowerCase() === name.toLowerCase())) fail(409, `${name} doet al mee`);
      if (event.participants.length >= LIMITS.participants) fail(400, `Maximaal ${LIMITS.participants} deelnemers`);
      const p = { id: newId(), name, token: newToken() };
      event.participants.push(p);
      return { id: p.id };
    }
    case 'renameParticipant': {
      orgOnly();
      const p = event.participants.find(x => x.id === op.id);
      if (!p) fail(404, 'Deze deelnemer bestaat niet');
      const name = cleanText(op.name, LIMITS.name);
      if (!name) fail(400, 'Vul een naam in');
      if (event.participants.some(x => x !== p && x.name.toLowerCase() === name.toLowerCase())) fail(409, `${name} doet al mee`);
      p.name = name;
      return {};
    }
    case 'newLink': {
      // A link that ended up with the wrong person can be replaced; the old one stops working.
      orgOnly();
      const p = event.participants.find(x => x.id === op.id);
      if (!p) fail(404, 'Deze deelnemer bestaat niet');
      p.token = newToken();
      return {};
    }
    case 'removeParticipant': {
      orgOnly();
      if (op.id === event.organizerId) fail(400, 'De organisator kan zichzelf niet verwijderen');
      const p = event.participants.find(x => x.id === op.id);
      if (!p) fail(404, 'Deze deelnemer bestaat niet');
      event.participants = event.participants.filter(x => x !== p);
      // Their wishes go; what they bought for others becomes available again.
      event.wishes = event.wishes.filter(w => w.ownerId !== p.id);
      for (const w of event.wishes) if (w.purchase && w.purchase.byId === p.id) w.purchase = null;
      event.wishes = event.wishes.filter(w => !(w.deletedAt && !w.purchase));
      return {};
    }
    case 'deleteEvent': {
      orgOnly();
      db.events = db.events.filter(e => e !== event);
      return {};
    }
    default:
      fail(400, 'Onbekende actie');
  }
}

// The organizer tokens of every event this name organizes. Used to win back the organizer link on a new
// device; the caller has already checked the creation code, which is what makes this safe.
function organizerTokens(db, name) {
  const want = cleanText(name, LIMITS.name).toLowerCase();
  if (!want) return [];
  const out = [];
  for (const e of db.events) {
    const org = e.participants.find(p => p.id === e.organizerId);
    if (org && org.name.toLowerCase() === want) out.push(org.token);
  }
  return out;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function migrate(data) {
  if (!data || !Array.isArray(data.events)) return emptyDb();
  return { version: Number(data.version) || 0, events: data.events };
}

module.exports = { KINDS, LIMITS, OpError, emptyDb, resolve, createEvent, viewEvent, applyOp, organizerTokens, migrate, cleanPrice, cleanUrl };
