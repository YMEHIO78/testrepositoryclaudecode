// Client systems and their credentials.
//
// This is the most sensitive data in the app, and it differs from every
// other secret here in one way that shapes the whole design: mailbox
// passwords and API tokens are used *by* the app and never need to come
// back out, so they are write-only. These are the opposite — the entire
// point of storing a client's POS password is to read it again later. So
// there is a reveal path, and it is deliberately separate, explicit, and
// counted.
//
// Rules this module enforces:
//   - Secret values are AES-256-GCM encrypted at rest (lib/crypto.js).
//   - Listing NEVER returns a value. Not truncated, not masked — absent.
//     A masked value in a list response is still a value in the response.
//   - Reading one value is its own endpoint, one id at a time, and bumps
//     a reveal counter so the access leaves a trace.
//   - There is no bulk-reveal and no export. Deliberately: the friction
//     is the feature.
const { pool } = require('./db');
const { encryptJSON, decryptJSON } = require('./crypto');

// What kind of thing the value is. Affects nothing but the label shown —
// a token and a password are stored identically.
const KINDS = ['password', 'api_key', 'token', 'code', 'note'];

function toSystem(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name ?? null,
    name: row.name,
    url: row.url,
    notes: row.notes,
    secretCount: row.secret_count === undefined ? undefined : Number(row.secret_count),
    createdAt: row.created_at,
  };
}

// Note what is absent: encrypted_value, iv, auth_tag. This shape is the
// one the browser sees, and it cannot carry a secret because the columns
// are never selected in the first place.
function toSecret(row) {
  return {
    id: row.id,
    systemId: row.system_id,
    label: row.label,
    kind: row.kind,
    username: row.username,
    notes: row.notes,
    lastRevealedAt: row.last_revealed_at,
    revealCount: row.reveal_count,
    updatedAt: row.updated_at,
  };
}

async function listSystems(clientId) {
  const { rows } = await pool.query(
    `SELECT s.*, c.name AS client_name,
            (SELECT count(*) FROM client_secrets x WHERE x.system_id = s.id) AS secret_count
       FROM client_systems s
       JOIN clients c ON c.id = s.client_id
      ${clientId ? 'WHERE s.client_id = $1' : ''}
      ORDER BY lower(s.name)`,
    clientId ? [clientId] : [],
  );
  return rows.map(toSystem);
}

async function listSecrets(systemId) {
  const { rows } = await pool.query(
    `SELECT id, system_id, label, kind, username, notes,
            last_revealed_at, reveal_count, updated_at
       FROM client_secrets WHERE system_id = $1 ORDER BY lower(label)`,
    [systemId],
  );
  return rows.map(toSecret);
}

// Everything for one client in the shape the UI renders.
async function forClient(clientId) {
  const systems = await listSystems(clientId);
  for (const system of systems) {
    system.secrets = await listSecrets(system.id);
  }
  return systems;
}

async function createSystem({ clientId, name, url, notes }) {
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) throw new Error('A system name is required.');
  const { rows } = await pool.query(
    `INSERT INTO client_systems (client_id, name, url, notes)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [clientId, clean, url || null, notes || null],
  );
  return toSystem(rows[0]);
}

async function updateSystem(id, input) {
  const { rows } = await pool.query(
    `UPDATE client_systems SET
       name = COALESCE($2, name), url = $3, notes = $4, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, input.name ? String(input.name).trim().slice(0, 120) : null,
      input.url || null, input.notes || null],
  );
  return rows.length ? toSystem(rows[0]) : null;
}

// Cascades to that system's secrets. The confirm text in the UI says how
// many are about to go, because this is unrecoverable.
async function deleteSystem(id) {
  const { rowCount } = await pool.query(`DELETE FROM client_systems WHERE id = $1`, [id]);
  return rowCount > 0;
}

