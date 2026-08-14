// Static front-end server for Railway, with a session-based login gate
// in front of everything. Swap the /public mockup out for real routes as
// you wire up Outlook, Outlook Calendar, and Wave.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');
const { pool } = require('./lib/db');
const { migrate } = require('./lib/migrate');
const msgraph = require('./lib/msgraph');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway terminates TLS at its edge and always sets X-Forwarded-Proto:
// https (see their networking docs). Trusting it is what makes
// `req.secure` — and therefore the session cookie's `secure` flag —
// true here, even though the connection reaching this process is plain
// HTTP. This is separate from client-IP resolution, which the rate
// limiter below handles itself via X-Real-IP rather than req.ip.
app.set('trust proxy', true);

app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  name: 'pdo.sid',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000, // 12h idle timeout, renewed on activity
  },
}));

app.use(express.urlencoded({ extended: false }));

// Throttle repeated failed logins per IP to make password brute-forcing
// impractical. Successful logins don't count against the limit.
//
// Railway's edge sets X-Real-IP to the actual client IP (their proxy
// chain doesn't give a fixed-depth X-Forwarded-For, so Express's
// built-in `trust proxy` hop-counting resolves the wrong address here —
// see https://docs.railway.com/networking/public-networking/specs-and-limits).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => req.headers['x-real-ip'] || req.socket.remoteAddress,
  handler: (req, res) => res.redirect('/login?error=rate_limited'),
});

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

app.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/login', loginLimiter, (req, res) => {
  const user = process.env.AUTH_USER;
  const pass = process.env.AUTH_PASS;
  const { username, password } = req.body || {};

  if (
    user && pass && username && password &&
    timingSafeEqual(username, user) && timingSafeEqual(password, pass)
  ) {
    req.session.regenerate((err) => {
      if (err) return res.redirect('/login?error=invalid');
      req.session.authenticated = true;
      res.redirect('/');
    });
    return;
  }

  res.redirect('/login?error=invalid');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('pdo.sid');
    res.redirect('/login');
  });
});

app.use((req, res, next) => {
  if (req.session.authenticated) return next();
  res.redirect('/login');
});

// --- Outlook mail (Microsoft Graph) ---
// MS_MAILBOXES is a comma-separated allowlist of the mailboxes this app
// is permitted to connect — /auth/microsoft/start only accepts an
// `account` value that appears in it, so the OAuth flow can't be aimed
// at an arbitrary mailbox.
function configuredMailboxes() {
  return (process.env.MS_MAILBOXES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function redirectUriFor(req) {
  return `${req.protocol}://${req.get('host')}/auth/microsoft/callback`;
}

app.get('/auth/microsoft/start', (req, res) => {
  const account = req.query.account;
  if (!configuredMailboxes().includes(account)) {
    return res.status(400).send('Unknown mailbox.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.msOAuthState = { value: state, account };
  const url = msgraph.buildAuthorizeUrl({ redirectUri: redirectUriFor(req), state });
  res.redirect(url);
});

app.get('/auth/microsoft/callback', async (req, res) => {
  const pending = req.session.msOAuthState;
  delete req.session.msOAuthState;

  if (req.query.error) {
    return res.redirect(`/?mailError=${encodeURIComponent(req.query.error)}`);
  }
  if (!pending || !req.query.state || req.query.state !== pending.value) {
    return res.redirect('/?mailError=invalid_state');
  }

  try {
    const tokens = await msgraph.exchangeCodeForToken({
      code: req.query.code,
      redirectUri: redirectUriFor(req),
    });
    await msgraph.saveTokens(pending.account, tokens);
    res.redirect(`/?connected=${encodeURIComponent(pending.account)}`);
  } catch (err) {
    console.error('Microsoft OAuth callback failed:', err);
    res.redirect('/?mailError=token_exchange_failed');
  }
});

app.get('/api/mailboxes', async (req, res) => {
  const connected = new Set(await msgraph.listConnectedAccounts());
  res.json(configuredMailboxes().map((email) => ({ email, connected: connected.has(email) })));
});

app.post('/api/mailboxes/disconnect', express.json(), async (req, res) => {
  const { email } = req.body || {};
  if (!configuredMailboxes().includes(email)) {
    return res.status(400).json({ error: 'Unknown mailbox.' });
  }
  await msgraph.disconnectAccount(email);
  res.status(204).end();
});

app.get('/api/inbox', async (req, res) => {
  try {
    const accounts = (await msgraph.listConnectedAccounts())
      .filter((a) => configuredMailboxes().includes(a));

    const perAccount = await Promise.all(accounts.map(async (account) => {
      const accessToken = await msgraph.getValidAccessToken(account);
      if (!accessToken) return [];
      const messages = await msgraph.listMessages(accessToken, { top: 25 });
      return messages.map((m) => ({
        id: m.id,
        account,
        subject: m.subject,
        from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'Unknown sender',
        receivedDateTime: m.receivedDateTime,
        preview: m.bodyPreview,
        isRead: m.isRead,
        webLink: m.webLink,
      }));
    }));

    const messages = perAccount.flat().sort((a, b) =>
      new Date(b.receivedDateTime) - new Date(a.receivedDateTime));
    res.json({ accounts, messages });
  } catch (err) {
    console.error('Failed to load inbox:', err);
    res.status(502).json({ error: 'Failed to load mail from Microsoft Graph.' });
  }
});

app.post('/api/inbox/reply', express.json(), async (req, res) => {
  const { account, messageId, comment } = req.body || {};
  if (!configuredMailboxes().includes(account) || !messageId || !comment) {
    return res.status(400).json({ error: 'account, messageId, and comment are required.' });
  }
  try {
    const accessToken = await msgraph.getValidAccessToken(account);
    if (!accessToken) return res.status(409).json({ error: 'That mailbox is not connected.' });
    await msgraph.sendReply(accessToken, messageId, comment);
    res.status(204).end();
  } catch (err) {
    console.error('Failed to send reply:', err);
    res.status(502).json({ error: 'Failed to send reply via Microsoft Graph.' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

migrate()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  })
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Pocket Data Office listening on port ${PORT}`);
    });
  });
