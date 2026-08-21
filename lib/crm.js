// CRM — clients (companies moving through a pipeline) and the contacts
// at them. Deliberately the first real module: tickets, projects, and
// invoices all reference a client, so building those first would mean
// inventing a client link and rewriting it later.
const { pool } = require('./db');
const packages = require('./packages');

// Ordered from coldest to won; the UI renders them in this order.
const STAGES = [
  { key: 'in_contact', label: 'In contact', tone: 'grey' },
  { key: 'engaging', label: 'Engaging', tone: 'grey' },
  { key: 'offer_sent', label: 'Offer sent', tone: 'amber' },
  { key: 'client', label: 'Client', tone: 'brand' },
  { key: 'lost', label: 'Lost', tone: 'red' },
];
const STAGE_KEYS = STAGES.map((s) => s.key);

// From the design reference. Both are judgements, so both are optional —
// an unset health is honestly "nobody has said", which is different from
// green.
const TERMS = ['Retainer', 'Project', 'Internal'];
const HEALTH = [
  { key: 'Green', tone: 'brand' },
  { key: 'Watch', tone: 'amber' },
  { key: 'At risk', tone: 'red' },
];
const HEALTH_KEYS = HEALTH.map((h) => h.key);

function normalizeFrom(list, value) {
  if (value === null || value === undefined || value === '') return null;
  return list.includes(value) ? value : null;
}

// valueCents is derived from package quantities and filled in by the
// caller, never read from the row. `clients.value_cents` still holds
// whatever was typed before packages existed; it is surfaced separately
// as legacyValueCents so the old figure is visible until it has been
// re-entered as quantities, rather than vanishing on deploy day.
function toClient(row) {
  return {
    id: row.id,
    name: row.name,
    stage: row.stage,
    valueCents: 0,
    legacyValueCents: row.value_cents === null ? null : Number(row.value_cents),
    recurring: row.recurring,
    terms: row.terms,
    health: row.health,
    clientSince: row.client_since,
    logo: row.logo || null,
    notes: row.notes,
    lastTouchAt: row.last_touch_at,
    contacts: [],
  };
}

function toContact(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    isPrimary: row.is_primary,
  };
}

async function listClients() {
  const { rows } = await pool.query(
    `SELECT * FROM clients
      ORDER BY array_position($1::text[], stage), name`,
    [STAGE_KEYS],
  );
  const clients = rows.map(toClient);
  if (!clients.length) return clients;

  // One grouped query for every client's derived value, rather than a
  // per-row lookup.
  const values = await packages.valuesByClient();
  const summaries = await packages.summariesByClient();
  for (const client of clients) {
    client.valueCents = values.get(client.id) || 0;
    client.packagesSummary = summaries.get(client.id) || null;
  }

  const { rows: contactRows } = await pool.query(
    `SELECT * FROM contacts WHERE client_id = ANY($1::int[]) ORDER BY is_primary DESC, name`,
    [clients.map((c) => c.id)],
  );
  const byClient = new Map(clients.map((c) => [c.id, c]));
  for (const row of contactRows) {
    byClient.get(row.client_id)?.contacts.push(toContact(row));
  }
  return clients;
}

async function getClient(id) {
  const { rows } = await pool.query(`SELECT * FROM clients WHERE id = $1`, [id]);
  if (!rows.length) return null;
  const client = toClient(rows[0]);
  client.valueCents = await packages.valueFor(id);
  const { rows: contactRows } = await pool.query(
    `SELECT * FROM contacts WHERE client_id = $1 ORDER BY is_primary DESC, name`,
    [id],
  );
  client.contacts = contactRows.map(toContact);
  return client;
}

function normalizeStage(stage) {
  return STAGE_KEYS.includes(stage) ? stage : 'in_contact';
}

