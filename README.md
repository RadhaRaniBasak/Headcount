c# Headcount

Matching that counts people, not dollars: a quadratic-funding round on the PayPal sandbox, with an AI giving agent.

- Live demo: `https://YOUR-APP.onrender.com` (replace after deploying)
- Demo video: `https://YOUR-VIDEO-LINK` (replace after recording)

## The idea in four rows

A sponsor funds a matching pool. Donors give to projects. The pool is split by how many people back each project, not by how much money each raised.

Four projects each raise $1,000. A $5,000 pool is split like this:

| $1,000 raised from | Match |
| --- | --- |
| 1 donor | $0.00 |
| 10 donors giving $100 | $306.12 |
| 40 donors giving $25 | $1,326.53 |
| 100 donors giving $10 | $3,367.35 |

The rule breaks if one person can pose as a hundred donors. Headcount uses what PayPal already knows: every PayPal wallet payment comes back with a payer ID and an `account_status` of `VERIFIED` or `UNVERIFIED`.

- One payer ID is one head per project, however many gifts it makes.
- Only verified payers earn match. Every other gift still reaches its project, with no match attached.

## What happens in a round

1. **Fund.** A sponsor pays into the pool with one PayPal order.
2. **Plan.** A donor types a budget and what they care about. One LLM call proposes a basket with a reason per project. Code checks every line, and the page shows how much pool money each gift would move.
3. **Pay.** The donor pays once. Each project is a line item on the PayPal receipt, so the fixed fee is paid once instead of once per project.
4. **Count.** On return the server captures the order and reads the split, payer ID, verified flag and fee from PayPal. Nothing about the payment is trusted from the browser.
5. **Close.** The organizer confirms, the round stops taking payments, and one PayPal Payouts batch sends each project its gifts plus its match.

## What is real and what is simulated

| Real (PayPal sandbox) | Simulated (always labelled) |
| --- | --- |
| Checkout, capture, payer ID, verified flag, fees | The seeded crowd of 120 donors |
| Pool funding by a sponsor | The $5,000 pledge that makes the first screen readable |
| The payout batch and its statuses | The 100 fake donors added from the organizer panel |

Simulated gifts shape the shares on screen. They never move money: payouts are computed from real sandbox payments only, net of PayPal's fees.

## Run it

Needs Node 22 or newer.

```bash
npm install
cp .env.example .env      # then fill it in
npm test                  # matching math and the agent guard
npm run test:flow         # the whole flow, with PayPal and the LLM faked
npm run gate              # one real order and capture against your sandbox
npm run dev               # http://localhost:3000
```

### PayPal sandbox setup

1. At developer.paypal.com create a sandbox app. Copy its client ID and secret into `.env`, and check that Payouts is enabled for the app.
2. Create sandbox personal accounts: a sponsor, a verified donor, an unverified donor (created with the bank-verified option off), and one or two project owners.
3. Put the project owners' emails in `PROJECT_EMAILS`.
4. Run `npm run gate` twice, approving once with the verified donor and once with the unverified one. Both runs should print `account_status`. Add `-- --payout owner@example.com` to test a $1 payout as well.

If the gate shows no `account_status`, set `COUNT_UNKNOWN_STATUS=true`. Heads are then counted by payer ID alone.

### Environment

| Variable | Purpose |
| --- | --- |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox app credentials |
| `PROJECT_EMAILS` | Sandbox personal emails that receive payouts, comma separated |
| `ADMIN_KEY` | Secret for organizer actions. They stay off until it is set |
| `PUBLIC_URL` | Public address, used for PayPal's return link. On Render, `RENDER_EXTERNAL_URL` is used if this is blank |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | Any OpenAI-compatible chat completions endpoint. Without a key the agent falls back to keyword matching and says so |
| `COUNT_UNKNOWN_STATUS` | `true` counts payers whose capture carries no `account_status`. Default `false` |
| `PORT`, `DATA_FILE` | Optional. Defaults: `3000`, `./data/db.json` |

