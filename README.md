# Pocket Data Office

Internal ops app — dashboard, inbox, CRM, projects, service desk, files,
finance, and people — built to replace the earlier Notion-based mockup.
No Notion dependency, no AI-agent chat feature. Planned integrations:
two Outlook inboxes, Outlook Calendar, and Wave.

This repo ships the front-end mockup (`/public/index.html`) behind an
Express server with a real login gate — session-based auth backed by
Postgres, rate-limited against brute force. The `System spec` tab inside
the app has the full data model and integration plan for turning this
into the real thing.

## Run locally

Needs a Postgres database (for sessions and, later, encrypted OAuth
tokens). Point `DATABASE_URL` in `.env` at one, then:

```bash
npm install
npm start
```

Visit `http://localhost:3000` — you'll land on `/login`. Sign in with
whatever you set `AUTH_USER` / `AUTH_PASS` to.

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
3. Add a Postgres database to the project and reference its `DATABASE_URL`
   on this service.
4. Railway detects Node automatically via `package.json` and runs `npm start`.
5. Generate a domain (Settings → Networking → Generate Domain) once it's live.
6. Set `AUTH_USER`, `AUTH_PASS`, `SESSION_SECRET`, and `TOKEN_ENCRYPTION_KEY`
   in the Variables tab (see `.env.example`).

Railway gives you HTTPS and network isolation on that domain by default.
Everything below is still on you.

## Mail

Reads the inbox over IMAP and sends replies over SMTP.

**Why not Microsoft Graph?** The original plan was Outlook via Graph, but
this domain's mail is hosted at Hostinger, not Microsoft 365 — its MX
records point to `mx*.hostinger.com`, and Microsoft's directory lookup
returns `NameSpaceType: Unknown` for these addresses. Graph can only
reach Exchange Online mailboxes, so it can't work here regardless of how
the app registration is configured. IMAP/SMTP is the right protocol for
mail hosted anywhere outside Microsoft. (The same constraint rules out
Outlook Calendar; that section is marked unavailable in the UI.)

Setup:

1. Set `MAILBOXES` in Railway Variables — a comma-separated allowlist of
   the addresses you want connectable. Anything not in the list is
   rejected by the connect endpoint.
2. Optionally override `IMAP_HOST` / `IMAP_PORT` / `SMTP_HOST` /
   `SMTP_PORT`; they default to Hostinger's and just pre-fill the form.
3. In the app: **Integrations** → **Connect** next to a mailbox → enter
   its password. The credentials are tested against the IMAP server
   before anything is saved, so a wrong password fails immediately
   instead of producing a silently empty inbox.

Passwords are encrypted with AES-256-GCM (`lib/crypto.js`) before being
written to `mail_accounts`, and are never returned to the browser — the
API only ever reports connected/not-connected. Disconnecting deletes the
stored credential outright.

Note that an IMAP password grants full mailbox access and can't be
scoped the way an OAuth token can. Use a dedicated app password if your
provider supports one.

## Calendar

The calendar is native — events live in this app's `calendar_events`
table rather than in an external provider. That's partly by necessity
(no Exchange, and no CalDAV endpoint on this domain) and partly because
much of what belongs on this calendar — ticket SLA dates, project
milestones — originates here anyway and no external provider could own
it.

Create, edit, and delete events on the **Calendar** page.

**Getting it onto your devices:** the same page shows a subscription URL
ending in `.ics`. Add it as a subscribed calendar in Apple Calendar,
Google Calendar, or Outlook and events appear there, refreshing on
whatever interval that client uses (typically 15–60 minutes; the feed
advertises 30).

That URL is served *outside* the login gate, because calendar clients
poll it without a session and can't authenticate. The random token in
the path is the only thing protecting it, so:

- Treat the URL as a credential — anyone holding it can read every event.
- It's read-only; subscribing can't modify anything here.
- **Reset URL** on the Calendar page rotates the token, which immediately
  breaks any device still using the old one.

