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
const calendar = require('./lib/calendar');
const calendly = require('./lib/calendly');
const google = require('./lib/google');
const scheduling = require('./lib/scheduling');
const crm = require('./lib/crm');
const tickets = require('./lib/tickets');
const wave = require('./lib/wave');
const projects = require('./lib/projects');
const people = require('./lib/people');
const files = require('./lib/files');
const folders = require('./lib/folders');
const packages = require('./lib/packages');
const search = require('./lib/search');

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

// Public .ics subscription feed — deliberately outside the login gate,
// because Apple/Google/Outlook calendar clients poll this URL and can't
// authenticate through a session. The secret token in the path is what
// protects it, so treat that URL as a credential.
app.get('/calendar/:token/pocket-data-office.ics', async (req, res) => {
  try {
    if (!(await calendar.feedTokenMatches(req.params.token))) {
      return res.status(404).send('Not found.');
    }
    const events = await calendar.listEvents();
    res.type('text/calendar; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(calendar.toICS(events));
  } catch (err) {
    console.error('Failed to build calendar feed:', err);
    res.status(500).send('Could not build calendar feed.');
  }
});

// Public booking pages and their API — outside the login gate by
// design, since the people booking are clients, not app users. Slot
// availability is computed against calendar_events, so anything already
// on the calendar is never offered.
app.get('/book/cancel/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'cancel.html'));
});

app.get('/book/:slug', async (req, res) => {
  const type = await scheduling.getEventTypeBySlug(req.params.slug);
  if (!type || !type.active) return res.status(404).send('That booking page was not found.');
  res.sendFile(path.join(__dirname, 'views', 'book.html'));
});

app.get('/api/book/:slug/slots', async (req, res) => {
  try {
    const type = await scheduling.getEventTypeBySlug(req.params.slug);
    if (!type || !type.active) return res.status(404).json({ error: 'That booking page was not found.' });
    const { timezone, slots } = await scheduling.availableSlots(type, {
      from: req.query.from,
      to: req.query.to,
    });
    res.json({ eventType: type, timezone, slots });
  } catch (err) {
    console.error('Failed to compute slots:', err);
    res.status(500).json({ error: 'Could not load available times.' });
  }
});

// Rate-limited: this endpoint is public and writes to the calendar, so
// it's the obvious target for someone spamming bookings.
const bookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-real-ip'] || req.socket.remoteAddress,
  message: { error: 'Too many booking attempts. Please try again later.' },
});

app.post('/api/book/:slug', bookingLimiter, express.json(), async (req, res) => {
  const { startsAt, name, email, notes } = req.body || {};
  if (!startsAt || !name || !email) {
    return res.status(400).json({ error: 'Name, email, and a time are required.' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'That email address does not look valid.' });
  }

  try {
    const type = await scheduling.getEventTypeBySlug(req.params.slug);
    if (!type || !type.active) return res.status(404).json({ error: 'That booking page was not found.' });

    const booking = await scheduling.createBooking(type, { startsAt, name, email, notes });
    const cancelUrl = `${req.protocol}://${req.get('host')}/book/cancel/${booking.cancelToken}`;

    // Respond as soon as the booking is committed. Sending mail can take
    // many seconds (or stall on an unreachable SMTP host), and making the
    // visitor wait on it risks them assuming it failed and rebooking.
    res.status(201).json({ startsAt: booking.startsAt, endsAt: booking.endsAt, cancelUrl });

    // Confirmations then go out in the background. A failure here is
    // logged, not surfaced — the booking itself already succeeded.
    (async () => {
      try {
        const tz = await scheduling.getTimezone();
        const when = new Date(booking.startsAt).toLocaleString('en-US', {
          timeZone: tz, weekday: 'long', month: 'long', day: 'numeric',
          hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
        });

        await mail.sendMail({
          to: email,
          subject: `Confirmed: ${type.name}`,
          text: [
            `Hi ${name},`, '',
            `Your ${type.name} is confirmed for:`,
            `  ${when}`,
            type.location ? `  ${type.location}` : '',
            '', `Need to cancel? ${cancelUrl}`,
            '', 'Pocket Data Office',
          ].filter(Boolean).join('\n'),
        });

        const owner = (await mail.listAccounts())[0];
        if (owner) {
          await mail.sendMail({
            to: owner,
            replyTo: email,
            subject: `New booking: ${type.name} — ${name}`,
            text: [
              `${name} <${email}> booked ${type.name}.`, '',
              `When: ${when}`,
              notes ? `Notes: ${notes}` : '',
            ].filter(Boolean).join('\n'),
          });
        }
      } catch (err) {
        console.error('Booking confirmation email failed:', err.message);
      }
    })();
    return;
  } catch (err) {
    // Slot-taken is an expected race, not a server fault.
    const taken = /taken|not available|no longer/i.test(err.message);
    if (!taken) console.error('Booking failed:', err);
    res.status(taken ? 409 : 500).json({ error: taken ? err.message : 'Could not complete the booking.' });
  }
});

app.get('/api/book/cancel/:token', async (req, res) => {
  const booking = await scheduling.getBookingByToken(req.params.token);
  if (!booking) return res.status(404).json({ error: 'Not found.' });
  res.json({
    startsAt: booking.startsAt,
    eventTypeName: booking.eventTypeName,
    canceledAt: booking.canceledAt,
  });
});

