// Matching math. Pure functions, integer cents in and out, no I/O.
// A gift is { projectId, payerId, amountCents, feeCents, verified, source }.
// projectId 'POOL' marks money paid into the matching pool.

export const POOL = 'POOL';

// Split an integer `total` across `weights` so the parts are integers that sum to `total`.
// Largest-remainder method; ties go to the lower index. No positive weight → all zeros.
export function apportion(weights, total) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0) || !(total > 0)) return weights.map(() => 0);
  const exact = weights.map((w) => (w / sum) * total);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k][1]]++;
  return parts;
}

// projectId → (payerId → cents), counting only gifts that earn match.
function headsByProject(gifts, verifiedOnly) {
  const by = new Map();
  for (const g of gifts) {
    if (g.projectId === POOL || (verifiedOnly && !g.verified)) continue;
    if (!by.has(g.projectId)) by.set(g.projectId, new Map());
    const payers = by.get(g.projectId);
    payers.set(g.payerId, (payers.get(g.payerId) ?? 0) + g.amountCents);
  }
  return by;
}

// Quadratic match: raw = (sum of square roots)^2 - sum, pool split in proportion to raw.
// Returns { [projectId]: { matchCents, heads } } for every id in projectIds.
export function match(gifts, projectIds, poolCents, { verifiedOnly = true } = {}) {
  const by = headsByProject(gifts, verifiedOnly);
  const raws = projectIds.map((id) => {
    const cents = [...(by.get(id)?.values() ?? [])];
    const roots = cents.reduce((a, c) => a + Math.sqrt(c), 0);
    const raw = roots * roots - cents.reduce((a, c) => a + c, 0);
    return raw < 1e-6 ? 0 : raw; // one backer is exactly 0; float noise must not win the pool
  });
  const parts = apportion(raws, poolCents);
  return Object.fromEntries(projectIds.map((id, i) => [id, { matchCents: parts[i], heads: by.get(id)?.size ?? 0 }]));
}

// What a new verified payer's basket would move. lines: [{ projectId, amountCents }].
// Returns { [projectId]: deltaCents } for the projects in the basket.
export function preview(gifts, projectIds, poolCents, lines, opts) {
  const before = match(gifts, projectIds, poolCents, opts);
  const extra = lines.map((l) => ({ projectId: l.projectId, payerId: '\u0000preview', amountCents: l.amountCents, verified: true }));
  const after = match([...gifts, ...extra], projectIds, poolCents, opts);
  return Object.fromEntries(lines.map((l) => [l.projectId, after[l.projectId].matchCents - before[l.projectId].matchCents]));
}

// Who is paid what at close. Only real money (source 'paypal') moves, net of PayPal fees.
// Simulated gifts still shape the shares.
export function settlement(gifts, projectIds, opts) {
  const real = gifts.filter((g) => g.source === 'paypal');
  const net = (list) => list.reduce((a, g) => a + g.amountCents - g.feeCents, 0);
  const shares = match(gifts, projectIds, net(real.filter((g) => g.projectId === POOL)), opts);
  const items = projectIds.map((id) => {
    const giftsNetCents = net(real.filter((g) => g.projectId === id));
    const matchCents = shares[id].matchCents;
    return { projectId: id, giftsNetCents, matchCents, amountCents: giftsNetCents + matchCents };
  });
  const grossInCents = real.reduce((a, g) => a + g.amountCents, 0);
  const feeCents = real.reduce((a, g) => a + g.feeCents, 0);
  const paidOutCents = items.reduce((a, i) => a + i.amountCents, 0);
  return { items, grossInCents, feeCents, paidOutCents, unallocatedCents: grossInCents - feeCents - paidOutCents };
}

// The teaching table: four projects each raise $1,000 from a different crowd, pool $5,000.
export function lesson() {
  const crowds = [[1, 100000], [10, 10000], [40, 2500], [100, 1000]];
  const gifts = crowds.flatMap(([n, cents], p) =>
    Array.from({ length: n }, (_, i) => ({ projectId: `L${p}`, payerId: `L${p}-${i}`, amountCents: cents, verified: true })));
  const ids = crowds.map((_, p) => `L${p}`);
  const m = match(gifts, ids, 500000);
  return crowds.map(([n, cents], p) => ({ donors: n, giftCents: cents, matchCents: m[ids[p]].matchCents }));
}
