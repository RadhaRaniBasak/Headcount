// Headcount HTTP server: JSON API plus the static page in public/.
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { db, save, reset, addFakeCrowd, maskEmail } from './lib/store.js';
import { POOL, apportion, match, preview, settlement, lesson } from './lib/qf.js';
import { PAYPAL_ENV, usd, createOrder, captureOrder, createPayout, getPayout } from './lib/paypal.js';
import { planBasket } from './lib/agent.js';

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
// What to do when PayPal sends no account_status for a payer: count them as verified, or not.
const COUNT_UNKNOWN = process.env.COUNT_UNKNOWN_STATUS === 'true';
const LESSON = lesson();

const fail = (status, message) => Object.assign(new Error(message), { status });
const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);
const ids = () => db.projects.map((p) => p.id);
const nameOf = (id) => (id === POOL ? 'Matching pool' : db.projects.find((p) => p.id === id)?.name ?? id);
const poolCents = (source) => sum(db.gifts.filter((g) => g.projectId === POOL && (!source || g.source === source)), (g) => g.amountCents);

// Validates a basket from the browser. Returns [{ projectId, amountCents, name }].
function parseLines(body, { allowPool }) {
  const lines = body?.lines;
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 8) throw fail(400, 'Send 1 to 8 basket lines.');
  const seen = new Set();
  const out = lines.map((l) => {
    const isPool = l?.projectId === POOL;
    if (!(isPool ? allowPool : ids().includes(l?.projectId)) || seen.has(l.projectId)) throw fail(400, 'Unknown or repeated project in the basket.');
    seen.add(l.projectId);
    const max = isPool ? 500000 : 100000;
    if (!Number.isInteger(l.amountCents) || l.amountCents < 100 || l.amountCents > max) throw fail(400, `Each amount must be between $1 and $${max / 100}.`);
    return { projectId: l.projectId, amountCents: l.amountCents, name: nameOf(l.projectId) };
  });
  if (sum(out, (l) => l.amountCents) > 500000) throw fail(400, 'A basket can total at most $5,000.');
  return out;
}

// Adds the match each line would move if a new verified payer paid this basket now.
function withPreview(lines) {
  const delta = preview(db.gifts, ids(), poolCents(), lines);
  const out = lines.map((l) => ({ ...l, name: nameOf(l.projectId), deltaCents: delta[l.projectId] }));
  return { lines: out, totalCents: sum(out, (l) => l.amountCents), totalDeltaCents: sum(out, (l) => l.deltaCents) };
}

function buildState() {
  const pid = ids();
  const pool = { totalCents: poolCents(), realCents: poolCents('paypal'), simulatedCents: poolCents('simulated') };
  const counted = match(db.gifts, pid, pool.totalCents);
  const naive = match(db.gifts, pid, pool.totalCents, { verifiedOnly: false });
  const given = db.gifts.filter((g) => g.projectId !== POOL);
  const payers = (list) => new Set(list.map((g) => g.payerId)).size;
  const unmatched = given.filter((g) => !g.verified);
  const orders = new Map();
  for (const g of db.gifts.filter((x) => x.source === 'paypal')) {
    if (!orders.has(g.orderId)) orders.set(g.orderId, { at: g.at, payer: g.payer, verified: g.verified, feeCents: 0, lines: [] });
    const o = orders.get(g.orderId);
    o.feeCents += g.feeCents;
    o.lines.push({ name: nameOf(g.projectId), amountCents: g.amountCents });
  }
  return {
    round: db.round,
    paypalEnv: PAYPAL_ENV,
    countUnknownStatus: COUNT_UNKNOWN,
    pool,
    projects: db.projects.map((p) => {
      const mine = given.filter((g) => g.projectId === p.id);
      return { id: p.id, name: p.name, blurb: p.blurb, tags: p.tags, raisedCents: sum(mine, (g) => g.amountCents), donors: payers(mine), heads: counted[p.id].heads, matchCents: counted[p.id].matchCents, naiveMatchCents: naive[p.id].matchCents };
    }),
    totals: { raisedCents: sum(given, (g) => g.amountCents), donors: payers(given), heads: payers(given.filter((g) => g.verified)), unmatchedDonors: payers(unmatched), unmatchedCents: sum(unmatched, (g) => g.amountCents) },
    recent: [...orders.values()].reverse().slice(0, 12),
    lesson: LESSON,
    settlement: settlement(db.gifts, pid),
    payout: db.payout,
  };
}