app.post('/api/book/cancel/:token', async (req, res) => {
  try {
    const booking = await scheduling.cancelBooking(req.params.token);
    if (!booking) return res.status(404).json({ error: 'Not found.' });
    res.status(204).end();
  } catch (err) {
    console.error('Cancellation failed:', err);
    res.status(500).json({ error: 'Could not cancel.' });
  }
});

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
  const page = Math.max(0, Number(req.query.page) || 0);
  const search = (req.query.q || '').toString().trim();

  try {
    const accounts = (await mail.listAccounts())
      .filter((a) => configuredMailboxes().includes(a));

    // Per-account isolation: one mailbox failing (wrong password, server
    // down) shouldn't blank out the others.
    const errors = [];
    const counts = {};
    let hasMore = false;

    const perAccount = await Promise.all(accounts.map(async (account) => {
      try {
        const result = await mail.fetchMessages(account, { limit: 25, page, search });
        counts[account] = { total: result.total, unseen: result.unseen };
        if (result.hasMore) hasMore = true;
        return result.messages;
      } catch (err) {
        console.error(`Failed to load mail for ${account}:`, err);
        errors.push({ account, message: err.message });
        return [];
      }
    }));

    const messages = perAccount.flat().sort((a, b) =>
      new Date(b.receivedDateTime || 0) - new Date(a.receivedDateTime || 0));

    // Label senders that match a known contact, so client mail is
    // identifiable without anyone tagging it by hand. A CRM lookup
    // failure must not take the inbox down with it.
    try {
      const matches = await crm.matchEmails(messages.map((m) => m.fromAddress));
      for (const m of messages) {
        const hit = matches[(m.fromAddress || '').toLowerCase()];
        if (hit) m.client = { id: hit.clientId, name: hit.clientName, stage: hit.stage };
      }
    } catch (err) {
      console.error('CRM sender lookup failed:', err.message);
    }

    res.json({ accounts, messages, errors, counts, page, hasMore, search });
  } catch (err) {
    console.error('Failed to load inbox:', err);
    res.status(502).json({ error: 'Failed to load mail.' });
  }
});

