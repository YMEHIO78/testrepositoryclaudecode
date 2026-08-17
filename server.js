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
