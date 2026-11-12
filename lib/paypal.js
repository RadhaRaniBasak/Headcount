// PayPal REST calls with fetch. No SDK. Sandbox only.
const BASE = process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com';
if (!BASE.includes('sandbox')) throw new Error('Headcount runs on the PayPal sandbox only.');

export const PAYPAL_ENV = 'sandbox';
export const toCents = (value) => Math.round(Number(value) * 100);
export const usd = (cents) => (cents / 100).toFixed(2);

let token = { value: '', expiresAt: 0 };

// Every request to PayPal goes through here. No answer at all (a network error or a timeout) is a 502 like PayPal's
// own failures, so the browser is told it was PayPal and that trying again is fine, not "Something went wrong."
const send = (path, init) => fetch(BASE + path, { ...init, signal: AbortSignal.timeout(20000) }).catch((cause) => {
  const what = cause.name === 'TimeoutError' ? 'did not answer in time' : 'could not be reached';
  throw Object.assign(new Error(`PayPal ${what}. Try again in a moment.`, { cause }), { status: 502 });
});

async function accessToken() {
  if (Date.now() < token.expiresAt) return token.value;
  const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) throw Object.assign(new Error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.'), { status: 503 });
  const res = await send('/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`PayPal token request failed (${res.status}).`), { status: 502 });
  token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return token.value;
}

async function api(method, path, body, headers = {}) {
  const res = await send(path, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  // PayPal's own wording is passed on, marked as PayPal's, so a refusal about authorization is not read as a wrong organizer key.
  throw Object.assign(new Error(data.message ? `PayPal: ${data.message}` : `PayPal ${method} ${path} failed (${res.status}).`), {
    status: 502,
    issue: data.details?.[0]?.issue || data.name || '',
    debugId: data.debug_id || res.headers.get('paypal-debug-id') || '',
    body: JSON.stringify(data), // kept for callers that need more than the message; never sent to the browser
  });
}

// lines: [{ sku, name, amountCents }]. One order, one line item per project.
export async function createOrder({ lines, returnUrl, cancelUrl, requestId }) {
  const total = usd(lines.reduce((a, l) => a + l.amountCents, 0));
  const order = await api('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    payment_source: { paypal: { experience_context: { brand_name: 'Headcount', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: returnUrl, cancel_url: cancelUrl } } },
    purchase_units: [{
      description: 'Headcount matching round',
      amount: { currency_code: 'USD', value: total, breakdown: { item_total: { currency_code: 'USD', value: total } } },
      // No item category: PayPal refuses DONATION items (403 PERMISSION_DENIED_FOR_DONATION_ITEMS) from an account it has not approved for donations.
      items: lines.map((l) => ({ name: l.name.slice(0, 127), sku: l.sku, quantity: '1', unit_amount: { currency_code: 'USD', value: usd(l.amountCents) } })),
    }],
  }, { 'PayPal-Request-Id': requestId });
  const approveUrl = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
  if (!approveUrl) throw Object.assign(new Error('PayPal returned no approval link.'), { status: 502 });
  return { id: order.id, approveUrl };
}

const linesOf = (order) => (order.purchase_units?.[0]?.items ?? []).map((i) => ({ sku: i.sku, amountCents: toCents(i.unit_amount.value) * Number(i.quantity || 1) }));

// Captures an approved order and returns one flat record. Safe to call twice for the same order.
export async function captureOrder(orderId) {
  const path = `/v2/checkout/orders/${encodeURIComponent(orderId)}`;
  let order;
  try {
    order = await api('POST', `${path}/capture`, {}, { 'PayPal-Request-Id': `capture-${orderId}`, Prefer: 'return=representation' });
  } catch (err) {
    if (err.issue !== 'ORDER_ALREADY_CAPTURED') throw err;
    order = await api('GET', path);
  }
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  let lines = linesOf(order);
  if (!lines.length) lines = linesOf(await api('GET', path)); // some capture responses omit items
  if (!lines.length && capture?.amount) lines = [{ sku: 'POOL', amountCents: toCents(capture.amount.value) }]; // never lose captured money
  const payer = order.payment_source?.paypal ?? {};
  return {
    orderId: order.id,
    status: capture?.status ?? order.status,
    captureId: capture?.id ?? null,
    payerId: payer.account_id ?? order.payer?.payer_id ?? null,
    payerEmail: payer.email_address ?? order.payer?.email_address ?? null,
    accountStatus: payer.account_status ?? null,
    feeCents: toCents(capture?.seller_receivable_breakdown?.paypal_fee?.value ?? 0),
    lines,
  };
}

// items: [{ itemId, email, amountCents, note }]. PayPal pays a senderBatchId once. It rejects a repeat within 30 days
// and links to the original payout. That link is followed here, so a retry after a lost reply returns the batch that was sent.
export async function createPayout({ senderBatchId, items }) {
  try {
    const res = await api('POST', '/v1/payments/payouts', {
      sender_batch_header: { sender_batch_id: senderBatchId, email_subject: 'Your Headcount round has paid out' },
      items: items.map((i) => ({ recipient_type: 'EMAIL', receiver: i.email, amount: { value: usd(i.amountCents), currency: 'USD' }, note: i.note, sender_item_id: i.itemId })),
    });
    return { batchId: res.batch_header.payout_batch_id, status: res.batch_header.batch_status };
  } catch (err) {
    const original = /\/v1\/payments\/payouts\/([A-Za-z0-9_-]+)/.exec(err.body ?? '')?.[1];
    if (!original) throw err;
    return { batchId: original, status: (await getPayout(original)).status };
  }
}

export async function getPayout(batchId) {
  const res = await api('GET', `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
  return {
    batchId,
    status: res.batch_header.batch_status,
    items: (res.items ?? []).map((i) => ({ itemId: i.payout_item.sender_item_id, status: i.transaction_status })),
  };
}
