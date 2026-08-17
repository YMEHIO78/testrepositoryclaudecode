// Google Calendar bridge.
//
// Purpose is narrow and specific: Calendly checks availability against
// calendars it is connected to, and can't read this app's .ics feed. So
// events created here are mirrored into a Google calendar that Calendly
// watches, which is what actually stops Calendly offering a slot you've
// already blocked.
//
// Only 'manual' events are pushed. Calendly-sourced events are excluded
// deliberately — Calendly already writes its own bookings into the
// connected Google calendar, so mirroring them would duplicate.
const { pool } = require('./db');
const { encryptJSON, decryptJSON } = require('./crypto');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';

// Least privilege: manage events, and read the calendar list so the
// target calendar can be picked. Not full calendar admin.
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function buildAuthUrl({ redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    // offline + consent is what actually returns a refresh token; without
    // both, a repeat authorisation silently omits it and the connection
    // dies at the first access-token expiry.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Google token request failed: ${data.error_description || data.error || res.status}`);
  }
  return data;
}

function exchangeCodeForToken({ code, redirectUri }) {
  return tokenRequest(new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  }));
}

function refreshAccessToken(refreshToken) {
  return tokenRequest(new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }));
}

// --- token storage ---

async function saveTokens(tokenResponse, { keepRefreshToken } = {}) {
  const existing = keepRefreshToken ? await loadTokens() : null;
  const payload = {
    access_token: tokenResponse.access_token,
    // A refresh grant response omits refresh_token; keep the stored one.
    refresh_token: tokenResponse.refresh_token || existing?.refresh_token,
    expires_at: Date.now() + (tokenResponse.expires_in || 3600) * 1000,
  };
  const { ciphertext, iv, authTag } = encryptJSON(payload);
  await pool.query(
    `INSERT INTO oauth_tokens (provider, account_label, encrypted_payload, iv, auth_tag, updated_at)
     VALUES ('google', 'default', $1, $2, $3, now())
     ON CONFLICT (provider, account_label)
     DO UPDATE SET encrypted_payload = $1, iv = $2, auth_tag = $3, updated_at = now()`,
    [ciphertext, iv, authTag],
  );
}

async function loadTokens() {
  const { rows } = await pool.query(
    `SELECT encrypted_payload, iv, auth_tag FROM oauth_tokens
      WHERE provider = 'google' AND account_label = 'default'`,
  );
  if (!rows.length) return null;
  const row = rows[0];
  return decryptJSON({ ciphertext: row.encrypted_payload, iv: row.iv, authTag: row.auth_tag });
}

async function getValidAccessToken() {
  const tokens = await loadTokens();
  if (!tokens) return null;
  if (tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
  if (!tokens.refresh_token) return null;
  const refreshed = await refreshAccessToken(tokens.refresh_token);
  await saveTokens(refreshed, { keepRefreshToken: true });
  return refreshed.access_token;
}

async function isConnected() {
  return !!(await loadTokens());
}

async function disconnect() {
  await pool.query(`DELETE FROM oauth_tokens WHERE provider = 'google'`);
  await pool.query(`DELETE FROM app_settings WHERE key = 'google_calendar_id'`);
  await pool.query(`UPDATE calendar_events SET google_event_id = NULL WHERE google_event_id IS NOT NULL`);
}

// --- target calendar ---

async function getTargetCalendarId() {
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = 'google_calendar_id'`);
  return rows.length ? rows[0].value : 'primary';
}

async function setTargetCalendarId(id) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('google_calendar_id', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [id],
  );
}

// --- API ---

async function api(path, { method = 'GET', body } = {}) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Google Calendar is not connected.');

  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google Calendar API ${res.status}: ${data.error?.message || '(no message)'}`);
  }
  return data;
}

async function listCalendars() {
  const data = await api('/users/me/calendarList?minAccessRole=writer');
  return (data.items || []).map((c) => ({
    id: c.id,
    summary: c.summary,
    primary: !!c.primary,
  }));
}

async function getAccountEmail() {
  const data = await api('/calendars/primary');
  return data.id;
}

// --- event mirroring ---

function toGoogleEvent(ev) {
  const body = {
    summary: ev.title,
    description: ev.notes || undefined,
    location: ev.location || undefined,
  };

  if (ev.allDay) {
    const start = new Date(ev.startsAt);
    const end = ev.endsAt ? new Date(ev.endsAt) : new Date(start.getTime() + 86400000);
    body.start = { date: start.toISOString().slice(0, 10) };
    body.end = { date: end.toISOString().slice(0, 10) };
  } else {
    const start = new Date(ev.startsAt);
    const end = ev.endsAt ? new Date(ev.endsAt) : new Date(start.getTime() + 3600000);
    body.start = { dateTime: start.toISOString() };
    body.end = { dateTime: end.toISOString() };
  }
  return body;
}

// Push one local event, creating or updating its Google counterpart.
// Returns the Google event id, or null if the bridge isn't connected.
async function pushEvent(ev) {
  if (!(await isConnected())) return null;
  if (ev.source !== 'manual') return null;

  const calendarId = encodeURIComponent(await getTargetCalendarId());
  const body = toGoogleEvent(ev);

  if (ev.googleEventId) {
    try {
      await api(`/calendars/${calendarId}/events/${encodeURIComponent(ev.googleEventId)}`, {
        method: 'PATCH',
        body,
      });
      return ev.googleEventId;
    } catch (err) {
      // Deleted on Google's side — fall through and recreate rather than
      // leaving the slot unblocked.
      if (!/ 40[34]:/.test(err.message)) throw err;
    }
  }

  const created = await api(`/calendars/${calendarId}/events`, { method: 'POST', body });
  return created.id;
}

async function deleteEvent(googleEventId) {
  if (!googleEventId || !(await isConnected())) return;
  const calendarId = encodeURIComponent(await getTargetCalendarId());
  try {
    await api(`/calendars/${calendarId}/events/${encodeURIComponent(googleEventId)}`, { method: 'DELETE' });
  } catch (err) {
    // Already gone is not a failure worth surfacing.
    if (!/ 40[34]:/.test(err.message)) throw err;
  }
}

// Push every manual event that isn't mirrored yet (or whose mirror is
// stale). Used after connecting, and as a manual "Sync now".
async function backfill() {
  if (!(await isConnected())) return { skipped: true, reason: 'not_connected' };

  const { rows } = await pool.query(
    `SELECT id, title, starts_at, ends_at, all_day, location, notes, source, google_event_id
       FROM calendar_events
      WHERE source = 'manual' AND starts_at > now() - interval '7 days'
      ORDER BY starts_at`,
  );

  let pushed = 0;
  const failures = [];
  for (const row of rows) {
    const ev = {
      id: row.id,
      title: row.title,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      allDay: row.all_day,
      location: row.location,
      notes: row.notes,
      source: row.source,
      googleEventId: row.google_event_id,
    };
    try {
      const googleId = await pushEvent(ev);
      if (googleId && googleId !== row.google_event_id) {
        await pool.query(`UPDATE calendar_events SET google_event_id = $2 WHERE id = $1`, [row.id, googleId]);
      }
      pushed++;
    } catch (err) {
      failures.push({ id: row.id, title: row.title, message: err.message });
    }
  }
  return { skipped: false, pushed, failures };
}

module.exports = {
  isConfigured,
  buildAuthUrl,
  exchangeCodeForToken,
  saveTokens,
  isConnected,
  disconnect,
  listCalendars,
  getAccountEmail,
  getTargetCalendarId,
  setTargetCalendarId,
  pushEvent,
  deleteEvent,
  backfill,
};
