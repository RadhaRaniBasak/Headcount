// Whole-flow check with PayPal and the LLM faked: plan, pay, repeat payer, unverified payer, pool, fake crowd, close, payout, reset,
// then three overlaps: a close during a capture, a reset during a payout, and a payout whose reply is lost.
// Run: npm run test:flow
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'headcount-'));
Object.assign(process.env, {
  PORT: '3111', ADMIN_KEY: 'test-key', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret',
  LLM_BASE_URL: 'https://llm.test/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm', DATA_FILE: path.join(tmp, 'db.json'),
  PROJECT_EMAILS: 'owner-a@example.com,owner-b@example.com',
});

const realFetch = globalThis.fetch;
const orders = new Map();
const payouts = new Map();
let nextPayer = { account_id: 'PAYERVERIFIED1', account_status: 'VERIFIED', email_address: 'jane.doe@example.com' };
let omitItemsOnCapture = false;
let captureDelay = 0; // ms PayPal takes to answer a capture
let payoutDelay = 0; // ms PayPal takes to answer a payout
let loseNextPayoutReply = false; // PayPal accepts the payout, but its reply never arrives
let rejectRepeatedBatch = false; // answer a repeated sender_batch_id the way the real API does
let seq = 0;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'paypal-debug-id': 'dbg1' } });

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('https://llm.test')) {
    return json(200, { choices: [{ message: { content: JSON.stringify({ lines: [
      { projectId: 'p1', amountCents: 800, reason: 'Screen reader support matches accessibility.' },
      { projectId: 'p6', amountCents: 700, reason: 'Tests pages with a real screen reader.' },
      { projectId: 'p4', amountCents: 950, reason: 'Bengali language tooling.' },
      { projectId: 'zzz', amountCents: 500, reason: 'invented' },
    ] }) } }] });
  }
  if (!url.startsWith('https://api-m.sandbox.paypal.com')) return realFetch(url, init);
  const path = url.replace('https://api-m.sandbox.paypal.com', '');
  const body = init.body && init.headers?.['Content-Type'] === 'application/json' ? JSON.parse(init.body) : null;
  if (path === '/v1/oauth2/token') return json(200, { access_token: 'tok', expires_in: 3600 });
  if (path === '/v2/checkout/orders' && init.method === 'POST') {
    assert.ok(init.headers['PayPal-Request-Id']);
    const pu = body.purchase_units[0];
    assert.ok(pu.items.every((i) => i.category !== 'DONATION'), 'PayPal refuses DONATION items from an account not approved for donations');
    assert.equal(pu.amount.value, pu.amount.breakdown.item_total.value);
    assert.equal(Number(pu.amount.value).toFixed(2), pu.items.reduce((a, i) => a + Number(i.unit_amount.value), 0).toFixed(2));
    const id = 'ORDER' + String(++seq).padStart(12, '0');
    orders.set(id, { id, status: 'PAYER_ACTION_REQUIRED', purchase_units: [{ items: pu.items, amount: pu.amount }] });
    return json(201, { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
  }
  let m;
  if ((m = path.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/))) {
    const o = orders.get(m[1]);
    if (!o) return json(404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }] });
    if (o.status === 'COMPLETED') return json(422, { name: 'UNPROCESSABLE_ENTITY', message: 'already', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
    const gross = Math.round(Number(o.purchase_units[0].amount.value) * 100);
    const fee = Math.round(gross * 0.0349) + 49;
    o.status = 'COMPLETED';
    o.payment_source = { paypal: { ...nextPayer } };
    o.purchase_units[0].payments = { captures: [{ id: 'CAP' + m[1], status: 'COMPLETED', seller_receivable_breakdown: { paypal_fee: { currency_code: 'USD', value: (fee / 100).toFixed(2) } } }] };
    const out = structuredClone(o);
    if (omitItemsOnCapture) delete out.purchase_units[0].items;
    if (captureDelay) await new Promise((r) => setTimeout(r, captureDelay));
    return json(201, out);
  }
  if ((m = path.match(/^\/v2\/checkout\/orders\/([^/]+)$/))) return orders.has(m[1]) ? json(200, orders.get(m[1])) : json(404, { name: 'RESOURCE_NOT_FOUND' });
  if (path === '/v1/payments/payouts' && init.method === 'POST') {
    const sid = body.sender_batch_header.sender_batch_id;
    // The real API rejects a sender_batch_id it accepted in the last 30 days and links to the original payout.
    // Its docs do not show the body, so this shape is a guess; the app only looks for the link.
    if (payouts.has(sid) && rejectRepeatedBatch) {
      return json(400, { name: 'USER_BUSINESS_ERROR', message: 'User business error.', links: [{ href: `https://api-m.sandbox.paypal.com/v1/payments/payouts/${payouts.get(sid).id}`, rel: 'self', method: 'GET' }] });
    }
    if (!payouts.has(sid)) payouts.set(sid, { id: 'BATCH' + payouts.size, body });
    if (payoutDelay) await new Promise((r) => setTimeout(r, payoutDelay));
    if (loseNextPayoutReply) { loseNextPayoutReply = false; throw new Error("simulated: PayPal's reply was lost"); }
    return json(201, { batch_header: { payout_batch_id: payouts.get(sid).id, batch_status: 'PENDING' } });
  }
  if ((m = path.match(/^\/v1\/payments\/payouts\/([^/]+)$/))) {
    const p = [...payouts.values()].find((x) => x.id === m[1]);
    return json(200, { batch_header: { batch_status: 'SUCCESS' }, items: p.body.items.map((i) => ({ payout_item: { sender_item_id: i.sender_item_id }, transaction_status: 'SUCCESS' })) });
  }
  return json(500, { name: 'UNHANDLED', path });
};

