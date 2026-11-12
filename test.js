// One runnable check for the money math and the agent guard. Run: npm test
import assert from 'node:assert/strict';
import { POOL, apportion, match, preview, settlement, lesson } from './lib/qf.js';
import { cleanLines, rulesPlan } from './lib/agent.js';

const gift = (projectId, payerId, amountCents, verified = true, source = 'simulated', feeCents = 0) => ({ projectId, payerId, amountCents, verified, source, feeCents });
const crowd = (projectId, n, cents, verified = true, tag = projectId) => Array.from({ length: n }, (_, i) => gift(projectId, `${tag}-${i}`, cents, verified));
const cents = (m, ids) => ids.map((id) => m[id].matchCents);

// 1. apportion: integer parts that sum to the total, ties to the lower index
assert.deepEqual(apportion([1, 1, 1], 100), [34, 33, 33]);
assert.deepEqual(apportion([0, 0], 100), [0, 0]);
assert.deepEqual(apportion([3, 1], 0), [0, 0]);

// 2. the teaching table: same $1,000, different crowds, $5,000 pool
assert.deepEqual(lesson().map((r) => r.matchCents), [0, 30612, 132653, 336735]);

// 3. a project with one backer earns nothing, even when it is the only project with gifts
assert.deepEqual(cents(match([gift('a', 'x', 123457)], ['a', 'b'], 500000), ['a', 'b']), [0, 0]);

// 4. one payer is one head: two $5 gifts equal one $10 gift
const base = [...crowd('a', 10, 1000), ...crowd('b', 10, 1000)];
const once = match([...base, gift('a', 'z', 1000)], ['a', 'b'], 100000);
const twice = match([...base, gift('a', 'z', 500), gift('a', 'z', 500)], ['a', 'b'], 100000);
assert.deepEqual(once, twice);
assert.equal(once.a.heads, 11);

// 5. unverified gifts move nothing; counting everyone would move a lot
const before = match(base, ['a', 'b'], 100000);
const attacked = [...base, ...crowd('b', 100, 1000, false, 'fake')];
assert.deepEqual(match(attacked, ['a', 'b'], 100000), before);
assert.deepEqual(cents(before, ['a', 'b']), [50000, 50000]);
assert.deepEqual(cents(match(attacked, ['a', 'b'], 100000, { verifiedOnly: false }), ['a', 'b']), [745, 99255]);

// 6. preview: a new payer's $5 to project a
assert.deepEqual(preview(base, ['a', 'b'], 100000, [{ projectId: 'a', amountCents: 500 }]), { a: 3642 });

// 7. settlement: only real money moves, net of fees, and every cent is accounted for
const real = [
  gift(POOL, 'sponsor', 50000, true, 'paypal', 1795),
  gift('a', 'r1', 2000, true, 'paypal', 119),
  gift('b', 'r2', 500, false, 'paypal', 66),
];
const s = settlement([...base, ...real], ['a', 'b']);
assert.deepEqual(s.items, [
  { projectId: 'a', giftsNetCents: 1881, matchCents: 27376, amountCents: 29257 },
  { projectId: 'b', giftsNetCents: 434, matchCents: 20829, amountCents: 21263 },
]);
assert.equal(s.grossInCents, 52500);
assert.equal(s.feeCents, 1980);
assert.equal(s.paidOutCents, 50520);
assert.equal(s.unallocatedCents, 0);

// 8. the agent guard: unknown ids, repeats, cents and overspend never reach checkout
assert.deepEqual(
  cleanLines([
    { projectId: 'p1', amountCents: 1250, reason: 'ok' },
    { projectId: 'nope', amountCents: 500 },
    { projectId: 'p1', amountCents: 500 },
    { projectId: 'p2', amountCents: 900, reason: 7 },
    { projectId: 'p3', amountCents: 40 },
  ], { budgetCents: 1500, projectIds: ['p1', 'p2', 'p3'] }),
  [{ projectId: 'p1', amountCents: 700, reason: 'ok' }, { projectId: 'p2', amountCents: 800, reason: '7' }],
);
assert.deepEqual(cleanLines('not a list', { budgetCents: 1000, projectIds: ['p1'] }), []);

// 9. the fallback planner spends at most the budget on real projects
const projects = [
  { id: 'p1', name: 'Accessible Date Picker', blurb: 'Works with screen readers.', tags: ['accessibility'] },
  { id: 'p2', name: 'Streaming CSV Parser', blurb: 'Big files.', tags: ['data'] },
];
const plan = rulesPlan({ budgetCents: 2000, interests: 'accessibility for blind users', projects });
assert.deepEqual(plan.map((l) => [l.projectId, l.amountCents]), [['p1', 2000]]);

console.log('all checks passed');
