// Service desk. Tickets can be raised by hand or created straight from
// an email, and their SLA due dates are projected onto the calendar as
// source='ticket' events — which is what makes the "SLA due — TKT-118"
// line on the calendar real rather than static markup.
const { pool } = require('./db');

const STATUSES = [
  { key: 'open', label: 'Open', tone: 'red' },
  { key: 'in_progress', label: 'In progress', tone: 'amber' },
  { key: 'waiting', label: 'Waiting', tone: 'grey' },
  { key: 'resolved', label: 'Resolved', tone: 'green' },
  { key: 'closed', label: 'Closed', tone: 'grey' },
];
const PRIORITIES = [
  { key: 'low', label: 'Low', tone: 'grey' },
  { key: 'normal', label: 'Normal', tone: 'grey' },
  { key: 'high', label: 'High', tone: 'amber' },
  { key: 'urgent', label: 'Urgent', tone: 'red' },
];

const STATUS_KEYS = STATUSES.map((s) => s.key);
const PRIORITY_KEYS = PRIORITIES.map((p) => p.key);
const CLOSED_STATUSES = ['resolved', 'closed'];

function toTicket(row) {
  return {
    id: row.id,
    reference: row.reference,
    subject: row.subject,
    body: row.body,
    clientId: row.client_id,
    clientName: row.client_name ?? null,
    contactEmail: row.contact_email,
    status: row.status,
    priority: row.priority,
    slaDueAt: row.sla_due_at,
    source: row.source,
    sourceAccount: row.source_account,
    sourceUid: row.source_uid,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

async function listTickets({ openOnly = false } = {}) {
  const { rows } = await pool.query(
    `SELECT t.*, c.name AS client_name
       FROM tickets t
       LEFT JOIN clients c ON c.id = t.client_id
      ${openOnly ? `WHERE t.status NOT IN ('resolved','closed')` : ''}
      ORDER BY
        CASE WHEN t.status IN ('resolved','closed') THEN 1 ELSE 0 END,
        array_position($1::text[], t.priority) DESC,
        t.sla_due_at NULLS LAST,
        t.created_at DESC
      LIMIT 200`,
    [PRIORITY_KEYS],
  );
  return rows.map(toTicket);
}

async function getTicket(id) {
  const { rows } = await pool.query(
    `SELECT t.*, c.name AS client_name FROM tickets t
       LEFT JOIN clients c ON c.id = t.client_id WHERE t.id = $1`,
    [id],
  );
  return rows.length ? toTicket(rows[0]) : null;
}

function normalize(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

// Keeps the calendar in step with a ticket's SLA: creates the event when
// a due date appears, moves it when the date changes, and removes it
// when the date is cleared or the ticket is done. Without this the
// calendar would drift out of sync with the desk.
async function syncSlaEvent(ticket) {
  const { rows } = await pool.query(`SELECT calendar_event_id FROM tickets WHERE id = $1`, [ticket.id]);
  const existingId = rows[0]?.calendar_event_id ?? null;
  const wanted = ticket.slaDueAt && !CLOSED_STATUSES.includes(ticket.status);

  if (!wanted) {
    if (existingId) {
      await pool.query(`DELETE FROM calendar_events WHERE id = $1`, [existingId]);
      await pool.query(`UPDATE tickets SET calendar_event_id = NULL WHERE id = $1`, [ticket.id]);
    }
    return;
  }

  const title = `SLA due — ${ticket.reference}`;
  const notes = [ticket.subject, ticket.clientName].filter(Boolean).join(' · ');

  if (existingId) {
    const { rowCount } = await pool.query(
      `UPDATE calendar_events SET title = $2, starts_at = $3, ends_at = NULL, notes = $4, updated_at = now()
        WHERE id = $1`,
      [existingId, title, ticket.slaDueAt, notes],
    );
    if (rowCount) return;
    // The event was deleted from the calendar behind our back; fall
    // through and recreate it rather than losing the deadline.
  }

  const { rows: created } = await pool.query(
    `INSERT INTO calendar_events (title, starts_at, all_day, notes, source)
     VALUES ($1,$2,false,$3,'ticket') RETURNING id`,
    [title, ticket.slaDueAt, notes],
  );
  await pool.query(`UPDATE tickets SET calendar_event_id = $2 WHERE id = $1`, [ticket.id, created[0].id]);
}

async function createTicket(input) {
  const { rows: refRows } = await pool.query(`SELECT nextval('ticket_reference_seq') AS n`);
  const reference = `TKT-${refRows[0].n}`;

  const { rows } = await pool.query(
    `INSERT INTO tickets
       (reference, subject, body, client_id, contact_email, status, priority,
        sla_due_at, source, source_account, source_uid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      reference,
      input.subject,
      input.body || null,
      input.clientId || null,
      input.contactEmail || null,
      normalize(input.status, STATUS_KEYS, 'open'),
      normalize(input.priority, PRIORITY_KEYS, 'normal'),
      input.slaDueAt || null,
      input.source === 'email' ? 'email' : 'manual',
      input.sourceAccount || null,
      input.sourceUid ? String(input.sourceUid) : null,
    ],
  );

  const ticket = await getTicket(rows[0].id);
  await syncSlaEvent(ticket);
  return getTicket(ticket.id);
}

async function updateTicket(id, input) {
  const current = await getTicket(id);
  if (!current) return null;

  const status = input.status ? normalize(input.status, STATUS_KEYS, current.status) : current.status;
  const becameResolved = CLOSED_STATUSES.includes(status) && !CLOSED_STATUSES.includes(current.status);
  const reopened = !CLOSED_STATUSES.includes(status) && CLOSED_STATUSES.includes(current.status);

  await pool.query(
    `UPDATE tickets SET
       subject = COALESCE($2, subject),
       body = $3,
       client_id = $4,
       contact_email = $5,
       status = $6,
       priority = $7,
       sla_due_at = $8,
       resolved_at = CASE WHEN $9 THEN now() WHEN $10 THEN NULL ELSE resolved_at END,
       updated_at = now()
     WHERE id = $1`,
    [
      id,
      input.subject ?? null,
      input.body ?? current.body,
      input.clientId === undefined ? current.clientId : (input.clientId || null),
      input.contactEmail === undefined ? current.contactEmail : (input.contactEmail || null),
      status,
      input.priority ? normalize(input.priority, PRIORITY_KEYS, current.priority) : current.priority,
      input.slaDueAt === undefined ? current.slaDueAt : (input.slaDueAt || null),
      becameResolved,
      reopened,
    ],
  );

  const updated = await getTicket(id);
  await syncSlaEvent(updated);
  return getTicket(id);
}

async function deleteTicket(id) {
  const { rows } = await pool.query(`SELECT calendar_event_id FROM tickets WHERE id = $1`, [id]);
  if (!rows.length) return false;
  if (rows[0].calendar_event_id) {
    await pool.query(`DELETE FROM calendar_events WHERE id = $1`, [rows[0].calendar_event_id]);
  }
  await pool.query(`DELETE FROM tickets WHERE id = $1`, [id]);
  return true;
}

async function stats() {
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE status NOT IN ('resolved','closed'))::int AS open,
       count(*) FILTER (WHERE status NOT IN ('resolved','closed')
                          AND sla_due_at IS NOT NULL
                          AND sla_due_at < now() + interval '24 hours')::int AS due_soon
       FROM tickets`,
  );
  return rows[0];
}

module.exports = {
  STATUSES,
  PRIORITIES,
  listTickets,
  getTicket,
  createTicket,
  updateTicket,
  deleteTicket,
  stats,
};
