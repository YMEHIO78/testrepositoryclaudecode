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

`source` on each event marks where it came from (`manual` today). When
Tickets and Projects become real database records, their dates can be
written in as `ticket`/`project` rows and will appear on the grid and in
the feed with no further changes.

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
server.js             Express server: session auth, rate limiting, static serving, mail routes
lib/db.js             Postgres connection pool
lib/migrate.js         creates the app's tables on startup
lib/crypto.js           AES-256-GCM helpers for encrypting credentials at rest
lib/mail.js             IMAP reading + SMTP sending
lib/calendar.js         calendar events + .ics feed generation
package.json
.env.example          placeholders for the secrets you'll need
```
