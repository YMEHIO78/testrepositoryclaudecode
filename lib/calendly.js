// Calendly integration — pulls scheduled bookings into calendar_events
// so they show on the grid and in the .ics feed.
//
// One-directional by necessity: Calendly only checks availability against
// calendars it is itself connected to (Google/Outlook/iCloud/Exchange)
// and cannot subscribe to an .ics feed, so events created in this app
// can't block Calendly slots. Calendly owns its bookings; this app
// mirrors them read-only.
const { pool } = require('./db');
const { encryptJSON, decryptJSON } = require('./crypto');

// Required lazily inside the call rather than at module load: calendar
// does not import calendly, but scheduling imports calendar, and keeping
// this one indirect avoids adding another edge to that graph.
const calendarLink = (eventId, email) =>
  require('./calendar').linkByAttendeeEmail(eventId, email);

const API = 'https://api.calendly.com';

// --- token storage (reuses the oauth_tokens table) ---

async function saveToken(token) {
  const { ciphertext, iv, authTag } = encryptJSON({ token });
  await pool.query(
    `INSERT INTO oauth_tokens (provider, account_label, encrypted_payload, iv, auth_tag, updated_at)
     VALUES ('calendly', 'default', $1, $2, $3, now())
     ON CONFLICT (provider, account_label)
     DO UPDATE SET encrypted_payload = $1, iv = $2, auth_tag = $3, updated_at = now()`,
    [ciphertext, iv, authTag],
  );
}

async function getToken() {
  // An env var wins if set, so the token can be provisioned via Railway
  // without ever passing through the browser.
  if (process.env.CALENDLY_TOKEN) return process.env.CALENDLY_TOKEN;

  const { rows } = await pool.query(
    `SELECT encrypted_payload, iv, auth_tag FROM oauth_tokens
      WHERE provider = 'calendly' AND account_label = 'default'`,
  );
  if (!rows.length) return null;
  const row = rows[0];
  return decryptJSON({ ciphertext: row.encrypted_payload, iv: row.iv, authTag: row.auth_tag }).token;
}

async function deleteToken() {
  await pool.query(`DELETE FROM oauth_tokens WHERE provider = 'calendly'`);
  await pool.query(`DELETE FROM calendar_events WHERE source = 'calendly'`);
}

async function isConfigured() {
  return !!(await getToken());
}

// --- API ---

async function api(token, path) {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Calendly API ${res.status}: ${body.slice(0, 300) || '(no body)'}`);
  }
  return res.json();
}

async function getCurrentUser(token) {
  const data = await api(token, '/users/me');
  return data.resource; // { uri, name, email, ... }
}

// Calendly's `location` is a typed object; flatten it to something
// displayable without losing the join URL.
function describeLocation(location) {
  if (!location || typeof location !== 'object') return null;
  return location.join_url || location.location || location.type || null;
}

async function listScheduledEvents(token, userUri, { from, to }) {
  const events = [];
  let url = `/scheduled_events?user=${encodeURIComponent(userUri)}`
    + `&min_start_time=${encodeURIComponent(from.toISOString())}`
    + `&max_start_time=${encodeURIComponent(to.toISOString())}`
    + '&count=100';

  // Follow pagination, but stop at a sane ceiling so a huge history
  // can't spin here forever.
  for (let page = 0; url && page < 20; page++) {
    const data = await api(token, url);
    events.push(...(data.collection || []));
    const next = data.pagination?.next_page;
    url = next || null;
  }
  return events;
}

// The event's own `name` is the event-type name ("30 Minute Meeting"),
// which is not much use on a grid — the invitee is what identifies it.
// Best-effort: fall back to the plain name if this call fails.
//
// Returns both, because they serve different jobs: the name goes in the
// title where a human reads it, the emails are what attribute the meeting
// to a client. Taking only the name, as this used to, meant a Calendly
// booking could never be linked to anyone.
async function inviteesFor(token, eventUri) {
  try {
    const uuid = eventUri.split('/').pop();
    const data = await api(token, `/scheduled_events/${uuid}/invitees?count=10`);
    const live = (data.collection || []).filter((i) => i.status !== 'canceled');
    return {
      label: live.map((i) => i.name || i.email).filter(Boolean).join(', ') || null,
      emails: live.map((i) => i.email).filter(Boolean),
    };
  } catch (err) {
    return { label: null, emails: [] };
  }
}

// --- sync ---

async function sync({ daysBack = 30, daysAhead = 180 } = {}) {
  const token = await getToken();
  if (!token) return { skipped: true, reason: 'not_configured' };

  const user = await getCurrentUser(token);
  const now = new Date();
  const from = new Date(now.getTime() - daysBack * 86400000);
  const to = new Date(now.getTime() + daysAhead * 86400000);

  const remote = await listScheduledEvents(token, user.uri, { from, to });

  let upserted = 0;
  const activeIds = [];

  for (const ev of remote) {
    if (ev.status === 'canceled') continue;

    const invitees = await inviteesFor(token, ev.uri);
    const title = invitees.label ? `${ev.name} — ${invitees.label}` : ev.name;

    const { rows: eventRows } = await pool.query(
      `INSERT INTO calendar_events
         (title, starts_at, ends_at, all_day, location, notes, source, external_id, updated_at)
       VALUES ($1,$2,$3,false,$4,$5,'calendly',$6, now())
       ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET title = $1, starts_at = $2, ends_at = $3, location = $4, updated_at = now()
       RETURNING id`,
      [title, ev.start_time, ev.end_time, describeLocation(ev.location), 'Booked via Calendly', ev.uri],
    );

    // Attribute it to a client if an invitee's address is one of their
    // contacts. Runs on every sync rather than only on insert, so adding
    // the contact later still links the meetings already imported —
    // linkByAttendeeEmail only fills a client_id that is still null, so it
    // will not stamp over a correction made by hand.
    for (const email of invitees.emails) {
      const linked = await calendarLink(eventRows[0].id, email);
      if (linked) break;
    }

    activeIds.push(ev.uri);
    upserted++;
  }

  // Anything previously synced in this window that Calendly no longer
  // reports as active was cancelled or rescheduled out — drop it.
  const { rowCount: removed } = await pool.query(
    `DELETE FROM calendar_events
      WHERE source = 'calendly'
        AND starts_at >= $1 AND starts_at < $2
        AND NOT (external_id = ANY($3::text[]))`,
    [from.toISOString(), to.toISOString(), activeIds],
  );

  return { skipped: false, upserted, removed, account: user.email };
}

module.exports = {
  saveToken,
  getToken,
  deleteToken,
  isConfigured,
  getCurrentUser,
  sync,
};