### Deploy

Any Node host works. On Render: new web service from this repo, build command `npm install`, start command `npm start`, then add the variables above. The free tier sleeps after 15 minutes idle and loses local files on restart, so the app reseeds an open round whenever it wakes.

## Trying the hosted demo

You need a PayPal sandbox personal account to pay. Test logins are in the submission's testing notes.

1. Type a budget and a few interests, press **Plan my gift**, then pay.
2. Pay again with an unverified sandbox account: the project's total rises and no match moves.
3. Open **Organizer**, enter the key, and add 100 fake donors: one project's "if every payment counted" figure jumps while every match stays put.
4. Close the round to send the payout batch.

## How it is built

No database, no build step, one dependency (Express).

| File | What it holds |
| --- | --- |
| `server.js` | The HTTP API, input checks, the ledger write after capture, close and payout |
| `lib/qf.js` | The matching math: heads, quadratic match, preview, settlement. Pure functions on integer cents |
| `lib/paypal.js` | Orders, capture, Payouts and token handling with `fetch`. Refuses to run outside the sandbox |
| `lib/agent.js` | The LLM call, the guard that repairs its output, and the keyword fallback |
| `lib/store.js` | One round in a JSON file, the seeded crowd, the fake crowd |
| `public/index.html` | The whole page: markup, styles and script |
| `scripts/gate.js` | The real-sandbox check |
| `scripts/flow-check.mjs` | The whole flow against a faked PayPal and LLM |
| `test.js` | Checks for the money math and the agent guard |

### Rules the code enforces

- All money is integer cents. Splits use the largest-remainder method, so parts always add up to the whole.
- For each project, raw = (sum of the square roots of each head's cents)² minus the sum of those cents. The pool is split in proportion to raw. One backer earns nothing.
- PayPal's fee on an order is split across its lines in proportion to amount. A project is paid its real gifts net of fees plus its share of the real pool net of fees, so the payout total equals real money in minus fees.
- Closing stops captures first and pays second. The payout batch ID is derived from the round, so a retry cannot pay twice.
- The LLM proposes; code decides. Unknown projects, repeats, sub-dollar amounts and overspend never reach checkout.

### API

| Route | Does |
| --- | --- |
| `GET /api/state` | Everything the page shows |
| `POST /api/plan` | `{ budgetUsd, interests }` to a checked basket with reasons and match moved |
| `POST /api/preview` | `{ lines }` to the match each line would move |
| `POST /api/checkout` | `{ lines }` to a PayPal approval link. A line with `projectId: "POOL"` funds the pool |
| `GET /api/return` | PayPal's return link. Captures and records the order |
| `POST /api/admin/fake-crowd`, `/close`, `/reset` | Organizer actions, sent with an `x-admin-key` header. `/close` also needs `{ "confirm": true }` |

When a route refuses a request it answers `{ "error": "<message>" }`, and the status says why: `400` the request is wrong, `401` wrong organizer key, `409` not possible in the round's current state, `429` too many requests, `502` PayPal failed, `503` a credential is not set. `/api/return` is opened by the payer's browser, so it redirects to `/?paid=1` or `/?error=<code>` instead.

## Limits

- A verified PayPal account is not proof of one person. One person can hold several.
- Real people can collude. There is no pairwise bounding.
- Donors on unverified accounts earn their projects no match, however sincere they are.
- If no project has two verified backers, the real pool is not paid out and stays with the organizer.
- PayPal charges the sender a fee per payout on top. It is not modelled.
- Data resets when a free host restarts.
- Sandbox only. Collecting donations needs PayPal's approval, and holding donors' money before paying it out is regulated in most places. Nothing here is legal advice.

## Credits

Quadratic funding comes from Buterin, Hitzig and Weyl, "A Flexible Design for Funding Public Goods". Delivering a flagged gift while leaving it out of the match follows the rule the Tor Project used in its 2026 round.

## Licence

MIT. See `LICENSE`.