// Writes a captured order into the ledger, one gift per line. Safe to call twice for one order.
function recordCapture(c) {
  if (db.gifts.some((g) => g.orderId === c.orderId)) return;
  const known = new Set([...ids(), POOL]);
  const fees = apportion(c.lines.map((l) => l.amountCents), c.feeCents);
  const verified = c.accountStatus === 'VERIFIED' || (c.accountStatus === null && COUNT_UNKNOWN && Boolean(c.payerId));
  const at = new Date().toISOString();
  c.lines.forEach((l, i) => db.gifts.push({
    id: `${c.orderId}:${i}`,
    orderId: c.orderId,
    captureId: c.captureId,
    projectId: known.has(l.sku) ? l.sku : POOL, // captured money is never dropped: an unknown line joins the pool
    payerId: c.payerId ?? `anon-${c.orderId}`,
    payer: maskEmail(c.payerEmail),
    verified,
    amountCents: l.amountCents,
    feeCents: fees[i],
    source: 'paypal',
    at,
  }));
  save();
}

let lastPayoutCheck = 0;
async function refreshPayout() {
  const p = db.payout;
  if (!p || ['SUCCESS', 'DENIED', 'CANCELED'].includes(p.status) || Date.now() - lastPayoutCheck < 5000) return;
  lastPayoutCheck = Date.now();
  try {
    const batch = await getPayout(p.batchId);
    p.status = batch.status;
    for (const item of p.items) item.status = batch.items.find((x) => x.itemId === item.itemId)?.status ?? item.status;
    save();
  } catch (err) {
    console.error('payout refresh failed:', err.message);
  }
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const admin = (req, _res, next) => {
  if (!ADMIN_KEY) return next(fail(503, 'Set ADMIN_KEY to use organizer actions.'));
  if (!crypto.timingSafeEqual(sha(req.get('x-admin-key') ?? ''), sha(ADMIN_KEY))) return next(fail(401, 'Wrong organizer key.'));
  next();
};

// ponytail: per-process memory, grows with distinct IPs. Fine for a demo; use a shared store behind more than one instance.
const limit = (max) => {
  const hits = new Map();
  return (req, _res, next) => {
    const now = Date.now();
    const recent = (hits.get(req.ip) ?? []).filter((t) => now - t < 60000);
    if (recent.length >= max) return next(fail(429, 'Too many requests. Try again in a minute.'));
    hits.set(req.ip, [...recent, now]);
    next();
  };
};

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(import.meta.dirname, 'public')));

app.get('/api/state', async (_req, res) => {
  await refreshPayout();
  res.json(buildState());
});

app.post('/api/plan', limit(10), async (req, res) => {
  const budgetCents = Math.floor(Number(req.body?.budgetUsd)) * 100;
  const interests = String(req.body?.interests ?? '').trim().slice(0, 500);
  if (!(budgetCents >= 100 && budgetCents <= 50000)) throw fail(400, 'Budget must be between $1 and $500.');
  if (interests.length < 3) throw fail(400, 'Say what you care about in a few words.');
  const plan = await planBasket({ budgetCents, interests, projects: db.projects });
  res.json({ source: plan.source, ...withPreview(plan.lines) });
});

app.post('/api/preview', (req, res) => {
  res.json(withPreview(parseLines(req.body, { allowPool: false })));
});

app.post('/api/checkout', limit(30), async (req, res) => {
  if (db.round.status !== 'OPEN') throw fail(409, 'This round is closed.');
  const lines = parseLines(req.body, { allowPool: true });
  const order = await createOrder({
    lines: lines.map((l) => ({ sku: l.projectId, name: l.name, amountCents: l.amountCents })),
    returnUrl: `${PUBLIC_URL}/api/return`,
    cancelUrl: `${PUBLIC_URL}/?cancelled=1`,
    requestId: crypto.randomUUID(),
  });
  res.json({ approveUrl: order.approveUrl });
});