`source` on each event marks where it came from — `manual` for events
typed in here, `calendly` for synced bookings. When Tickets and Projects
become real database records, their dates can be written in as
`ticket`/`project` rows and will appear on the grid and in the feed with
no further changes.

## Calendly

Scheduled bookings are pulled in and shown on the calendar (green) and in
the `.ics` feed. Connect under **Integrations** with a personal access
token from calendly.com → Integrations → API & Webhooks, or set
`CALENDLY_TOKEN` in Railway to keep the token out of the browser
entirely (the env var wins if both are present). The app polls every
`CALENDLY_POLL_MINUTES` minutes (default 5); **Sync now** forces one.

**Calendly's availability API is read-only** (`/user_availability_schedules`,
`/user_busy_times`, `/event_type_available_times` are all GET), so there
is no way to push a blocked slot into Calendly directly. Preventing
double-bookings instead goes through Google Calendar — see below.

Synced events are read-only in this app: the API rejects edits and
deletes on them with a 409, and the UI shows them in a read-only panel,
because the next sync would overwrite any local change. Reschedule or
cancel in Calendly instead. Disconnecting removes the stored token and
every synced booking; nothing changes in Calendly itself.

## Scheduling (built-in booking pages)

A self-hosted equivalent of Calendly. Each meeting type gets a public
page at `/book/<slug>` that anyone can use without logging in; they pick
a slot, enter their details, and get a confirmation email with a
cancellation link.

**Why build this rather than use Calendly:** slot availability is
computed directly against `calendar_events`, so every event the app
knows about — manual blocks, imported Calendly bookings, anything added
later — is subtracted from what's offered. Double-booking is prevented
*by construction*. Calendly can't do that here, because it only sees
calendars it's connected to and can't read this app. Using the built-in
scheduler makes the Google Calendar bridge unnecessary.

Configure under **Scheduling**:

- **Meeting types** — name, duration, buffer after, minimum notice, how
  far ahead people can book, location. Each has its own link.
- **Weekly hours** — the window you're bookable each day, plus the
  timezone those hours are expressed in.
- **Upcoming bookings** — who booked what, and when.

Mechanics worth knowing:

- **Slots are re-checked at booking time inside a `SERIALIZABLE`
  transaction.** Between loading the page and clicking confirm, someone
  else may have taken the slot; without that check two people could book
  the same time. A loser gets a clear "just taken" message and refreshed
  times.
- **Buffers extend the footprint that must be clear**, without moving
  the meeting — a 30-minute slot with a 10-minute after-buffer needs 40
  clear minutes but is still booked as 30.
- **All-day events block the whole day**; timed events without an end
  are treated as one hour, matching how they render elsewhere.
- **Day iteration uses luxon in the configured zone**, so DST changes
  don't shift your hours.
- **Confirmation emails are sent after the response, not before it.**
  SMTP can take many seconds or stall entirely, and making someone wait
  on it invites them to assume the booking failed and book again. The
  request returns as soon as the booking commits; mail goes out in the
  background and failures are logged only. SMTP calls also carry
  connection/socket timeouts so a dead mail host can't pile up hung
  requests. Mail goes through a connected mailbox (see Mail above), so
  at least one must be connected for confirmations to send.
- **The public booking endpoint is rate limited** (10 per hour per IP),
  since it's unauthenticated and writes to the calendar.
- **Cancelling frees the slot** by deleting the calendar event; the
  booking row is kept, marked cancelled, as a record.

## Google Calendar (double-booking prevention)

*Optional if you use the built-in scheduler above — that already
prevents double-booking without any third party. This is only needed to
protect your time against bookings made through **Calendly**.*

This integration exists for exactly one reason: **to stop Calendly
booking over time you've blocked here.**

Calendly decides availability by reading the calendars it is connected to
(Google, Outlook/Office 365, iCloud, Exchange). It cannot read this app,
and it cannot subscribe to an `.ics` feed. So the chain is:

```
event created here → mirrored into Google Calendar → Calendly reads Google → slot unavailable
```

