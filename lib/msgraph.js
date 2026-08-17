// Microsoft Graph mail integration — OAuth2 authorization-code flow
// (delegated permissions: Mail.Read, Mail.Send, offline_access) plus
// encrypted token storage/refresh. One row in oauth_tokens per connected
// mailbox (see lib/migrate.js).
const { pool } = require('./db');
const { encryptJSON, decryptJSON } = require('./crypto');

const SCOPES = ['Mail.Read', 'Mail.Send', 'offline_access', 'User.Read'].join(' ');

function authority() {
  return `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}`;
}

function buildAuthorizeUrl({ redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state,
  });
  return `${authority()}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function tokenRequest(body) {
  const res = await fetch(`${authority()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Microsoft token request failed: ${data.error_description || data.error || res.status}`);
  }
  return data; // { access_token, refresh_token, expires_in, ... }
}

function exchangeCodeForToken({ code, redirectUri }) {
  return tokenRequest(new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    scope: SCOPES,
  }));
}

function refreshAccessToken(refreshToken) {
  return tokenRequest(new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPES,
  }));
}

async function saveTokens(accountLabel, tokenResponse) {
  const payload = {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    expires_at: Date.now() + tokenResponse.expires_in * 1000,
  };
  const { ciphertext, iv, authTag } = encryptJSON(payload);
  await pool.query(
    `INSERT INTO oauth_tokens (provider, account_label, encrypted_payload, iv, auth_tag, updated_at)
     VALUES ('microsoft', $1, $2, $3, $4, now())
     ON CONFLICT (provider, account_label)
     DO UPDATE SET encrypted_payload = $2, iv = $3, auth_tag = $4, updated_at = now()`,
    [accountLabel, ciphertext, iv, authTag],
  );
}

async function loadTokens(accountLabel) {
  const { rows } = await pool.query(
    `SELECT encrypted_payload, iv, auth_tag FROM oauth_tokens WHERE provider = 'microsoft' AND account_label = $1`,
    [accountLabel],
  );
  if (!rows.length) return null;
  const row = rows[0];
  return decryptJSON({ ciphertext: row.encrypted_payload, iv: row.iv, authTag: row.auth_tag });
}

async function getValidAccessToken(accountLabel) {
  const tokens = await loadTokens(accountLabel);
  if (!tokens) return null;
  if (tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
  const refreshed = await refreshAccessToken(tokens.refresh_token);
  await saveTokens(accountLabel, refreshed);
  return refreshed.access_token;
}

async function disconnectAccount(accountLabel) {
  await pool.query(
    `DELETE FROM oauth_tokens WHERE provider = 'microsoft' AND account_label = $1`,
    [accountLabel],
  );
}

async function listConnectedAccounts() {
  const { rows } = await pool.query(
    `SELECT account_label FROM oauth_tokens WHERE provider = 'microsoft' ORDER BY account_label`,
  );
  return rows.map((r) => r.account_label);
}

async function graphFetch(accessToken, path, options = {}) {
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('Graph call attempted without an access token.');
  }

  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    // Graph puts the useful reason for a 401 in WWW-Authenticate
    // (expired token, wrong audience, missing scope) and often returns
    // an empty body, so read both.
    const text = await res.text().catch(() => '');
    const challenge = res.headers.get('www-authenticate') || '';
    const detail = [text, challenge].filter(Boolean).join(' | ') || '(no detail returned)';
    throw new Error(`Graph API error ${res.status}: ${detail}`);
  }
  if (res.status === 202 || res.status === 204) return null;
  return res.json();
}

// Which account did the user actually sign in as? Used to confirm the
// mailbox they clicked "Connect" on is the one they authenticated with.
async function getSignedInUser(accessToken) {
  return graphFetch(accessToken, '/me?$select=mail,userPrincipalName');
}

async function listMessages(accessToken, { top = 25 } = {}) {
  const params = new URLSearchParams({
    $top: String(top),
    $orderby: 'receivedDateTime desc',
    $select: 'id,subject,from,receivedDateTime,bodyPreview,isRead,webLink',
  });
  const data = await graphFetch(accessToken, `/me/mailFolders/inbox/messages?${params.toString()}`);
  return data.value;
}

function sendReply(accessToken, messageId, comment) {
  return graphFetch(accessToken, `/me/messages/${encodeURIComponent(messageId)}/reply`, {
    method: 'POST',
    body: JSON.stringify({ comment }),
  });
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  saveTokens,
  getValidAccessToken,
  getSignedInUser,
  disconnectAccount,
  listConnectedAccounts,
  listMessages,
  sendReply,
};
