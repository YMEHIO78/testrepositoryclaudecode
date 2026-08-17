// Calendar events + iCalendar (.ics) feed generation.
//
// The feed exists because the app owns this calendar — there's no
// Exchange or CalDAV server behind it — so the way to get these events
// onto a phone or laptop is to publish a subscribe-able URL that
// Apple/Google/Outlook clients can poll. Those clients can't sign in
// through the app's session gate, so the URL carries a secret token
// instead and is served outside the gate.
const crypto = require('crypto');
const { pool } = require('./db');

async function listEvents({ from, to } = {}) {
  const clauses = [];
  const params = [];
  if (from) { params.push(from); clauses.push(`starts_at >= $${params.length}`); }
  if (to) { params.push(to); clauses.push(`starts_at < $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT id, title, starts_at, ends_at, all_day, location, notes, source
       FROM calendar_events ${where} ORDER BY starts_at`,
    params,
  );
  return rows.map(toEvent);
}

function toEvent(row) {
  return {
    id: row.id,
    title: row.title,
    startsAt: row.starts_at instanceof Date ? row.starts_at.toISOString() : row.starts_at,
    endsAt: row.ends_at instanceof Date ? row.ends_at.toISOString() : row.ends_at,
    allDay: row.all_day,
    location: row.location,
    notes: row.notes,
    source: row.source,
  };
}

async function createEvent({ title, startsAt, endsAt, allDay, location, notes }) {
  const { rows } = await pool.query(
    `INSERT INTO calendar_events (title, starts_at, ends_at, all_day, location, notes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [title, startsAt, endsAt || null, !!allDay, location || null, notes || null],
  );
  return toEvent(rows[0]);
}

// Events synced from elsewhere (Calendly today) are owned by that system
// — editing them here would just be undone by the next sync, so the API
// refuses rather than silently losing the change.
async function isEditable(id) {
  const { rows } = await pool.query(`SELECT source FROM calendar_events WHERE id = $1`, [id]);
  if (!rows.length) return { exists: false };
  return { exists: true, editable: rows[0].source === 'manual', source: rows[0].source };
}

async function updateEvent(id, { title, startsAt, endsAt, allDay, location, notes }) {
  const { rows } = await pool.query(
    `UPDATE calendar_events SET
       title = COALESCE($2, title),
       starts_at = COALESCE($3, starts_at),
       ends_at = $4,
       all_day = COALESCE($5, all_day),
       location = $6,
       notes = $7,
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, title ?? null, startsAt ?? null, endsAt || null, allDay ?? null, location || null, notes || null],
  );
  return rows.length ? toEvent(rows[0]) : null;
}

async function deleteEvent(id) {
  const { rowCount } = await pool.query(`DELETE FROM calendar_events WHERE id = $1`, [id]);
  return rowCount > 0;
}

// --- feed token ---

async function getFeedToken() {
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = 'calendar_feed_token'`);
  if (rows.length) return rows[0].value;
  return rotateFeedToken();
}

async function rotateFeedToken() {
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('calendar_feed_token', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [token],
  );
  return token;
}

// Constant-time compare so the token can't be guessed byte-by-byte.
async function feedTokenMatches(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const actual = await getFeedToken();
  const a = Buffer.from(candidate);
  const b = Buffer.from(actual);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --- .ics generation ---

function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function dateStamp(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

// RFC 5545 caps lines at 75 octets; continuations start with a space.
function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const chunks = [];
  let offset = 0;
  let limit = 75;
  while (offset < bytes.length) {
    chunks.push(bytes.subarray(offset, offset + limit).toString('utf8'));
    offset += limit;
    limit = 74; // continuation lines lose one octet to the leading space
  }
  return chunks.join('\r\n ');
}

function toICS(events, { name = 'Pocket Data Office' } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Pocket Data Office//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    'X-PUBLISHED-TTL:PT30M',
  ];

  const now = utcStamp(new Date());

  for (const ev of events) {
    const start = new Date(ev.startsAt);
    if (isNaN(start)) continue;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:pdo-${ev.id}@pocket-data-office`);
    lines.push(`DTSTAMP:${now}`);

    if (ev.allDay) {
      // All-day DTEND is exclusive, so add a day.
      const end = ev.endsAt ? new Date(ev.endsAt) : new Date(start.getTime() + 86400000);
      lines.push(`DTSTART;VALUE=DATE:${dateStamp(start)}`);
      lines.push(`DTEND;VALUE=DATE:${dateStamp(end)}`);
    } else {
      const end = ev.endsAt ? new Date(ev.endsAt) : new Date(start.getTime() + 3600000);
      lines.push(`DTSTART:${utcStamp(start)}`);
      lines.push(`DTEND:${utcStamp(end)}`);
    }

    lines.push(`SUMMARY:${escapeText(ev.title)}`);
    if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
    if (ev.notes) lines.push(`DESCRIPTION:${escapeText(ev.notes)}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

module.exports = {
  listEvents,
  createEvent,
  isEditable,
  updateEvent,
  deleteEvent,
  getFeedToken,
  rotateFeedToken,
  feedTokenMatches,
  toICS,
};
