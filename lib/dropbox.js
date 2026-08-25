// Dropbox as the file store.
//
// Same shape as lib/google.js and the OneDrive attempt before it: OAuth
// code exchange, a refresh token encrypted into oauth_tokens, one helper
// that every call goes through.
//
// Two things make this materially better than the OneDrive route it
// replaces, and both are worth knowing before anyone is tempted to
// "improve" it back:
//
//   - **Refresh tokens do not expire.** Microsoft's lapse after long
//     inactivity, which meant files could silently become unreachable.
//     Dropbox's keep working until revoked.
//   - **App folder access.** The app is registered against a folder, not
//     the account, so this code physically cannot see anything in
//     Dropbox outside /Apps/Pocket Data Office. That is enforced by
//     Dropbox rather than by us remembering to scope a path.
const { pool } = require('./db');
const { encryptJSON, decryptJSON } = require('./crypto');

const AUTHORIZE = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN = 'https://api.dropboxapi.com/oauth2/token';
const RPC = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

function isConfigured() {
  return !!(process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET);
}

function buildAuthUrl({ redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: process.env.DROPBOX_APP_KEY,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
    // Without this Dropbox returns a four-hour access token and no
    // refresh token, and the connection dies the same afternoon.
    token_access_type: 'offline',
  });
  return `${AUTHORIZE}?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.DROPBOX_APP_KEY,
      client_secret: process.env.DROPBOX_APP_SECRET,
      ...body,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error_summary || data.error || `Token request failed (${res.status})`);
  }
  return data;
}

function exchangeCodeForToken({ code, redirectUri }) {
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
}

function refreshAccessToken(refreshToken) {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

async function saveTokens(tokenResponse, { keepRefreshToken } = {}) {
  const existing = keepRefreshToken ? await loadTokens() : null;
  const payload = {
    access_token: tokenResponse.access_token,
    // A refresh grant returns no refresh_token; keep the stored one.
    refresh_token: tokenResponse.refresh_token || existing?.refresh_token,
    expires_at: Date.now() + (tokenResponse.expires_in || 14400) * 1000,
  };
  const { ciphertext, iv, authTag } = encryptJSON(payload);
  await pool.query(
    `INSERT INTO oauth_tokens (provider, account_label, encrypted_payload, iv, auth_tag, updated_at)
     VALUES ('dropbox', 'default', $1, $2, $3, now())
     ON CONFLICT (provider, account_label)
     DO UPDATE SET encrypted_payload = $1, iv = $2, auth_tag = $3, updated_at = now()`,
    [ciphertext, iv, authTag],
  );
}

async function loadTokens() {
  const { rows } = await pool.query(
    `SELECT encrypted_payload, iv, auth_tag FROM oauth_tokens
      WHERE provider = 'dropbox' AND account_label = 'default'`,
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
  await pool.query(`DELETE FROM oauth_tokens WHERE provider = 'dropbox'`);
}

// Dropbox reports failures as JSON in an error_summary string; surfacing
// that verbatim is far more use than "request failed".
async function fail(res) {
  const text = await res.text().catch(() => '');
  let summary = text;
  try { summary = JSON.parse(text).error_summary || text; } catch (err) { /* not JSON */ }
  throw new Error(`Dropbox ${res.status}: ${summary || '(no message)'}`);
}

async function rpc(path, body) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Dropbox is not connected.');

  const res = await fetch(`${RPC}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === null ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) await fail(res);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// The Dropbox-API-Arg header must be ASCII. A filename with an accent or
// a curly quote would otherwise produce an invalid header and a baffling
// 400, so non-ASCII is escaped to \uXXXX — which Dropbox unescapes.
function apiArg(value) {
  return JSON.stringify(value).replace(/[-￿]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// Files here are capped at 25MB and Dropbox's simple upload handles
// 150MB, so there is no session/chunking path to get wrong.
async function upload(relPath, buffer, contentType) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Dropbox is not connected.');

  const res = await fetch(`${CONTENT}/files/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': apiArg({
        path: `/${String(relPath).replace(/^\/+/, '')}`,
        mode: 'add',
        // Rather than overwrite: two files uploaded under the same name
        // should both survive, and the id is what we store anyway.
        autorename: true,
        mute: true,
      }),
    },
    body: buffer,
  });
  if (!res.ok) await fail(res);
  return res.json();
}

// Addressed by id rather than path, so a file someone renames or moves
// inside Dropbox keeps working here.
async function download(fileId) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Dropbox is not connected.');

  const res = await fetch(`${CONTENT}/files/download`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': apiArg({ path: fileId }),
    },
  });
  if (!res.ok) await fail(res);
  return Buffer.from(await res.arrayBuffer());
}

// Overwrites in place, keeping the id. Dropbox keeps the previous copy
// in its own version history, which the bucket cannot do at all.
async function overwrite(fileId, buffer, contentType) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Dropbox is not connected.');

  const res = await fetch(`${CONTENT}/files/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': apiArg({ path: fileId, mode: 'overwrite', mute: true }),
    },
    body: buffer,
  });
  if (!res.ok) await fail(res);
  return res.json();
}

async function remove(fileId) {
  try {
    await rpc('/files/delete_v2', { path: fileId });
    return true;
  } catch (err) {
    // Already gone is the state we wanted.
    if (/not_found/.test(err.message)) return true;
    throw err;
  }
}

async function status() {
  if (!isConfigured()) return { configured: false, connected: false };
  if (!(await isConnected())) return { configured: true, connected: false };

  try {
    const account = await rpc('/users/get_current_account', null);
    const space = await rpc('/users/get_space_usage', null);
    return {
      configured: true,
      connected: true,
      account: account?.email || account?.name?.display_name || null,
      usedBytes: space?.used ?? null,
      totalBytes: space?.allocation?.allocated ?? null,
    };
  } catch (err) {
    return { configured: true, connected: true, error: err.message };
  }
}

module.exports = {
  isConfigured, buildAuthUrl, exchangeCodeForToken, saveTokens,
  isConnected, disconnect, getValidAccessToken,
  upload, download, overwrite, remove, status, apiArg,
};