async function createClient(input) {
  const { rows } = await pool.query(
    `INSERT INTO clients (name, stage, value_cents, recurring, notes, last_touch_at,
                          terms, health, client_since)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      input.name,
      normalizeStage(input.stage),
      input.valueCents ?? null,
      !!input.recurring,
      input.notes || null,
      input.lastTouchAt || null,
      normalizeFrom(TERMS, input.terms),
      normalizeFrom(HEALTH_KEYS, input.health),
      input.clientSince || null,
    ],
  );
  return toClient(rows[0]);
}

async function updateClient(id, input) {
  const { rows } = await pool.query(
    `UPDATE clients SET
       name = COALESCE($2, name),
       stage = COALESCE($3, stage),
       -- COALESCE, not a bare assignment: value_cents is now only the
       -- pre-packages legacy figure, and the editor no longer sends it.
       -- A bare assignment would quietly null it on the next unrelated
       -- edit, destroying the number we promised to keep visible until
       -- it has been re-entered as quantities.
       value_cents = COALESCE($4, value_cents),
       recurring = COALESCE($5, recurring),
       notes = $6,
       last_touch_at = $7,
       -- COALESCE so a partial update (the detail page's inline stage,
       -- terms and health dropdowns each send one field) leaves the rest
       -- alone. Clearing one is done by sending the empty string, which
       -- normalizeFrom turns into null.
       terms = CASE WHEN $8::text IS NULL THEN terms
                    WHEN $8 = '' THEN NULL ELSE $8 END,
       health = CASE WHEN $9::text IS NULL THEN health
                     WHEN $9 = '' THEN NULL ELSE $9 END,
       client_since = COALESCE($10, client_since),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      id,
      input.name ?? null,
      input.stage ? normalizeStage(input.stage) : null,
      input.valueCents ?? null,
      input.recurring ?? null,
      input.notes || null,
      input.lastTouchAt || null,
      input.terms === undefined ? null : (normalizeFrom(TERMS, input.terms) ?? ''),
      input.health === undefined ? null : (normalizeFrom(HEALTH_KEYS, input.health) ?? ''),
      input.clientSince || null,
    ],
  );
  if (!rows.length) return null;
  const client = toClient(rows[0]);
  client.valueCents = await packages.valueFor(id);
  return client;
}

async function deleteClient(id) {
  // Contacts cascade; nothing else references clients yet.
  const { rowCount } = await pool.query(`DELETE FROM clients WHERE id = $1`, [id]);
  return rowCount > 0;
}

// --- contacts ---

async function createContact(clientId, input) {
  if (input.isPrimary) await clearPrimary(clientId);
  const { rows } = await pool.query(
    `INSERT INTO contacts (client_id, name, email, phone, role, is_primary)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [clientId, input.name, input.email || null, input.phone || null, input.role || null, !!input.isPrimary],
  );
  return toContact(rows[0]);
}

async function updateContact(id, input) {
  if (input.isPrimary) {
    const { rows } = await pool.query(`SELECT client_id FROM contacts WHERE id = $1`, [id]);
    if (rows.length) await clearPrimary(rows[0].client_id);
  }
  const { rows } = await pool.query(
    `UPDATE contacts SET
       name = COALESCE($2, name),
       email = $3, phone = $4, role = $5,
       is_primary = COALESCE($6, is_primary),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, input.name ?? null, input.email || null, input.phone || null, input.role || null, input.isPrimary ?? null],
  );
  return rows.length ? toContact(rows[0]) : null;
}

// Only one primary per client, enforced on write rather than by
// constraint so switching primary is a single user action.
async function clearPrimary(clientId) {
  await pool.query(`UPDATE contacts SET is_primary = false WHERE client_id = $1`, [clientId]);
}

async function deleteContact(id) {
  const { rowCount } = await pool.query(`DELETE FROM contacts WHERE id = $1`, [id]);
  return rowCount > 0;
}

// --- inbox linkage ---

