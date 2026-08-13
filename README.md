# Pocket Data Office

Internal ops app — dashboard, inbox, CRM, projects, service desk, files,
finance, and people — built to replace the earlier Notion-based mockup.
No Notion dependency, no AI-agent chat feature. Planned integrations:
two Outlook inboxes, Outlook Calendar, and Wave.

This repo currently ships the front-end mockup (`/public/index.html`) behind
a one-file Express static server, so it deploys to Railway as-is. The
`System spec` tab inside the app has the full data model and integration
plan for turning this into the real thing.

## Run locally

```bash
npm install
npm start
```

Visit `http://localhost:3000`.

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
3. Railway detects Node automatically via `package.json` and runs `npm start`.
4. Generate a domain (Settings → Networking → Generate Domain) once it's live.

Railway gives you HTTPS and network isolation on that domain by default.
Everything below is still on you.

## Security — do this before connecting real accounts

Railway's proxy secures the network path to your app. It does **not**:

- **Put a login in front of the app.** Right now the URL is open to
  anyone who has it. Add authentication (even a simple password gate to
  start, a real login later) before this holds real client data.
- **Store secrets for you.** Put client IDs, client secrets, and any
  encryption key in Railway's **Variables** tab, never in the repo.
  Copy `.env.example` to `.env` for local dev and keep `.env` out of git
  (already in `.gitignore`).
- **Encrypt tokens.** When you add Outlook and Wave OAuth, store the
  access/refresh tokens encrypted in your database, not as plain text.
  A leaked database backup is a much smaller problem if the tokens in it
  are useless without the encryption key.
- **Scope OAuth permissions for you.** When registering the app in
  Microsoft Entra (for Outlook/Calendar) and in Wave's developer portal,
  request only the specific mail/calendar/accounting scopes you need —
  not full directory or admin access.
- **Rate-limit or expire sessions.** Add session expiry and basic rate
  limiting on login and any API routes once there's a real backend.

None of this is exotic — it's the standard checklist for any small app
that touches email and financial data. Happy to help implement each
piece (auth, the Graph/Wave OAuth flows, encrypted token storage) when
you're ready to build the real backend behind this front end.

## Structure

```
public/index.html   the app (dashboard, CRM, tickets, projects, finance, spec)
server.js            minimal Express static server
package.json
.env.example          placeholders for the secrets you'll need
```