await import('../server.js');
await new Promise((r) => setTimeout(r, 300));
const B = 'http://localhost:3111';
const get = async (p) => (await realFetch(B + p)).json();
const post = async (p, body, headers = {}) => {
  const r = await realFetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const pay = async (lines) => {
  const c = await post('/api/checkout', { lines });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const token = new URL(c.body.approveUrl).searchParams.get('token');
  const r = await realFetch(`${B}/api/return?token=${token}&PayerID=X`, { redirect: 'manual' });
  return { token, location: r.headers.get('location') };
};
const A = { 'x-admin-key': 'test-key' };

// 1. fresh seeded state
let s = await get('/api/state');
assert.equal(s.round.status, 'OPEN');
assert.equal(s.projects.length, 8);
assert.equal(s.pool.totalCents, 500000);
assert.equal(s.projects.reduce((a, p) => a + p.matchCents, 0), 500000);
assert.deepEqual(s.lesson.map((r) => r.matchCents), [0, 30612, 132653, 336735]);
const seedState = s;

// 2. plan: the fake LLM overspends and invents a project; the server must repair both
let r = await post('/api/plan', { budgetUsd: 20, interests: 'accessibility and Indian languages' });
assert.equal(r.status, 200);
assert.equal(r.body.source, 'llm');
assert.ok(r.body.totalCents <= 2000 && r.body.lines.every((l) => ['p1', 'p6', 'p4'].includes(l.projectId) && l.deltaCents > 0 && l.name));
assert.equal((await post('/api/plan', { budgetUsd: 0, interests: 'x' })).status, 400);

// 3. preview
r = await post('/api/preview', { lines: [{ projectId: 'p8', amountCents: 500 }] });
assert.equal(r.status, 200);
assert.equal((await post('/api/preview', { lines: [{ projectId: 'POOL', amountCents: 500 }] })).status, 400);
assert.equal((await post('/api/checkout', { lines: [{ projectId: 'p1', amountCents: 50 }] })).status, 400);
assert.equal((await post('/api/checkout', { lines: [{ projectId: 'p1', amountCents: 500 }, { projectId: 'p1', amountCents: 500 }] })).status, 400);

// 4. a verified payer pays a basket; the split and fee come back from PayPal
const headsBefore = s.projects.find((p) => p.id === 'p1').heads;
let paid = await pay([{ projectId: 'p1', amountCents: 800 }, { projectId: 'p6', amountCents: 700 }, { projectId: 'p4', amountCents: 500 }]);
assert.equal(paid.location, '/?paid=1');
s = await get('/api/state');
assert.equal(s.projects.find((p) => p.id === 'p1').heads, headsBefore + 1);
assert.equal(s.recent[0].lines.length, 3);
assert.equal(s.recent[0].feeCents, Math.round(2000 * 0.0349) + 49);
assert.equal(s.recent[0].payer, 'ja***@example.com');
assert.equal(s.settlement.grossInCents, 2000);

// 5. same order returned twice changes nothing
r = await realFetch(`${B}/api/return?token=${paid.token}`, { redirect: 'manual' });
assert.equal(r.headers.get('location'), '/?paid=1');
assert.equal((await get('/api/state')).settlement.grossInCents, 2000);

// 6. the same payer gives again: no new head
await pay([{ projectId: 'p1', amountCents: 300 }]);
assert.equal((await get('/api/state')).projects.find((p) => p.id === 'p1').heads, headsBefore + 1);

// 7. an unverified payer: delivered, unmatched; items missing from the capture response
nextPayer = { account_id: 'PAYERUNVERIF02', account_status: 'UNVERIFIED', email_address: 'bob@example.com' };
omitItemsOnCapture = true;
const p8Before = (await get('/api/state')).projects.find((p) => p.id === 'p8');
await pay([{ projectId: 'p8', amountCents: 1000 }]);
omitItemsOnCapture = false;
s = await get('/api/state');
const p8After = s.projects.find((p) => p.id === 'p8');
assert.equal(p8After.heads, p8Before.heads);
assert.equal(p8After.raisedCents, p8Before.raisedCents + 1000);
assert.equal(s.recent[0].verified, false);

// 8. a payer with no account_status is not counted unless COUNT_UNKNOWN_STATUS=true
nextPayer = { account_id: 'PAYERNOSTATUS3', email_address: 'cat@example.com' };
await pay([{ projectId: 'p8', amountCents: 400 }]);
assert.equal((await get('/api/state')).projects.find((p) => p.id === 'p8').heads, p8Before.heads);

// 9. a sponsor funds the pool with real money
nextPayer = { account_id: 'SPONSOR0000004', account_status: 'VERIFIED', email_address: 'sponsor@example.com' };
await pay([{ projectId: 'POOL', amountCents: 50000 }]);
s = await get('/api/state');
assert.equal(s.pool.realCents, 50000);
assert.equal(s.pool.totalCents, 550000);

// 10. organizer actions need the key; a fake crowd moves the naive match only
assert.equal((await post('/api/admin/fake-crowd', {})).status, 401);
const before = s.projects.map((p) => p.matchCents);
const naiveBefore = s.projects.find((p) => p.id === 'p8').naiveMatchCents;
assert.equal((await post('/api/admin/fake-crowd', {}, A)).status, 200);
s = await get('/api/state');
assert.deepEqual(s.projects.map((p) => p.matchCents), before);
const p8 = s.projects.find((p) => p.id === 'p8');
assert.ok(p8.naiveMatchCents > naiveBefore * 5);

// 11. close: needs confirm, pays real net money only, every cent accounted for
assert.equal((await post('/api/admin/close', {}, A)).status, 400);
const live = s.settlement;
r = await post('/api/admin/close', { confirm: true }, A);
assert.equal(r.status, 200, JSON.stringify(r.body));
const payout = r.body.payout;
assert.equal(payout.items.reduce((a, i) => a + i.amountCents, 0), live.paidOutCents);
assert.equal(live.grossInCents - live.feeCents, live.paidOutCents);
assert.equal(live.unallocatedCents, 0);
const sent = [...payouts.values()][0].body;
assert.equal(sent.items.reduce((a, i) => a + Math.round(Number(i.amount.value) * 100), 0), live.paidOutCents);
assert.ok(sent.items.every((i) => /^owner-[ab]@example\.com$/.test(i.receiver) && i.recipient_type === 'EMAIL'));

// 12. closing twice returns the same payout; a late return is refused before capture
assert.equal((await post('/api/admin/close', { confirm: true }, A)).body.payout.batchId, payout.batchId);
assert.equal(payouts.size, 1);
const late = await post('/api/checkout', { lines: [{ projectId: 'p1', amountCents: 500 }] });
assert.equal(late.status, 409);
await new Promise((res) => setTimeout(res, 5100));
s = await get('/api/state');
assert.equal(s.round.status, 'CLOSED');
assert.equal(s.payout.status, 'SUCCESS');
assert.ok(s.payout.items.every((i) => i.status === 'SUCCESS'));

// 13. reset starts a fresh open round
const oldId = s.round.id;
assert.equal((await post('/api/admin/reset', {}, A)).status, 200);
s = await get('/api/state');
assert.ok(s.round.status === 'OPEN' && s.round.id !== oldId && s.payout === null && s.pool.realCents === 0);
assert.deepEqual(s.projects.map((p) => p.matchCents), seedState.projects.map((p) => p.matchCents));
assert.equal((await post('/api/admin/close', { confirm: true }, A)).status, 409); // nothing real to pay yet: a refusal for now (409), not a bad request (400)

// 14. a payment still being captured when the organizer closes the round is in the payout
await pay([{ projectId: 'p1', amountCents: 2000 }]);
const slow = await post('/api/checkout', { lines: [{ projectId: 'p2', amountCents: 5000 }] });
captureDelay = 300;
const landing = realFetch(`${B}/api/return?token=${new URL(slow.body.approveUrl).searchParams.get('token')}`, { redirect: 'manual' });
await new Promise((res) => setTimeout(res, 50));
r = await post('/api/admin/close', { confirm: true }, A);
captureDelay = 0;
assert.equal((await landing).headers.get('location'), '/?paid=1');
s = await get('/api/state');
assert.equal(r.body.payout.items.reduce((a, i) => a + i.amountCents, 0), s.settlement.grossInCents - s.settlement.feeCents);

// 15. a reset is refused while the payout is being sent, so that payout cannot be written onto the new round
assert.equal((await post('/api/admin/reset', {}, A)).status, 200);
await pay([{ projectId: 'p1', amountCents: 2000 }]);
payoutDelay = 300;
const closing = post('/api/admin/close', { confirm: true }, A);
await new Promise((res) => setTimeout(res, 50));
assert.equal((await post('/api/admin/reset', {}, A)).status, 409);
assert.equal((await closing).status, 200);
payoutDelay = 0;
assert.equal((await get('/api/state')).round.status, 'CLOSED');

// 16. PayPal accepts a payout but its reply is lost; the retry is rejected with a link to the original, which is recorded
assert.equal((await post('/api/admin/reset', {}, A)).status, 200);
await pay([{ projectId: 'p1', amountCents: 2000 }]);
loseNextPayoutReply = rejectRepeatedBatch = true;
const batches = payouts.size;
r = await post('/api/admin/close', { confirm: true }, A);
assert.equal(r.status, 502); // no answer from PayPal is PayPal failing, not a bug in this app
assert.match(r.body.error, /^PayPal .*Try again/);
r = await post('/api/admin/close', { confirm: true }, A);
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(payouts.size, batches + 1);
assert.equal(r.body.payout.batchId, [...payouts.values()].at(-1).id);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('flow check passed');
process.exit(0);