// Given sender addresses from the inbox, return which ones belong to a
// known contact. This is what makes the CRM pay for itself immediately:
// mail from a known client is labelled without anyone tagging it.
async function matchEmails(emails) {
  const cleaned = [...new Set(
    (emails || []).filter(Boolean).map((e) => String(e).toLowerCase().trim()),
  )];
  if (!cleaned.length) return {};

  const { rows } = await pool.query(
    `SELECT c.email, c.name AS contact_name, cl.id AS client_id, cl.name AS client_name, cl.stage
       FROM contacts c
       JOIN clients cl ON cl.id = c.client_id
      WHERE lower(c.email) = ANY($1::text[])`,
    [cleaned],
  );

  const map = {};
  for (const r of rows) {
    map[r.email.toLowerCase()] = {
      clientId: r.client_id,
      clientName: r.client_name,
      contactName: r.contact_name,
      stage: r.stage,
    };
  }
  return map;
}

// Records that a client was in touch, used to keep "last touch" honest
// without anyone maintaining it by hand.
async function touchClient(clientId, when) {
  await pool.query(
    `UPDATE clients SET last_touch_at = GREATEST(COALESCE(last_touch_at, 'epoch'::timestamptz), $2), updated_at = now()
      WHERE id = $1`,
    [clientId, when || new Date().toISOString()],
  );
}

// A client's logo. Raster formats only: the browser produces these by
// drawing the picked file onto a canvas, so anything that arrives is
// already PNG, JPEG or WebP. Accepting SVG would mean storing markup
// that other code might one day render as markup rather than as an
// image, which is a door worth not opening.
const LOGO_TYPES = /^data:image\/(png|jpeg|webp);base64,/;
// Generous for a 192px square, and small enough that a hundred clients
// still make a sane export.
const LOGO_MAX_BYTES = 128 * 1024;

async function setLogo(id, dataUri) {
  if (dataUri === null) {
    const { rowCount } = await pool.query(
      `UPDATE clients SET logo = NULL, updated_at = now() WHERE id = $1`, [id]);
    return rowCount > 0 ? { id, logo: null } : null;
  }

  if (typeof dataUri !== 'string' || !LOGO_TYPES.test(dataUri)) {
    throw new Error('A logo must be a PNG, JPEG or WebP image.');
  }
  if (dataUri.length > LOGO_MAX_BYTES) {
    throw new Error('That image is too large even after resizing — try a simpler one.');
  }

  const { rowCount } = await pool.query(
    `UPDATE clients SET logo = $2, updated_at = now() WHERE id = $1`, [id, dataUri]);
  return rowCount > 0 ? { id, logo: dataUri } : null;
}

// Contacts matching a typed fragment, for the recipient box.
//
// Only contacts that have an email address: one without an address
// cannot receive anything, and offering it would be a suggestion that
// does not work when picked.
//
// Ordered so the most useful sit at the top — a match on the start of a
// name or address beats one in the middle, which beats a match on the
// company name alone.
async function searchContacts(term, limit = 8) {
  const raw = String(term || '').trim();
  if (raw.length < 2) return [];

  // Same escaping as global search: a literal % or _ should search for
  // that character rather than matching everything.
  const escaped = raw.replace(/[%_\\]/g, (ch) => `\\${ch}`);
  const contains = `%${escaped}%`;
  const starts = `${escaped}%`;

  const { rows } = await pool.query(
    `SELECT ct.id, ct.name, ct.email, ct.role, c.name AS client_name, c.id AS client_id
       FROM contacts ct
       LEFT JOIN clients c ON c.id = ct.client_id
      WHERE ct.email IS NOT NULL AND ct.email <> ''
        AND (ct.name ILIKE $1 OR ct.email ILIKE $1 OR c.name ILIKE $1)
      ORDER BY
        (ct.email ILIKE $2 OR ct.name ILIKE $2) DESC,
        ct.is_primary DESC,
        ct.name ASC
      LIMIT $3`,
    [contains, starts, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    clientId: r.client_id,
    clientName: r.client_name,
  }));
}

module.exports = {
  STAGES,
  searchContacts,
  setLogo,
  LOGO_MAX_BYTES,
  TERMS,
  HEALTH,
  listClients,
  getClient,
  createClient,
  updateClient,
  deleteClient,
  createContact,
  updateContact,
  deleteContact,
  matchEmails,
  touchClient,
};
