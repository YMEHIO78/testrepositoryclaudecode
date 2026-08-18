// Service packages and the per-client quantities that derive a client's
// value.
//
// A client's value is never stored. It is SUM(unit_cents * quantity)
// computed on read, which is why repricing a package immediately and
// correctly moves every client that carries it. A cached total would
// have to be invalidated on every price change, and the first missed
// invalidation is a wrong number on an invoice.
const { pool } = require('./db');

function toPackage(row) {
  return {
    id: row.id,
    name: row.name,
    unitCents: Number(row.unit_cents),
    unitNote: row.unit_note,
    active: row.active,
    sortOrder: row.sort_order,
    inUse: row.in_use === undefined ? undefined : Number(row.in_use) > 0,
  };
}

async function listPackages({ activeOnly = false } = {}) {
  const { rows } = await pool.query(
    `SELECT p.*, (SELECT count(*) FROM client_packages cp
                   WHERE cp.package_id = p.id AND cp.quantity > 0) AS in_use
       FROM packages p
      ${activeOnly ? 'WHERE p.active' : ''}
      ORDER BY p.sort_order, lower(p.name)`,
  );
  return rows.map(toPackage);
}

function cleanCents(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) throw new Error('A unit price is required.');
  return n;
}

async function createPackage({ name, unitCents, unitNote, sortOrder }) {
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) throw new Error('A package name is required.');

  const { rows } = await pool.query(
    `INSERT INTO packages (name, unit_cents, unit_note, sort_order)
     VALUES ($1,$2,$3,COALESCE($4, (SELECT COALESCE(max(sort_order),0)+1 FROM packages)))
     RETURNING *`,
    [clean, cleanCents(unitCents), unitNote ? String(unitNote).slice(0, 200) : null,
      sortOrder ?? null],
  );
  return toPackage(rows[0]);
}

async function updatePackage(id, input) {
  const { rows } = await pool.query(
    `UPDATE packages SET
       name = COALESCE($2, name),
       unit_cents = COALESCE($3, unit_cents),
       unit_note = COALESCE($4, unit_note),
       active = COALESCE($5, active),
       sort_order = COALESCE($6, sort_order)
     WHERE id = $1 RETURNING *`,
    [
      id,
      input.name === undefined ? null : String(input.name).trim().slice(0, 120) || null,
      input.unitCents === undefined ? null : cleanCents(input.unitCents),
      input.unitNote === undefined ? null : String(input.unitNote).slice(0, 200),
      input.active === undefined ? null : !!input.active,
      input.sortOrder === undefined ? null : Number(input.sortOrder),
    ],
  );
  return rows.length ? toPackage(rows[0]) : null;
}

// Retire rather than delete once a package is on a client. Deleting would
// cascade its quantities away and silently reduce that client's value,
// and nothing here is backed up. Retiring hides it from new work while
// leaving every existing figure intact.
async function removePackage(id) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM client_packages WHERE package_id = $1 AND quantity > 0`,
    [id],
  );
  if (rows[0].n > 0) {
    const updated = await updatePackage(id, { active: false });
    return { retired: true, clients: rows[0].n, package: updated };
  }
  const del = await pool.query(`DELETE FROM packages WHERE id = $1 RETURNING id`, [id]);
  return del.rowCount ? { retired: false } : null;
}

// Every active package plus this client's quantity for each, so the UI can
// render the full list of steppers without a second call. A retired
// package still appears if the client has a quantity on it - otherwise
// their value would include a line they cannot see.
async function clientPackages(clientId) {
  const { rows } = await pool.query(
    `SELECT p.*, COALESCE(cp.quantity, 0) AS quantity
       FROM packages p
       LEFT JOIN client_packages cp
         ON cp.package_id = p.id AND cp.client_id = $1
      WHERE p.active OR COALESCE(cp.quantity, 0) > 0
      ORDER BY p.sort_order, lower(p.name)`,
    [clientId],
  );
  return rows.map((r) => ({
    ...toPackage(r),
    quantity: Number(r.quantity),
    subtotalCents: Number(r.unit_cents) * Number(r.quantity),
  }));
}

async function setQuantity(clientId, packageId, quantity) {
  const qty = Math.max(0, Math.round(Number(quantity) || 0));
  await pool.query(
    `INSERT INTO client_packages (client_id, package_id, quantity)
     VALUES ($1,$2,$3)
     ON CONFLICT (client_id, package_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
    [clientId, packageId, qty],
  );
  return { clientId, packageId, quantity: qty };
}

// The derived value for one client.
async function valueFor(clientId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(p.unit_cents * cp.quantity), 0)::bigint AS total
       FROM client_packages cp
       JOIN packages p ON p.id = cp.package_id
      WHERE cp.client_id = $1`,
    [clientId],
  );
  return Number(rows[0].total);
}

// Derived values for many clients at once, so listing clients stays a
// single round trip rather than one query per row.
async function valuesByClient() {
  const { rows } = await pool.query(
    `SELECT cp.client_id, COALESCE(SUM(p.unit_cents * cp.quantity), 0)::bigint AS total
       FROM client_packages cp
       JOIN packages p ON p.id = cp.package_id
      GROUP BY cp.client_id`,
  );
  const map = new Map();
  for (const r of rows) map.set(r.client_id, Number(r.total));
  return map;
}

module.exports = {
  listPackages, createPackage, updatePackage, removePackage,
  clientPackages, setQuantity, valueFor, valuesByClient,
};