Setup:

1. [console.cloud.google.com](https://console.cloud.google.com) → new project.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **OAuth consent screen** → External; add your own address as a test user.
4. **Credentials → Create Credentials → OAuth client ID** → Web
   application → authorized redirect URI
   `https://<your-domain>/auth/google/callback`.
5. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in Railway.
6. **Integrations → Google Calendar → Connect**, then pick which calendar
   to write to.
7. **In Calendly, make sure that same calendar is one it checks for
   conflicts.** Miss this step and everything above is inert.

Scopes requested are `calendar.events` (create/update/delete events) and
`calendar.readonly` (list your calendars so you can choose one) — not
full calendar admin.

Details worth knowing:

- **Only `manual` events are mirrored.** Calendly bookings are skipped on
  purpose: Calendly already writes those into the connected Google
  calendar itself, so mirroring them would double them up.
- **A failed mirror is surfaced, not swallowed.** If the push to Google
  fails, the event still saves here and the UI warns that the slot isn't
  protected — silently failing would defeat the point.
- **Deletes propagate.** Removing an event here removes its Google
  mirror, so freeing time here actually frees it in Calendly.
- **The OAuth flow demands a refresh token** (`access_type=offline`,
  `prompt=consent`). If Google returns none — which happens when the app
  was already authorised previously — the connection is refused with an
  explanation rather than accepted and left to die at the first token
  expiry.
- Changing the target calendar re-pushes events to the new one.
- Disconnecting leaves already-mirrored events in Google; delete them
  there if you want them gone.

## Security — done so far, and what's still on you

Railway's proxy secures the network path to your app. On top of that,
this repo now has:

- **A real login gate.** Session-based auth (`express-session` +
  `connect-pg-simple`), not a shared browser popup. Sessions live in
  Postgres, idle out after 12 hours, and are revoked on sign-out.
- **Rate limiting on login.** 10 failed attempts per IP per 15 minutes,
  keyed off Railway's `X-Real-IP` header (see the comment in `server.js`
  for why — their proxy chain doesn't suit Express's default
  `trust proxy` hop-counting).
- **Encrypted credential storage.** Mailbox passwords live in
  `mail_accounts`, encrypted with AES-256-GCM (`lib/crypto.js`). The
  `oauth_tokens` table is still there for Wave's OAuth when that lands.

Still to do before connecting real accounts:

- **Individual accounts**, if more than one person ends up using this —
  right now it's a single shared username/password in Railway Variables,
  fine for one user, not for a team.
- **Scope OAuth permissions for you.** When registering the app in
  Wave's developer portal, request only the accounting scopes you need.
- **Store secrets for you.** Put client IDs, client secrets, and any
  encryption key in Railway's **Variables** tab, never in the repo.
  Copy `.env.example` to `.env` for local dev and keep `.env` out of git
  (already in `.gitignore`).

None of this is exotic — it's the standard checklist for any small app
that touches email and financial data. Happy to help implement each
piece (the Graph/Wave OAuth flows, wiring up `oauth_tokens`) when you're
ready to build the real backend behind this front end.

## Structure

```
public/index.html   the app (dashboard, CRM, tickets, projects, finance, spec)
views/login.html     login form (served outside the auth gate)
views/book.html       public booking page (outside the auth gate)
views/cancel.html     public cancellation page (outside the auth gate)
server.js             Express server: session auth, rate limiting, static serving, mail routes
lib/db.js             Postgres connection pool
lib/migrate.js         creates the app's tables on startup
lib/crypto.js           AES-256-GCM helpers for encrypting credentials at rest
lib/mail.js             IMAP reading + SMTP sending
lib/calendar.js         calendar events + .ics feed generation
lib/calendly.js         Calendly API client + booking sync
lib/google.js           Google Calendar bridge (mirrors events so Calendly sees them)
lib/scheduling.js       booking pages: availability, slot maths, bookings
package.json
.env.example          placeholders for the secrets you'll need
```
