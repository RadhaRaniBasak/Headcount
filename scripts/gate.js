// First-hour check against the real PayPal sandbox. Run it once per test payer:
//   npm run gate                               order + capture
//   npm run gate -- --payout you@example.com   also sends a $1.00 payout to that sandbox account
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { createOrder, captureOrder, createPayout, getPayout } from '../lib/paypal.js';

let failed = 0;
const check = (label, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
};

const order = await createOrder({
  lines: [{ sku: 'GATE', name: 'Headcount gate check', amountCents: 500 }],
  returnUrl: 'https://example.com/approved',
  cancelUrl: 'https://example.com/cancelled',
  requestId: crypto.randomUUID(),
});
check('order created', true, order.id);

console.log(`\nOpen this link in a private window, log in with a sandbox PERSONAL account and approve the $5.00 payment:\n\n${order.approveUrl}\n`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question('The browser will land on example.com. Press Enter here once it has. ');
rl.close();

const c = await captureOrder(order.id);
check('capture completed', c.status === 'COMPLETED', c.status);
check('payer id returned', Boolean(c.payerId), c.payerId ?? 'missing');
check('account_status returned', c.accountStatus !== null, c.accountStatus ?? 'missing: set COUNT_UNKNOWN_STATUS=true');
check('line items returned', c.lines.length === 1 && c.lines[0].sku === 'GATE' && c.lines[0].amountCents === 500, JSON.stringify(c.lines));
check('PayPal fee returned', c.feeCents > 0, `${c.feeCents} cents`);

const flag = process.argv.indexOf('--payout');
if (flag > -1) {
  const email = process.argv[flag + 1];
  const batch = await createPayout({ senderBatchId: `gate-${Date.now()}`, items: [{ itemId: 'gate-1', email, amountCents: 100, note: 'Headcount gate check' }] });
  check('payout batch accepted', Boolean(batch.batchId), `${batch.batchId} ${batch.status}`);
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const seen = await getPayout(batch.batchId);
  check('payout batch readable', Boolean(seen.status), `${seen.status}, item ${seen.items[0]?.status ?? 'pending'}`);
}

console.log(failed ? `\n${failed} check(s) failed.` : '\nGate passed.');
process.exit(failed ? 1 : 0);
