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

## Outlook mail

Reads and replies to whatever mailboxes you connect, via Microsoft Graph
(delegated permissions: `Mail.Read`, `Mail.Send`, `offline_access`).

Setup:

1. Register an app in Microsoft Entra (portal.azure.com → Entra ID → App
   registrations), single tenant. Redirect URI (Web):
   `https://<your-domain>/auth/microsoft/callback`.
2. Add delegated Graph permissions `Mail.Read`, `Mail.Send`,
   `offline_access`, grant admin consent.
3. Create a client secret.
4. Set `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`, and
   `MS_MAILBOXES` (comma-separated list of the mailbox addresses you want
   connectable — anything not in this list is rejected) in Railway
   Variables.
5. In the app's top bar, click "Connect" next to each configured
   mailbox and sign in. Tokens are encrypted (`lib/crypto.js`) and stored
   in `oauth_tokens`, refreshed automatically via the stored refresh
   token — no need to reconnect unless a mailbox goes unused for ~90
   days (Microsoft expires unused refresh tokens).

`/auth/microsoft/start` only accepts an `account` value present in
`MS_MAILBOXES`, so the connect flow can't be pointed at an arbitrary
mailbox even by someone poking at the URL directly.

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
- **Encrypted token storage.** The `oauth_tokens` table (`lib/migrate.js`)
  and AES-256-GCM helpers (`lib/crypto.js`) hold Outlook mail tokens now;
  ready for Calendar and Wave when those land too.

Still to do before connecting real accounts:

- **Individual accounts**, if more than one person ends up using this —
  right now it's a single shared username/password in Railway Variables,
  fine for one user, not for a team.
- **Scope OAuth permissions for you.** When registering the app in
  Microsoft Entra (for Outlook/Calendar) and in Wave's developer portal,
  request only the specific mail/calendar/accounting scopes you need —
  not full directory or admin access.
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
lib/migrate.js         creates the oauth_tokens table on startup
lib/crypto.js           AES-256-GCM helpers for encrypting tokens at rest
lib/msgraph.js          Microsoft Graph OAuth + mail API calls
package.json
.env.example          placeholders for the secrets you'll need
```
