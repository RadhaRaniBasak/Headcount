// State for one round, kept in memory and written to a JSON file. Seeds a demo round on first run.
// ponytail: one JSON file, sync writes. Move to SQLite or Postgres when more than one process writes.
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.DATA_FILE || './data/db.json';

export const PROJECTS = [
  { id: 'p1', name: 'Accessible Date Picker', blurb: 'A date picker that works with screen readers and keyboards, for any web framework.', tags: ['accessibility', 'web', 'ui'] },
  { id: 'p2', name: 'Streaming CSV Parser', blurb: 'Reads multi-gigabyte CSV files in constant memory for data pipelines.', tags: ['data', 'performance', 'node'] },
  { id: 'p3', name: 'Offline Map Tiles', blurb: 'Packs open map data so field workers can navigate with no signal.', tags: ['maps', 'offline', 'humanitarian'] },
  { id: 'p4', name: 'Bengali Spellcheck Dictionary', blurb: 'An open word list and spellchecker for Bengali text in editors and browsers.', tags: ['language', 'bengali', 'india', 'localization'] },
  { id: 'p5', name: 'Tiny Test Runner', blurb: 'A zero-dependency test runner that starts in milliseconds.', tags: ['testing', 'developer-tools'] },
  { id: 'p6', name: 'Screen Reader Test Kit', blurb: 'Automated checks that run a real screen reader against your pages in CI.', tags: ['accessibility', 'testing', 'ci'] },
  { id: 'p7', name: 'Low-Bandwidth Docs Search', blurb: 'Search for documentation sites that works on 2G and ships under 20 KB.', tags: ['search', 'performance', 'emerging-markets'] },
  { id: 'p8', name: 'Timezone Data Mirror', blurb: 'A fast, verified mirror of the timezone database for languages without one.', tags: ['time', 'infrastructure'] },
];

// Small deterministic PRNG so every fresh round looks the same.
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seed() {
  const rand = mulberry32(2026);
  const emails = (process.env.PROJECT_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const projects = PROJECTS.map((p, i) => ({ ...p, payoutEmail: emails.length ? emails[i % emails.length] : `owner-${p.id}@example.com` }));
  const at = new Date().toISOString();
  const sim = (id, projectId, payerId, payer, verified, amountCents) =>
    ({ id, orderId: null, captureId: null, projectId, payerId, payer, verified, amountCents, feeCents: 0, source: 'simulated', at });
  const gifts = [sim('sim-pool', 'POOL', 'sim-sponsor', 'Demo sponsor (simulated)', true, 500000)];
  const weights = [9, 5, 7, 6, 3, 8, 4, 2]; // how popular each project is with the simulated crowd
  const amounts = [500, 1000, 1000, 2000, 2500, 5000];
  const pick = () => {
    let r = rand() * weights.reduce((a, b) => a + b, 0);
    return weights.findIndex((w) => (r -= w) < 0);
  };
  for (let d = 1; d <= 120; d++) {
    const verified = rand() > 0.07;
    const chosen = new Set();
    for (let k = 1 + Math.floor(rand() * 3); k > 0; k--) chosen.add(pick());
    for (const p of chosen) {
      gifts.push(sim(`sim-${d}-${PROJECTS[p].id}`, PROJECTS[p].id, `sim-${d}`, `Simulated donor ${d}`, verified, amounts[Math.floor(rand() * amounts.length)]));
    }
  }
  return { round: { id: 'r' + Date.now().toString(36), status: 'OPEN', openedAt: at, closedAt: null }, projects, gifts, payout: null };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return seed();
  }
}

// The one live state object. Mutate it, then call save().
export const db = load();

export function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(db));
  fs.renameSync(FILE + '.tmp', FILE); // rename is atomic, so a crash never leaves half a file
}

export function reset() {
  for (const k of Object.keys(db)) delete db[k];
  Object.assign(db, seed());
  save();
}

// Adds n simulated donors on unverified accounts, each giving $10 to one project.
export function addFakeCrowd(n = 100, projectId = 'p8') {
  const at = new Date().toISOString();
  const tag = Date.now().toString(36);
  for (let i = 1; i <= n; i++) {
    db.gifts.push({ id: `fake-${tag}-${i}`, orderId: null, captureId: null, projectId, payerId: `fake-${tag}-${i}`, payer: `Fake donor ${i} (simulated)`, verified: false, amountCents: 1000, feeCents: 0, source: 'simulated', at });
  }
  save();
}

export function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  return domain ? `${name.slice(0, 2)}***@${domain}` : 'unknown payer';
}

save();