// Attachment download. Forced to download rather than render — mail
// attachments are untrusted, and letting the browser display one inline
// would run it in the app's origin.
app.get('/api/inbox/attachment', async (req, res) => {
  const { account, uid, index } = req.query;
  if (!configuredMailboxes().includes(account) || !uid || index === undefined) {
    return res.status(400).send('account, uid and index are required.');
  }
  try {
    const att = await mail.getAttachment(account, uid, index);
    if (!att) return res.status(404).send('Attachment not found.');

    // Strip anything path-like out of the filename before echoing it back.
    const safeName = String(att.filename).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    res.setHeader('Content-Type', att.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(att.content);
  } catch (err) {
    console.error('Failed to fetch attachment:', err);
    res.status(502).send('Could not fetch that attachment.');
  }
});

app.post('/api/inbox/forward', express.json(), async (req, res) => {
  const { account, to, subject, body } = req.body || {};
  if (!configuredMailboxes().includes(account) || !to || !body) {
    return res.status(400).json({ error: 'account, to, and body are required.' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return res.status(400).json({ error: 'That recipient address does not look valid.' });
  }
  try {
    await mail.sendMail({
      from: account,
      to,
      subject: /^fwd:/i.test(subject || '') ? subject : `Fwd: ${subject || ''}`.trim(),
      text: body,
    });
    res.status(204).end();
  } catch (err) {
    console.error('Failed to forward message:', err);
    res.status(502).json({ error: `Could not forward: ${err.message}` });
  }
});

// Full message with body. Separate from the list because downloading
// bodies for every message would make the inbox unusably slow.
app.get('/api/inbox/message', async (req, res) => {
  const { account, uid } = req.query;
  if (!configuredMailboxes().includes(account) || !uid) {
    return res.status(400).json({ error: 'account and uid are required.' });
  }
  try {
    const message = await mail.getMessage(account, uid);
    if (!message) return res.status(404).json({ error: 'That message no longer exists.' });

    try {
      const matches = await crm.matchEmails([message.fromAddress]);
      const hit = matches[(message.fromAddress || '').toLowerCase()];
      if (hit) message.client = { id: hit.clientId, name: hit.clientName, stage: hit.stage };
    } catch (err) {
      console.error('CRM lookup failed for message:', err.message);
    }

    res.json(message);
  } catch (err) {
    console.error('Failed to load message:', err);
    res.status(502).json({ error: `Could not open that message: ${err.message}` });
  }
});

app.post('/api/inbox/read', express.json(), async (req, res) => {
  const { account, uid, read } = req.body || {};
  if (!configuredMailboxes().includes(account) || !uid) {
    return res.status(400).json({ error: 'account and uid are required.' });
  }
  try {
    await mail.setRead(account, uid, read !== false);
    res.status(204).end();
  } catch (err) {
    console.error('Failed to change read state:', err);
    res.status(502).json({ error: 'Could not update that message.' });
  }
});

app.post('/api/inbox/delete', express.json(), async (req, res) => {
  const { account, uid } = req.body || {};
  if (!configuredMailboxes().includes(account) || !uid) {
    return res.status(400).json({ error: 'account and uid are required.' });
  }
  try {
    res.json(await mail.deleteMessage(account, uid));
  } catch (err) {
    console.error('Failed to delete message:', err);
    res.status(502).json({ error: 'Could not delete that message.' });
  }
});

// Turn a sender into a client + contact in one step, so mail from them
// is labelled from then on.
app.post('/api/inbox/to-client', express.json(), async (req, res) => {
  const { clientName, contactName, email } = req.body || {};
  if (!clientName || !email) {
    return res.status(400).json({ error: 'clientName and email are required.' });
  }
  try {
    const client = await crm.createClient({ name: clientName, stage: 'in_contact', lastTouchAt: new Date().toISOString() });
    await crm.createContact(client.id, { name: contactName || email, email, isPrimary: true });
    res.status(201).json(await crm.getClient(client.id));
  } catch (err) {
    console.error('Failed to create client from email:', err);
    res.status(500).json({ error: 'Could not create that client.' });
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

// --- Calendar ---

app.get('/api/calendar/events', async (req, res) => {
  try {
    res.json(await calendar.listEvents({ from: req.query.from, to: req.query.to }));
  } catch (err) {
    console.error('Failed to list events:', err);
    res.status(500).json({ error: 'Could not load events.' });
  }
});

app.post('/api/calendar/events', express.json(), async (req, res) => {
  const { title, startsAt } = req.body || {};
  if (!title || !startsAt) {
    return res.status(400).json({ error: 'title and startsAt are required.' });
  }
  if (isNaN(new Date(startsAt))) {
    return res.status(400).json({ error: 'startsAt is not a valid date.' });
  }
  try {
    const created = await calendar.createEvent(req.body);

    // Mirror into Google so Calendly sees the slot as busy. A failure
    // here must not lose the event — report it so the UI can warn that
    // the slot isn't protected yet.
    let mirrorWarning = null;
    try {
      const googleId = await google.pushEvent(created);
      if (googleId) {
        await calendar.setGoogleEventId(created.id, googleId);
        created.googleEventId = googleId;
      }
    } catch (err) {
      console.error('Google mirror failed for new event:', err);
      mirrorWarning = err.message;
    }

    res.status(201).json({ ...created, mirrorWarning });
  } catch (err) {
    console.error('Failed to create event:', err);
    res.status(500).json({ error: 'Could not create the event.' });
  }
});

app.patch('/api/calendar/events/:id', express.json(), async (req, res) => {
  try {
    const check = await calendar.isEditable(Number(req.params.id));
    if (!check.exists) return res.status(404).json({ error: 'Event not found.' });
    if (!check.editable) {
      return res.status(409).json({ error: `This event is synced from ${check.source} — edit it there instead.` });
    }
    const updated = await calendar.updateEvent(Number(req.params.id), req.body || {});
    if (!updated) return res.status(404).json({ error: 'Event not found.' });

    let mirrorWarning = null;
    try {
      const googleId = await google.pushEvent(updated);
      if (googleId && googleId !== updated.googleEventId) {
        await calendar.setGoogleEventId(updated.id, googleId);
        updated.googleEventId = googleId;
      }
    } catch (err) {
      console.error('Google mirror failed for updated event:', err);
      mirrorWarning = err.message;
    }

    res.json({ ...updated, mirrorWarning });
  } catch (err) {
    console.error('Failed to update event:', err);
    res.status(500).json({ error: 'Could not update the event.' });
  }
});

app.delete('/api/calendar/events/:id', async (req, res) => {
  try {
    const check = await calendar.isEditable(Number(req.params.id));
    if (!check.exists) return res.status(404).json({ error: 'Event not found.' });
    if (!check.editable) {
      return res.status(409).json({ error: `This event is synced from ${check.source} — cancel it there instead.` });
    }
    const removed = await calendar.deleteEvent(Number(req.params.id));
    if (!removed) return res.status(404).json({ error: 'Event not found.' });

    // Remove the Google mirror too, otherwise the slot stays blocked in
    // Calendly after you've freed it here.
    try {
      await google.deleteEvent(removed.googleEventId);
    } catch (err) {
      console.error('Failed to remove Google mirror:', err);
    }

    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete event:', err);
    res.status(500).json({ error: 'Could not delete the event.' });
  }
});

// --- CRM ---

app.get('/api/crm/clients', async (req, res) => {
  try {
    res.json({
      stages: crm.STAGES,
      terms: crm.TERMS,
      health: crm.HEALTH,
      clients: await crm.listClients(),
    });
  } catch (err) {
    console.error('Failed to list clients:', err);
    res.status(500).json({ error: 'Could not load clients.' });
  }
});

// Everything about one client in a single response: contacts, their
// tickets, recent correspondence, and their Wave invoices. Each source is
// wrapped separately — a slow IMAP search or a Wave outage degrades one
// section instead of failing the page.
app.get('/api/crm/clients/:id/detail', async (req, res) => {
  try {
    const client = await crm.getClient(Number(req.params.id));
    if (!client) return res.status(404).json({ error: 'Not found.' });

    const detail = {
      client, tickets: [], emails: [], invoices: [], files: [],
      packages: [], warnings: [],
    };

    try {
      detail.packages = await packages.clientPackages(client.id);
    } catch (err) {
      detail.warnings.push(`Packages unavailable: ${err.message}`);
    }

    try {
      const all = await tickets.listTickets({ openOnly: false });
      detail.tickets = all.filter((t) => t.clientId === client.id);
    } catch (err) {
      detail.warnings.push(`Tickets unavailable: ${err.message}`);
    }

    try {
      // Every file for this client regardless of folder — the point of the
      // client page is "show me everything", not "browse the tree".
      detail.files = await files.listFiles({ clientId: client.id });
    } catch (err) {
      detail.warnings.push(`Files unavailable: ${err.message}`);
    }

    const addresses = client.contacts.map((c) => c.email).filter(Boolean);
    if (addresses.length) {
      try {
        const accounts = (await mail.listAccounts())
          .filter((a) => configuredMailboxes().includes(a));
        const perAccount = await Promise.all(accounts.map((a) =>
          mail.findFromAddresses(a, addresses, { limit: 10 }).catch(() => [])));
        detail.emails = perAccount.flat()
          .sort((a, b) => new Date(b.receivedDateTime || 0) - new Date(a.receivedDateTime || 0))
          .slice(0, 15);
      } catch (err) {
        detail.warnings.push(`Mail lookup failed: ${err.message}`);
      }
    }

    try {
      const fin = await wave.fetchInvoices({ pageSize: 100 });
      if (fin) {
        // Wave has no link to our client records, so match on customer
        // name. Imperfect, and stated as such in the UI.
        const name = client.name.trim().toLowerCase();
        detail.invoices = fin.invoices.filter((i) =>
          (i.customer || '').trim().toLowerCase() === name);
        detail.invoiceMatchNote = 'Matched to Wave by customer name.';
      }
    } catch (err) {
      detail.warnings.push(`Wave unavailable: ${err.message}`);
    }

    res.json(detail);
  } catch (err) {
    console.error('Failed to build client detail:', err);
    res.status(500).json({ error: 'Could not load that client.' });
  }
});

app.get('/api/tickets/:id/detail', async (req, res) => {
  try {
    const ticket = await tickets.getTicket(Number(req.params.id));
    if (!ticket) return res.status(404).json({ error: 'Not found.' });

    const detail = { ticket, events: [], client: null };
    try {
      detail.events = await tickets.listEvents(ticket.id);
    } catch (err) {
      detail.eventsError = err.message;
    }
    if (ticket.clientId) {
      try {
        detail.client = await crm.getClient(ticket.clientId);
      } catch (err) { /* the ticket still renders without it */ }
    }
    res.json(detail);
  } catch (err) {
    console.error('Failed to build ticket detail:', err);
    res.status(500).json({ error: 'Could not load that ticket.' });
  }
});

app.post('/api/crm/clients', express.json(), async (req, res) => {
  if (!req.body?.name) return res.status(400).json({ error: 'A name is required.' });
  try {
    res.status(201).json(await crm.createClient(req.body));
  } catch (err) {
    console.error('Failed to create client:', err);
    res.status(500).json({ error: 'Could not create that client.' });
  }
});

app.patch('/api/crm/clients/:id', express.json(), async (req, res) => {
  try {
    const updated = await crm.updateClient(Number(req.params.id), req.body || {});
    if (!updated) return res.status(404).json({ error: 'Not found.' });
    res.json(updated);
  } catch (err) {
    console.error('Failed to update client:', err);
    res.status(500).json({ error: 'Could not update that client.' });
  }
});

app.delete('/api/crm/clients/:id', async (req, res) => {
  const removed = await crm.deleteClient(Number(req.params.id));
  if (!removed) return res.status(404).json({ error: 'Not found.' });
  res.status(204).end();
});

app.post('/api/crm/clients/:id/contacts', express.json(), async (req, res) => {
  if (!req.body?.name) return res.status(400).json({ error: 'A contact name is required.' });
  try {
    res.status(201).json(await crm.createContact(Number(req.params.id), req.body));
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: 'That client no longer exists.' });
    console.error('Failed to create contact:', err);
    res.status(500).json({ error: 'Could not add that contact.' });
  }
});

app.patch('/api/crm/contacts/:id', express.json(), async (req, res) => {
  try {
    const updated = await crm.updateContact(Number(req.params.id), req.body || {});
    if (!updated) return res.status(404).json({ error: 'Not found.' });
    res.json(updated);
  } catch (err) {
    console.error('Failed to update contact:', err);
    res.status(500).json({ error: 'Could not update that contact.' });
  }
});

app.delete('/api/crm/contacts/:id', async (req, res) => {
  const removed = await crm.deleteContact(Number(req.params.id));
  if (!removed) return res.status(404).json({ error: 'Not found.' });
  res.status(204).end();
});

// --- Search ---
// Local records only; the Inbox keeps its own IMAP search. See lib/search.js.

app.get('/api/search', async (req, res) => {
  try {
    res.json(await search.search(req.query.q));
  } catch (err) {
    console.error('Search failed:', err);
    res.status(500).json({ error: 'Search failed.' });
  }
});

// --- Packages ---
// Service packages and their unit prices. A client's value is the sum of
// unit price times quantity across these, so editing a price here moves
// every client carrying that package.

app.get('/api/packages', async (req, res) => {
  try {
    res.json({ packages: await packages.listPackages({ activeOnly: req.query.active === '1' }) });
  } catch (err) {
    console.error('Failed to list packages:', err);
    res.status(500).json({ error: 'Could not load packages.' });
  }
});

app.post('/api/packages', express.json(), async (req, res) => {
  try {
    res.status(201).json(await packages.createPackage(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/packages/:id', express.json(), async (req, res) => {
  try {
    const updated = await packages.updatePackage(Number(req.params.id), req.body || {});
    if (!updated) return res.status(404).json({ error: 'Not found.' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Retires rather than deletes once a package is on a client — see
// lib/packages.js. The response says which happened so the UI can be
// honest about it.
app.delete('/api/packages/:id', async (req, res) => {
  try {
    const result = await packages.removePackage(Number(req.params.id));
    if (!result) return res.status(404).json({ error: 'Not found.' });
    res.json(result);
  } catch (err) {
    console.error('Failed to remove package:', err);
    res.status(500).json({ error: 'Could not remove that package.' });
  }
});

app.get('/api/crm/clients/:id/packages', async (req, res) => {
  try {
    const clientId = Number(req.params.id);
    res.json({
      packages: await packages.clientPackages(clientId),
      valueCents: await packages.valueFor(clientId),
    });
  } catch (err) {
    console.error('Failed to load client packages:', err);
    res.status(500).json({ error: 'Could not load packages.' });
  }
});

// Absolute quantity rather than an increment, so a double-tapped stepper
// or a retried request cannot compound.
app.put('/api/crm/clients/:id/packages/:packageId', express.json(), async (req, res) => {
  try {
    const clientId = Number(req.params.id);
    await packages.setQuantity(clientId, Number(req.params.packageId), (req.body || {}).quantity);
    res.json({
      packages: await packages.clientPackages(clientId),
      valueCents: await packages.valueFor(clientId),
    });
  } catch (err) {
    console.error('Failed to set quantity:', err);
    res.status(400).json({ error: 'Could not save that quantity.' });
  }
});

// --- Files ---

// This endpoint always browses one level of the tree. Absent or "root"
// means the top level, an id means inside that folder. Without a clientId
// the top level is every client's — the "All clients" root is a real root,
// not a separate flat mode.
function folderFilter(value) {
  if (!value || value === 'root') return null;
  return Number(value);
}

app.get('/api/files', async (req, res) => {
  try {
    const clientId = req.query.clientId ? Number(req.query.clientId) : null;
    const folderId = folderFilter(req.query.folder);

    res.json({
      configured: files.isConfigured(),
      maxBytes: files.MAX_BYTES,
      maxDepth: folders.MAX_DEPTH,
      files: await files.listFiles({
        clientId,
        projectId: req.query.projectId ? Number(req.query.projectId) : null,
        folderId,
      }),
      // undefined, not null: null would mean "folders belonging to no
      // client", which is a much smaller set than "every client's".
      folders: await folders.listFolders({
        clientId: clientId || undefined,
        parentId: folderId,
      }),
      breadcrumb: folderId ? await folders.breadcrumb(folderId) : [],
      stats: await files.stats(),
    });
  } catch (err) {
    console.error('Failed to list files:', err);
    res.status(500).json({ error: 'Could not load files.' });
  }
});

// Every folder at any depth, for the move dialog's destination list. The
// browsing endpoint returns one level, which is the wrong shape here.
app.get('/api/folders', async (req, res) => {
  try {
    res.json({
      folders: await folders.listFolders({
        clientId: req.query.clientId ? Number(req.query.clientId) : undefined,
      }),
    });
  } catch (err) {
    console.error('Failed to list folders:', err);
    res.status(500).json({ error: 'Could not load folders.' });
  }
});

app.post('/api/folders', express.json(), async (req, res) => {
  try {
    const { name, clientId, parentId } = req.body || {};
    res.status(201).json(await folders.createFolder({
      name,
      clientId: clientId ? Number(clientId) : null,
      parentId: parentId ? Number(parentId) : null,
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/folders/:id', express.json(), async (req, res) => {
  try {
    const folder = await folders.renameFolder(Number(req.params.id), (req.body || {}).name);
    if (!folder) return res.status(404).json({ error: 'Not found.' });
    res.json(folder);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Deleting a folder moves its contents up rather than destroying them.
// The response says how many files moved so the UI can be honest about it.
app.delete('/api/folders/:id', async (req, res) => {
  try {
    const result = await folders.deleteFolder(Number(req.params.id));
    if (!result) return res.status(404).json({ error: 'Not found.' });
    res.json(result);
  } catch (err) {
    console.error('Could not delete folder:', err);
    res.status(500).json({ error: 'Could not delete that folder.' });
  }
});

// The file arrives as a raw body rather than multipart: the browser can
// POST a File object directly, which avoids a multipart parser and its
// dependency entirely. Metadata rides in the query string.
app.post('/api/files',
  express.raw({ type: '*/*', limit: files.MAX_BYTES + 1024 }),
  async (req, res) => {
    const name = (req.query.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'A filename is required.' });
    if (!files.isConfigured()) return res.status(503).json({ error: 'File storage is not configured.' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'No file content received.' });

    try {
      const clientId = req.query.clientId ? Number(req.query.clientId) : null;

      // A folder upload sends the file's directory path alongside it and
      // lets the server build the chain, rather than the browser making a
      // round of folder calls first and then uploading against ids.
      let folderId = req.query.folderId ? Number(req.query.folderId) : null;
      if (req.query.path) {
        folderId = await folders.ensurePath(req.query.path, { clientId, parentId: folderId });
      }

      const saved = await files.upload({
        name: name.slice(0, 200),
        buffer: req.body,
        contentType: req.get('content-type'),
        clientId,
        projectId: req.query.projectId ? Number(req.query.projectId) : null,
        folderId,
        notes: req.query.notes ? String(req.query.notes).slice(0, 500) : null,
      });
      res.status(201).json(saved);
    } catch (err) {
      console.error('Upload failed:', err);
      res.status(400).json({ error: err.message });
    }
  });

// Streams through the app so every download stays behind the login. A
// presigned URL would work for anyone holding it, which is the wrong
// default for client files.
app.get('/api/files/:id/download', async (req, res) => {
  try {
    const result = await files.download(Number(req.params.id));
    if (!result) return res.status(404).send('Not found.');

    const safeName = String(result.file.name).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    res.setHeader('Content-Type', result.file.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(result.buffer);
  } catch (err) {
    console.error('Download failed:', err);
    res.status(502).send('Could not fetch that file.');
  }
});

// Moving a file between folders. Metadata only — the stored object is
// untouched, since its key never encoded a path.
app.patch('/api/files/:id', express.json(), async (req, res) => {
  try {
    const { folderId } = req.body || {};
    const moved = await files.move(Number(req.params.id),
      folderId ? Number(folderId) : null);
    if (!moved) return res.status(404).json({ error: 'Not found.' });
    res.json(moved);
  } catch (err) {
    console.error('Move failed:', err);
    res.status(400).json({ error: 'Could not move that file.' });
  }
});

app.delete('/api/files/:id', async (req, res) => {
  try {
    const ok = await files.remove(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Not found.' });
    res.status(204).end();
  } catch (err) {
    console.error('Delete failed:', err);
    res.status(500).json({ error: 'Could not delete that file.' });
  }
});

// Surfaced in Integrations so a misconfigured bucket is visible before
// someone tries to upload.
app.get('/api/files/status', async (req, res) => {
  res.json(await files.check());
});

// --- People ---

app.get('/api/people', async (req, res) => {
  try {
    res.json({
      engagements: people.ENGAGEMENTS,
      people: await people.listPeople({ activeOnly: req.query.active === '1' }),
    });
  } catch (err) {
    console.error('Failed to list people:', err);
    res.status(500).json({ error: 'Could not load people.' });
  }
});

app.post('/api/people', express.json(), async (req, res) => {
  if (!req.body?.name) return res.status(400).json({ error: 'A name is required.' });
  try {
    res.status(201).json(await people.createPerson(req.body));
  } catch (err) {
    console.error('Failed to create person:', err);
    res.status(500).json({ error: 'Could not add that person.' });
  }
});

app.patch('/api/people/:id', express.json(), async (req, res) => {
  try {
    const updated = await people.updatePerson(Number(req.params.id), req.body || {});
    if (!updated) return res.status(404).json({ error: 'Not found.' });
    res.json(updated);
  } catch (err) {
    console.error('Failed to update person:', err);
    res.status(500).json({ error: 'Could not update that person.' });
  }
});

app.delete('/api/people/:id', async (req, res) => {
  const removed = await people.deletePerson(Number(req.params.id));
  if (!removed) return res.status(404).json({ error: 'Not found.' });
  res.status(204).end();
});

app.post('/api/projects/:id/team', express.json(), async (req, res) => {
  if (!req.body?.personId) return res.status(400).json({ error: 'personId is required.' });
  try {
    await people.assign(Number(req.params.id), Number(req.body.personId));
    res.status(204).end();
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: 'That project or person no longer exists.' });
    console.error('Failed to assign:', err);
    res.status(500).json({ error: 'Could not assign that person.' });
  }
});

app.delete('/api/projects/:id/team/:personId', async (req, res) => {
  await people.unassign(Number(req.params.id), Number(req.params.personId));
  res.status(204).end();
});

// --- Projects ---

app.get('/api/projects', async (req, res) => {
  try {
    res.json({
      stages: projects.STAGES,
      health: projects.HEALTH,
      taskStatuses: projects.TASK_STATUSES,
      milestoneStatuses: projects.MILESTONE_STATUSES,
      projects: await projects.listProjects({ openOnly: req.query.open === '1' }),
      stats: await projects.stats(),
    });
  } catch (err) {
    console.error('Failed to list projects:', err);
    res.status(500).json({ error: 'Could not load projects.' });
  }
});

app.post('/api/projects', express.json(), async (req, res) => {
  if (!req.body?.name) return res.status(400).json({ error: 'A name is required.' });
  try {
    res.status(201).json(await projects.createProject(req.body));
  } catch (err) {
    console.error('Failed to create project:', err);
    res.status(500).json({ error: 'Could not create that project.' });
  }
});

app.patch('/api/projects/:id', express.json(), async (req, res) => {
  try {
    const updated = await projects.updateProject(Number(req.params.id), req.body || {});
    if (!updated) return res.status(404).json({ error: 'Not found.' });
    res.json(updated);
  } catch (err) {
    console.error('Failed to update project:', err);
    res.status(500).json({ error: 'Could not update that project.' });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
  const removed = await projects.deleteProject(Number(req.params.id));
  if (!removed) return res.status(404).json({ error: 'Not found.' });
  res.status(204).end();
});

// Everything for one project's page: board, milestones, and the client's
// tickets and invoices. Each extra source is wrapped so one failure
// degrades a section rather than the page.
app.get('/api/projects/:id/detail', async (req, res) => {
  try {
    const project = await projects.getProject(Number(req.params.id));
    if (!project) return res.status(404).json({ error: 'Not found.' });

    const detail = { project, tasks: [], milestones: [], tickets: [], invoices: [], warnings: [] };

    detail.tasks = await projects.listTasks(project.id);
    detail.milestones = await projects.listMilestones(project.id);
    detail.team = await people.listTeam(project.id);

    if (project.clientId) {
      try {
        const all = await tickets.listTickets({ openOnly: false });
        detail.tickets = all.filter((t) => t.clientId === project.clientId);
      } catch (err) {
        detail.warnings.push(`Tickets unavailable: ${err.message}`);
      }
      try {
        const fin = await wave.fetchInvoices({ pageSize: 100 });
        if (fin && project.clientName) {
          const name = project.clientName.trim().toLowerCase();
          detail.invoices = fin.invoices.filter((i) =>
            (i.customer || '').trim().toLowerCase() === name);
        }
      } catch (err) {
        detail.warnings.push(`Wave unavailable: ${err.message}`);
      }
    }

    res.json(detail);
  } catch (err) {
    console.error('Failed to build project detail:', err);
    res.status(500).json({ error: 'Could not load that project.' });
  }
});

app.post('/api/projects/:id/tasks', express.json(), async (req, res) => {
  if (!req.body?.title) return res.status(400).json({ error: 'A title is required.' });
  try {
    const id = await projects.createTask(Number(req.params.id), req.body);
    res.status(201).json({ id });
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: 'That project no longer exists.' });
    console.error('Failed to create task:', err);
    res.status(500).json({ error: 'Could not add that task.' });
  }
});

app.patch('/api/projects/tasks/:id', express.json(), async (req, res) => {
  const ok = await projects.updateTask(Number(req.params.id), req.body || {});
  if (!ok) return res.status(404).json({ error: 'Not found.' });
  res.status(204).end();
});

app.delete('/api/projects/tasks/:id', async (req, res) => {
  const ok = await projects.deleteTask(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Not found.' });
  res.status(204).end();
});

app.post('/api/projects/:id/milestones', express.json(), async (req, res) => {
  if (!req.body?.name) return res.status(400).json({ error: 'A name is required.' });
  try {
    const id = await projects.createMilestone(Number(req.params.id), req.body);
    res.status(201).json({ id });
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: 'That project no longer exists.' });
    console.error('Failed to create milestone:', err);
    res.status(500).json({ error: 'Could not add that milestone.' });
  }
});

app.patch('/api/projects/milestones/:id', express.json(), async (req, res) => {
  const ok = await projects.updateMilestone(Number(req.params.id), req.body || {});
  if (!ok) return res.status(404).json({ error: 'Not found.' });
  res.status(204).end();
});

app.delete('/api/projects/milestones/:id', async (req, res) => {
  const ok = await projects.deleteMilestone(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Not found.' });
  res.status(204).end();
});

// --- Wave (accounting) ---

app.get('/api/wave/status', async (req, res) => {
  try {
    const creds = await wave.loadCredentials();
    if (!creds) return res.json({ connected: false });
    const { email, businesses } = await wave.listBusinesses(creds.token);
    res.json({
      connected: true,
      email,
      businesses,
      businessId: creds.businessId,
      viaEnv: !!process.env.WAVE_TOKEN,
    });
  } catch (err) {
    // A stored-but-rejected token is "connected but broken" — report the
    // reason (often a plan restriction) rather than a clean disconnected state.
    res.json({ connected: true, error: err.message });
  }
});

app.post('/api/wave/connect', express.json(), async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'A full access token is required.' });
  try {
    const { email, businesses } = await wave.listBusinesses(token); // validate first
    if (!businesses.length) {
      return res.status(400).json({ error: 'That token works, but no active Wave business is visible on it.' });
    }
    await wave.saveToken(token, businesses.length === 1 ? businesses[0].id : null);
    res.json({ email, businesses });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/wave/business', express.json(), async (req, res) => {
  if (!req.body?.businessId) return res.status(400).json({ error: 'businessId is required.' });
  try {
    await wave.setBusiness(req.body.businessId);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/wave/disconnect', async (req, res) => {
  await wave.disconnect();
  res.status(204).end();
});

app.get('/api/finance', async (req, res) => {
  try {
    const result = await wave.fetchInvoices({ pageSize: 100 });
    if (!result) return res.json({ connected: false });
    res.json({
      connected: true,
      businessName: result.businessName,
      totalCount: result.totalCount,
      invoices: result.invoices,
      summary: wave.summarise(result.invoices),
    });
  } catch (err) {
    console.error('Failed to load Wave invoices:', err.message);
    res.status(502).json({ connected: true, error: err.message });
  }
});

// --- Service desk ---

app.get('/api/tickets', async (req, res) => {
  try {
    res.json({
      statuses: tickets.STATUSES,
      priorities: tickets.PRIORITIES,
      tickets: await tickets.listTickets({ openOnly: req.query.open === '1' }),
      stats: await tickets.stats(),
    });
  } catch (err) {
    console.error('Failed to list tickets:', err);
    res.status(500).json({ error: 'Could not load tickets.' });
  }
});

app.post('/api/tickets', express.json(), async (req, res) => {
  if (!req.body?.subject) return res.status(400).json({ error: 'A subject is required.' });
  try {
    res.status(201).json(await tickets.createTicket(req.body));
  } catch (err) {
    console.error('Failed to create ticket:', err);
    res.status(500).json({ error: 'Could not create that ticket.' });
  }
});

app.patch('/api/tickets/:id', express.json(), async (req, res) => {
  try {
    const updated = await tickets.updateTicket(Number(req.params.id), req.body || {});
    if (!updated) return res.status(404).json({ error: 'Not found.' });
    res.json(updated);
  } catch (err) {
    console.error('Failed to update ticket:', err);
    res.status(500).json({ error: 'Could not update that ticket.' });
  }
});

app.delete('/api/tickets/:id', async (req, res) => {
  const removed = await tickets.deleteTicket(Number(req.params.id));
  if (!removed) return res.status(404).json({ error: 'Not found.' });
  res.status(204).end();
});

// --- Scheduling admin ---

app.get('/api/scheduling/config', async (req, res) => {
  try {
    const [eventTypes, availability, timezone] = await Promise.all([
      scheduling.listEventTypes(),
      scheduling.getAvailability(),
      scheduling.getTimezone(),
    ]);
    res.json({
      eventTypes,
      availability,
      timezone,
      baseUrl: `${req.protocol}://${req.get('host')}`,
    });
  } catch (err) {
    console.error('Failed to load scheduling config:', err);
    res.status(500).json({ error: 'Could not load scheduling settings.' });
  }
});

app.post('/api/scheduling/event-types', express.json(), async (req, res) => {
  if (!req.body?.name) return res.status(400).json({ error: 'A name is required.' });
  try {
    res.status(201).json(await scheduling.createEventType(req.body));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That URL slug is already in use.' });
    console.error('Failed to create event type:', err);
    res.status(500).json({ error: 'Could not create that meeting type.' });
  }
});

app.patch('/api/scheduling/event-types/:id', express.json(), async (req, res) => {
  try {
    const updated = await scheduling.updateEventType(Number(req.params.id), req.body || {});
    if (!updated) return res.status(404).json({ error: 'Not found.' });
    res.json(updated);
  } catch (err) {
    console.error('Failed to update event type:', err);
    res.status(500).json({ error: 'Could not update that meeting type.' });
  }
});

app.delete('/api/scheduling/event-types/:id', async (req, res) => {
  const removed = await scheduling.deleteEventType(Number(req.params.id));
  if (!removed) return res.status(404).json({ error: 'Not found.' });
  res.status(204).end();
});

app.put('/api/scheduling/availability', express.json(), async (req, res) => {
  if (!Array.isArray(req.body?.windows)) {
    return res.status(400).json({ error: 'windows must be an array.' });
  }
  try {
    await scheduling.setAvailability(req.body.windows);
    res.json(await scheduling.getAvailability());
  } catch (err) {
    console.error('Failed to save availability:', err);
    res.status(500).json({ error: 'Could not save availability.' });
  }
});

app.put('/api/scheduling/timezone', express.json(), async (req, res) => {
  try {
    await scheduling.setTimezone(req.body?.timezone);
    res.json({ timezone: await scheduling.getTimezone() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/scheduling/bookings/:id', async (req, res) => {
  try {
    const result = await scheduling.cancelBookingById(Number(req.params.id));
    if (!result) return res.status(404).json({ error: 'Not found.' });
    res.status(204).end();
  } catch (err) {
    console.error('Failed to cancel booking:', err);
    res.status(500).json({ error: 'Could not cancel that booking.' });
  }
});

app.get('/api/scheduling/bookings', async (req, res) => {
  try {
    res.json(await scheduling.listBookings({ upcomingOnly: req.query.all !== '1' }));
  } catch (err) {
    console.error('Failed to list bookings:', err);
    res.status(500).json({ error: 'Could not load bookings.' });
  }
});

// --- Google Calendar bridge ---
// Exists so Calendly can see this app's events: Calendly checks the
// calendars it's connected to, and can't read our .ics feed.

function googleRedirectUri(req) {
  return `${req.protocol}://${req.get('host')}/auth/google/callback`;
}

app.get('/auth/google/start', (req, res) => {
  if (!google.isConfigured()) {
    return res.status(400).send('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.googleOAuthState = state;
  res.redirect(google.buildAuthUrl({ redirectUri: googleRedirectUri(req), state }));
});

app.get('/auth/google/callback', async (req, res) => {
  const expected = req.session.googleOAuthState;
  delete req.session.googleOAuthState;

  if (req.query.error) {
    return res.redirect(`/?googleError=${encodeURIComponent(req.query.error)}`);
  }
  if (!expected || req.query.state !== expected) {
    return res.redirect('/?googleError=invalid_state');
  }

  try {
    const tokens = await google.exchangeCodeForToken({
      code: req.query.code,
      redirectUri: googleRedirectUri(req),
    });
    if (!tokens.refresh_token) {
      // Without a refresh token the bridge dies within the hour, which
      // would silently stop protecting slots. Better to fail loudly.
      return res.redirect('/?googleError=no_refresh_token');
    }
    await google.saveTokens(tokens);
    const result = await google.backfill();
    res.redirect(`/?googleConnected=1&pushed=${result.pushed || 0}`);
  } catch (err) {
    console.error('Google OAuth callback failed:', err);
    res.redirect(`/?googleError=${encodeURIComponent(err.message)}`);
  }
});

app.get('/api/google/status', async (req, res) => {
  if (!google.isConfigured()) return res.json({ configured: false, connected: false });
  if (!(await google.isConnected())) return res.json({ configured: true, connected: false });
  try {
    const [account, calendars, target] = await Promise.all([
      google.getAccountEmail(),
      google.listCalendars(),
      google.getTargetCalendarId(),
    ]);
    res.json({ configured: true, connected: true, account, calendars, target });
  } catch (err) {
    res.json({ configured: true, connected: true, error: err.message });
  }
});

app.post('/api/google/calendar', express.json(), async (req, res) => {
  const { calendarId } = req.body || {};
  if (!calendarId) return res.status(400).json({ error: 'calendarId is required.' });
  await google.setTargetCalendarId(calendarId);
  // Events already mirrored point at the old calendar; clear and re-push
  // so the new target is the one Calendly actually sees.
  await pool.query(`UPDATE calendar_events SET google_event_id = NULL WHERE source = 'manual'`);
  try {
    res.json(await google.backfill());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/google/sync', async (req, res) => {
  try {
    res.json(await google.backfill());
  } catch (err) {
    console.error('Google backfill failed:', err);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/google/disconnect', async (req, res) => {
  await google.disconnect();
  res.status(204).end();
});

// --- Calendly ---

app.get('/api/calendly/status', async (req, res) => {
  try {
    const connected = await calendly.isConfigured();
    if (!connected) return res.json({ connected: false });
    const token = await calendly.getToken();
    const user = await calendly.getCurrentUser(token);
    res.json({ connected: true, account: user.email, viaEnv: !!process.env.CALENDLY_TOKEN });
  } catch (err) {
    // A stored-but-rejected token is "connected but broken" — say so
    // rather than reporting a clean disconnected state.
    res.json({ connected: true, error: err.message });
  }
});

app.post('/api/calendly/connect', express.json(), async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'A personal access token is required.' });
  try {
    const user = await calendly.getCurrentUser(token); // validate before storing
    await calendly.saveToken(token);
    const result = await calendly.sync();
    res.json({ account: user.email, ...result });
  } catch (err) {
    res.status(400).json({ error: `Calendly rejected that token: ${err.message}` });
  }
});

app.post('/api/calendly/disconnect', async (req, res) => {
  await calendly.deleteToken();
  res.status(204).end();
});

app.post('/api/calendly/sync', async (req, res) => {
  try {
    res.json(await calendly.sync());
  } catch (err) {
    console.error('Calendly sync failed:', err);
    res.status(502).json({ error: err.message });
  }
});

function feedUrlFor(req, token) {
  return `${req.protocol}://${req.get('host')}/calendar/${token}/pocket-data-office.ics`;
}

app.get('/api/calendar/feed', async (req, res) => {
  const token = await calendar.getFeedToken();
  res.json({ url: feedUrlFor(req, token) });
});

app.post('/api/calendar/feed/rotate', async (req, res) => {
  const token = await calendar.rotateFeedToken();
  res.json({ url: feedUrlFor(req, token) });
});

app.use(express.static(path.join(__dirname, 'public')));

// Poll Calendly for new/cancelled bookings. The guard stops a slow sync
// from overlapping the next tick; unhandled failures are logged and the
// loop continues rather than taking the process down.
const CALENDLY_POLL_MINUTES = Number(process.env.CALENDLY_POLL_MINUTES || 5);
let calendlySyncRunning = false;

async function pollCalendly() {
  if (calendlySyncRunning) return;
  calendlySyncRunning = true;
  try {
    const result = await calendly.sync();
    if (!result.skipped && (result.upserted || result.removed)) {
      console.log(`Calendly sync: ${result.upserted} updated, ${result.removed} removed`);
    }
  } catch (err) {
    console.error('Calendly sync failed:', err.message);
  } finally {
    calendlySyncRunning = false;
  }
}

migrate()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  })
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Pocket Data Office listening on port ${PORT}`);
    });

    const interval = setInterval(pollCalendly, CALENDLY_POLL_MINUTES * 60 * 1000);
    interval.unref?.(); // don't hold the process open on shutdown
    pollCalendly();
  });