async function createSecret({ systemId, label, kind, username, value, notes }) {
  const cleanLabel = String(label || '').trim().slice(0, 120);
  if (!cleanLabel) throw new Error('A label is required.');
  if (!value) throw new Error('A value is required.');

  const { ciphertext, iv, authTag } = encryptJSON(String(value));
  const { rows } = await pool.query(
    `INSERT INTO client_secrets
       (system_id, label, kind, username, encrypted_value, iv, auth_tag, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, system_id, label, kind, username, notes, last_revealed_at, reveal_count, updated_at`,
    [systemId, cleanLabel, KINDS.includes(kind) ? kind : 'password',
      username || null, ciphertext, iv, authTag, notes || null],
  );
  return toSecret(rows[0]);
}

// An omitted `value` leaves the stored secret alone, so the metadata can
// be corrected without re-typing the credential.
async function updateSecret(id, input) {
  const sets = ['label = COALESCE($2, label)', 'kind = COALESCE($3, kind)',
    'username = $4', 'notes = $5', 'updated_at = now()'];
  const params = [id,
    input.label ? String(input.label).trim().slice(0, 120) : null,
    input.kind && KINDS.includes(input.kind) ? input.kind : null,
    input.username || null, input.notes || null];

  if (input.value) {
    const { ciphertext, iv, authTag } = encryptJSON(String(input.value));
    params.push(ciphertext, iv, authTag);
    sets.push(`encrypted_value = $${params.length - 2}`,
      `iv = $${params.length - 1}`, `auth_tag = $${params.length}`);
  }

  const { rows } = await pool.query(
    `UPDATE client_secrets SET ${sets.join(', ')} WHERE id = $1
     RETURNING id, system_id, label, kind, username, notes, last_revealed_at, reveal_count, updated_at`,
    params,
  );
  return rows.length ? toSecret(rows[0]) : null;
}

async function deleteSecret(id) {
  const { rowCount } = await pool.query(`DELETE FROM client_secrets WHERE id = $1`, [id]);
  return rowCount > 0;
}

// The only function in the app that returns a stored client credential.
// One id at a time, and the counter is bumped in the same statement that
// reads the row, so a reveal cannot happen without being recorded.
async function revealSecret(id) {
  const { rows } = await pool.query(
    `UPDATE client_secrets
        SET reveal_count = reveal_count + 1, last_revealed_at = now()
      WHERE id = $1
      RETURNING id, label, encrypted_value, iv, auth_tag, reveal_count, last_revealed_at`,
    [id],
  );
  if (!rows.length) return null;
  const r = rows[0];

  // A decrypt failure here almost always means TOKEN_ENCRYPTION_KEY was
  // rotated after the secret was stored. Say so plainly — the generic
  // "unsupported state" GCM error sends people looking in the wrong place.
  let value;
  try {
    value = decryptJSON({ ciphertext: r.encrypted_value, iv: r.iv, authTag: r.auth_tag });
  } catch (err) {
    throw new Error('Could not decrypt this value. TOKEN_ENCRYPTION_KEY has probably '
      + 'changed since it was saved — a rotated key makes stored secrets unreadable.');
  }

  return {
    id: r.id, label: r.label, value,
    revealCount: r.reveal_count, lastRevealedAt: r.last_revealed_at,
  };
}

// Counts per client, so a client page can show that credentials exist
// without loading any of them.
async function countsByClient() {
  const { rows } = await pool.query(
    `SELECT s.client_id, count(DISTINCT s.id)::int AS systems,
            count(x.id)::int AS secrets
       FROM client_systems s
       LEFT JOIN client_secrets x ON x.system_id = s.id
      GROUP BY s.client_id`,
  );
  const map = new Map();
  for (const r of rows) map.set(r.client_id, { systems: r.systems, secrets: r.secrets });
  return map;
}

module.exports = {
  KINDS, listSystems, listSecrets, forClient,
  createSystem, updateSystem, deleteSystem,
  createSecret, updateSecret, deleteSecret,
  revealSecret, countsByClient,
};
