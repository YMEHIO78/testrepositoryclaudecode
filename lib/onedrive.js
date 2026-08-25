// OneDrive as a file store, via Microsoft Graph.
//
// Deliberately built to the same shape as lib/google.js: OAuth code
// exchange, a refresh token encrypted into oauth_tokens, and one `graph`
// helper that every call goes through. A second, differently-shaped
// OAuth implementation in the same app would be one to get wrong twice.
//
// This is a *personal* Microsoft account (the domain's mail is on
// Hostinger, so there is no tenant to host a work account). Two things
// follow from that and neither can be worked around:
//
//   - Only delegated permissions exist. App-only credentials need a
//     tenant, so there is no way to run this without a human having
//     consented once.
//   - The refresh token expires after long inactivity, unlike the
//     bucket's static keys. If it lapses, files become unreachable
//     until someone reconnects — which is why the bucket stays as a
//     fallback rather than being ripped out.
const { pool } = require('./db');
const { encryptJSON, decryptJSON } = require('./crypto');

const AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';

// offline_access is what yields a refresh token at all; without it this
// works for exactly one hour and then stops.
const SCOPES = ['offline_access', 'User.Read', 'Files.ReadWrite'].join(' ');

function isConfigured() {
  return !!(process.env.ONEDRIVE_CLIENT_ID && process.env.ONEDRIVE_CLIENT_SECRET);
}

function buildAuthUrl({ redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: process.env.ONEDRIVE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state,
  });
  return `${AUTH}/authorize?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch(`${AUTH}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.ONEDRIVE_CLIENT_ID,
      client_secret: process.env.ONEDRIVE_CLIENT_SECRET,
      ...body,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Microsoft puts the useful part in error_description; error alone is
    // usually just "invalid_grant".
    throw new Error(data.error_description || data.error || `Token request failed (${res.status})`);
  }
  return data;
}

function exchangeCodeForToken({ code, redirectUri }) {
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, scope: SCOPES });
}

function refreshAccessToken(refreshToken) {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, scope: SCOPES });
}

async function saveTokens(tokenResponse, { keepRefreshToken } = {}) {
  const existing = keepRefreshToken ? await loadTokens() : null;
  const payload = {
    access_token: tokenResponse.access_token,
    // Microsoft rotates the refresh token on most refreshes, but not
    // always; keep the old one when none comes back.
    refresh_token: tokenResponse.refresh_token || existing?.refresh_token,
    expires_at: Date.now() + (tokenResponse.expires_in || 3600) * 1000,
  };
  const { ciphertext, iv, authTag } = encryptJSON(payload);
  await pool.query(
    `INSERT INTO oauth_tokens (provider, account_label, encrypted_payload, iv, auth_tag, updated_at)
     VALUES ('onedrive', 'default', $1, $2, $3, now())
     ON CONFLICT (provider, account_label)
     DO UPDATE SET encrypted_payload = $1, iv = $2, auth_tag = $3, updated_at = now()`,
    [ciphertext, iv, authTag],
  );
}

async function loadTokens() {
  const { rows } = await pool.query(
    `SELECT encrypted_payload, iv, auth_tag FROM oauth_tokens
      WHERE provider = 'onedrive' AND account_label = 'default'`,
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
  await pool.query(`DELETE FROM oauth_tokens WHERE provider = 'onedrive'`);
}

async function graph(path, { method = 'GET', body, raw, contentType } = {}) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('OneDrive is not connected.');

  const res = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(raw ? { 'Content-Type': contentType || 'application/octet-stream' }
        : body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(raw ? { body: raw } : body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 204) return null;
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Graph ${res.status}: ${data.error?.message || '(no message)'}`);
  }
  return res.json();
}

// --- files ---

// Everything this app writes lives under one folder, so the drive stays
// legible to a human and so nothing here can collide with whatever else
// is in the account.
const ROOT = process.env.ONEDRIVE_FOLDER || 'Pocket Data Office';

// Graph addresses items by path with a colon delimiter, and the path
// segments have to be encoded individually — encodeURIComponent on the
// whole thing would eat the slashes.
function pathUrl(relPath) {
  const encoded = String(relPath).split('/').filter(Boolean)
    .map(encodeURIComponent).join('/');
  return `/me/drive/root:/${encodeURIComponent(ROOT)}/${encoded}`;
}

// Uploads under 4MB can go in one PUT. Larger ones need an upload
// session, which is a different dance — files.MAX_BYTES is 25MB, so this
// has to handle both.
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;

async function upload(relPath, buffer, contentType) {
  if (buffer.length <= SIMPLE_UPLOAD_LIMIT) {
    return graph(`${pathUrl(relPath)}:/content`, {
      method: 'PUT', raw: buffer, contentType,
    });
  }

  // Large file: create a session, then send the bytes in chunks. The
  // session URL is pre-authorised, so these PUTs carry no bearer token.
  const session = await graph(`${pathUrl(relPath)}:/createUploadSession`, {
    method: 'POST',
    body: { item: { '@microsoft.graph.conflictBehavior': 'replace' } },
  });

  const CHUNK = 5 * 320 * 1024; // Graph requires a multiple of 320KB.
  let last = null;
  for (let start = 0; start < buffer.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, buffer.length);
    const slice = buffer.subarray(start, end);
    const res = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(slice.length),
        'Content-Range': `bytes ${start}-${end - 1}/${buffer.length}`,
      },
      body: slice,
    });
    if (!res.ok) {
      throw new Error(`Upload failed at ${start}-${end - 1}: ${res.status}`);
    }
    // The final chunk returns the finished DriveItem; the rest return 202.
    if (res.status === 200 || res.status === 201) last = await res.json();
  }
  if (!last) throw new Error('Upload finished without a confirmation from OneDrive.');
  return last;
}

async function download(itemId) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('OneDrive is not connected.');

  const res = await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}/content`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Could not download from OneDrive (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

async function remove(itemId) {
  try {
    await graph(`/me/drive/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
    return true;
  } catch (err) {
    // A file already gone is the state we wanted. Anything else is real.
    if (/Graph 404/.test(err.message)) return true;
    throw err;
  }
}

// Who is connected, and how full the drive is. Surfaced in Integrations
// so a drive filling up is visible before an upload starts failing.
async function status() {
  if (!isConfigured()) return { configured: false, connected: false };
  if (!(await isConnected())) return { configured: true, connected: false };

  try {
    const me = await graph('/me');
    const drive = await graph('/me/drive');
    const quota = drive.quota || {};
    return {
      configured: true,
      connected: true,
      account: me.userPrincipalName || me.mail || me.displayName || null,
      folder: ROOT,
      usedBytes: quota.used ?? null,
      totalBytes: quota.total ?? null,
    };
  } catch (err) {
    return { configured: true, connected: true, error: err.message };
  }
}

module.exports = {
  isConfigured, buildAuthUrl, exchangeCodeForToken, saveTokens,
  isConnected, disconnect, getValidAccessToken, graph,
  upload, download, remove, status, ROOT,
};
