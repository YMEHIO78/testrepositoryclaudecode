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
const mail = require('./lib/mail');

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

// --- Mail (IMAP read / SMTP send) ---
// MAILBOXES is a comma-separated allowlist of addresses this app may
// connect. Credentials are entered per mailbox and stored encrypted.
function configuredMailboxes() {
  return (process.env.MAILBOXES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

app.get('/api/mailboxes', async (req, res) => {
  const connected = new Set(await mail.listAccounts());
  res.json({
    defaults: mail.defaults(),
    mailboxes: configuredMailboxes().map((email) => ({ email, connected: connected.has(email) })),
  });
});

app.post('/api/mailboxes/connect', express.json(), async (req, res) => {
  const { email, username, password, imapHost, imapPort, smtpHost, smtpPort } = req.body || {};
  if (!configuredMailboxes().includes(email)) {
    return res.status(400).json({ error: 'Unknown mailbox.' });
  }
  if (!password) {
    return res.status(400).json({ error: 'A password is required.' });
  }

  const candidate = {
    email,
    username: username || email,
    password,
    imapHost: imapHost || mail.defaults().imapHost,
    imapPort: Number(imapPort) || mail.defaults().imapPort,
    smtpHost: smtpHost || mail.defaults().smtpHost,
    smtpPort: Number(smtpPort) || mail.defaults().smtpPort,
  };

  // Validate before storing, so a bad password fails here rather than
  // silently producing an empty inbox later.
  const check = await mail.verifyCredentials(candidate);
  if (!check.ok) {
    return res.status(400).json({ error: `Could not sign in to that mailbox: ${check.message}` });
  }

  await mail.saveAccount(email, candidate);
  res.status(204).end();
});

app.post('/api/mailboxes/disconnect', express.json(), async (req, res) => {
  const { email } = req.body || {};
  if (!configuredMailboxes().includes(email)) {
    return res.status(400).json({ error: 'Unknown mailbox.' });
  }
  await mail.deleteAccount(email);
  res.status(204).end();
});

app.get('/api/inbox', async (req, res) => {
  try {
    const accounts = (await mail.listAccounts())
      .filter((a) => configuredMailboxes().includes(a));

    // Per-account isolation: one mailbox failing (wrong password, server
    // down) shouldn't blank out the others.
    const errors = [];
    const perAccount = await Promise.all(accounts.map(async (account) => {
      try {
        return await mail.fetchMessages(account, { limit: 25 });
      } catch (err) {
        console.error(`Failed to load mail for ${account}:`, err);
        errors.push({ account, message: err.message });
        return [];
      }
    }));

    const messages = perAccount.flat().sort((a, b) =>
      new Date(b.receivedDateTime || 0) - new Date(a.receivedDateTime || 0));
    res.json({ accounts, messages, errors });
  } catch (err) {
    console.error('Failed to load inbox:', err);
    res.status(502).json({ error: 'Failed to load mail.' });
  }
});

app.post('/api/inbox/reply', express.json(), async (req, res) => {
  const { account, to, subject, messageId, comment } = req.body || {};
  if (!configuredMailboxes().includes(account) || !to || !comment) {
    return res.status(400).json({ error: 'account, to, and comment are required.' });
  }
  try {
    await mail.sendReply(account, { to, subject, body: comment, inReplyTo: messageId });
    res.status(204).end();
  } catch (err) {
    console.error('Failed to send reply:', err);
    res.status(502).json({ error: `Failed to send reply: ${err.message}` });
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