// Captures under way: PayPal may already have taken the money, but the ledger does not show it yet.
// Closing the round waits for these, so a payment that lands during the close is still paid out.
const capturing = new Set();

// PayPal sends the payer back here with ?token=<order id>. The split is read from PayPal, never from the browser.
app.get('/api/return', async (req, res) => {
  const orderId = String(req.query.token ?? '');
  if (!/^[A-Za-z0-9-]{8,40}$/.test(orderId)) return res.redirect('/?error=bad_order');
  if (db.gifts.some((g) => g.orderId === orderId)) return res.redirect('/?paid=1');
  if (db.round.status !== 'OPEN') return res.redirect('/?error=round_closed'); // not captured, so the payer is not charged
  const work = captureOrder(orderId).then((capture) => {
    if (capture.status === 'COMPLETED') recordCapture(capture);
    return capture;
  });
  capturing.add(work);
  try {
    const capture = await work;
    res.redirect(capture.status === 'COMPLETED' ? '/?paid=1' : '/?error=not_completed');
  } catch (err) {
    console.error('capture failed:', err.message, err.debugId ?? '');
    res.redirect('/?error=capture_failed');
  } finally {
    capturing.delete(work);
  }
});

app.post('/api/admin/fake-crowd', admin, (req, res) => {
  if (db.round.status !== 'OPEN') throw fail(409, 'This round is closed.');
  addFakeCrowd(100, ids().includes(req.body?.projectId) ? req.body.projectId : 'p8');
  res.json({ ok: true });
});

let closing = false; // true while a close is waiting on PayPal

app.post('/api/admin/close', admin, async (req, res) => {
  if (req.body?.confirm !== true) throw fail(400, 'Send {"confirm": true} to close the round and pay out.');
  if (db.payout) return res.json({ payout: db.payout });
  if (closing) throw fail(409, 'The round is already being closed.');
  const payable = () => settlement(db.gifts, ids()).items.filter((i) => i.amountCents > 0);
  if (!payable().length) throw fail(409, 'Nothing real to pay out yet. Fund the pool or make a sandbox gift first.'); // the request is fine, the round is not ready
  closing = true;
  try {
    db.round.status = 'CLOSED'; // stop new captures before money leaves
    db.round.closedAt = new Date().toISOString();
    save();
    await Promise.allSettled(capturing); // a capture that began before the line above still lands in the ledger, so add up after it has
    const rows = payable().map((i) => ({ ...i, itemId: `${db.round.id}-${i.projectId}`, name: nameOf(i.projectId), email: db.projects.find((p) => p.id === i.projectId).payoutEmail }));
    const batch = await createPayout({
      senderBatchId: `headcount-${db.round.id}`, // PayPal pays one batch per id, so a retry cannot pay twice
      items: rows.map((r) => ({ itemId: r.itemId, email: r.email, amountCents: r.amountCents, note: `Headcount: gifts $${usd(r.giftsNetCents)} + match $${usd(r.matchCents)}` })),
    });
    db.payout = { batchId: batch.batchId, status: batch.status, at: new Date().toISOString(), items: rows.map((r) => ({ ...r, email: maskEmail(r.email), status: 'PENDING' })) };
    save();
  } finally {
    closing = false;
  }
  res.json({ payout: db.payout });
});

app.post('/api/admin/reset', admin, (_req, res) => {
  // A reset now would open a new round and then have the old round's payout written onto it.
  if (closing) throw fail(409, 'A payout is being sent. Reset once it has finished.');
  reset();
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err.message, err.debugId ?? '');
  res.status(status).json({ error: err.status ? err.message : 'Something went wrong.' });
});

app.listen(PORT, () => console.log(`Headcount on ${PUBLIC_URL} (PayPal ${PAYPAL_ENV})`));
