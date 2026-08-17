# Pocket Data Office — handoff

State of the project as of 17 August 2026. Written so a new session can
pick up without re-deriving anything. No secret values appear here; they
are referenced by variable name only.

## Where it lives

| | |
|---|---|
| Live app | https://pocket-data-office-production.up.railway.app |
| Repo | https://github.com/YMEHIO78/testrepositoryclaudecode (branch `main`) |
| Local working copy | `C:\Users\Yosef (Work)\Downloads\pocket-data-office` |
| Railway project | `pocket-data-office` — `de36a981-e4ac-4b4f-8926-3319d1b0c683` |
| Railway service | `24ed1c72-0af5-4dc6-bee4-ea4abdaee4ad` |
| Railway environment | production — `a6dba5b4-0a60-40c4-8103-21bd83791297` |
| Postgres service | `360545cc-55e7-4345-a94b-9bf57b9a787f` |

Login is a single shared account (`AUTH_USER` / `AUTH_PASS`), session-based,
rate-limited to 10 failed attempts per IP per 15 minutes.

## Stack

Plain Node + Express + Postgres. No framework, no build step, no
Railway-specific APIs — it would move hosts with a config change.

```
server.js              all routes: auth, mail, calendar, scheduling, CRM, tickets, Wave
public/index.html      the entire front end (one file: markup, CSS, JS)
views/login.html       login form            (outside the auth gate)
views/book.html        public booking page   (outside the auth gate)
views/cancel.html      booking cancellation  (outside the auth gate)
lib/db.js              Postgres pool
lib/migrate.js         creates every table on boot (idempotent)
lib/crypto.js          AES-256-GCM helpers for credentials at rest
lib/mail.js            IMAP read + SMTP send
lib/calendar.js        events + .ics feed generation
lib/scheduling.js      booking pages: availability, slot maths, bookings
lib/calendly.js        Calendly API client + booking sync
lib/google.js          Google Calendar bridge (built, unconnected)
lib/crm.js             clients, contacts, inbox sender matching
lib/tickets.js         service desk + SLA-to-calendar projection
lib/wave.js            Wave GraphQL client (invoices)
```

Tables: `session`, `mail_accounts`, `oauth_tokens`, `calendar_events`,
`app_settings`, `booking_event_types`, `booking_availability`, `bookings`,
`clients`, `contacts`, `tickets`.

## What is real vs. still mockup

**Real, working, backed by data:**
Dashboard · Inbox · Calendar (+ `.ics` feed) · Scheduling · CRM ·
Service Desk · Finance · Integrations

**Still hardcoded mockup markup in `public/index.html`:**
Projects · Files · People · System spec

Each remaining one needs a new data model, not a restyle. Files
additionally needs a storage integration (OneDrive was the original idea).

## Integrations

| Integration | State | Notes |
|---|---|---|
| Mail (IMAP/SMTP) | **live** | both mailboxes connected, pulling real mail |
| Calendly | **live** | polls every 5 min, bookings land on the calendar |
| Wave | **live** | via `WAVE_TOKEN` env var; business has 0 invoices so far |
| Google Calendar | built, unconnected | needs `GOOGLE_CLIENT_ID`/`SECRET`; optional |
| Outlook mail/calendar | **impossible** | see below |
| OneDrive / Files | not started | |

### Facts that cost real time to establish — do not re-litigate

- **This domain is not on Microsoft 365.** MX for `pocketdataoffice.com`
  points at `mx*.hostinger.com`, and Microsoft's directory lookup returns
  `NameSpaceType: Unknown`. Graph can only reach Exchange Online
  mailboxes, so Outlook mail *and* Outlook Calendar are permanently out,
  regardless of app registration. Mail runs on IMAP/SMTP instead. There is
  also no CalDAV endpoint on the domain (no `_caldav` SRV records), which
  is why the calendar is native.
- **Calendly's availability API is read-only.**
  `/user_availability_schedules`, `/user_busy_times`,
  `/event_type_available_times` are all GET. Blocked time cannot be pushed
  into Calendly. That is the entire reason `lib/google.js` exists: Calendly
  checks calendars it is connected to, and cannot read our `.ics` feed, so
  mirroring events into Google is the only way to stop it double-booking.
  The built-in scheduler does not have this problem — it computes slots
  against `calendar_events` directly, so double-booking is impossible by
  construction.
- **Wave uses a Full Access Token, not OAuth.** OAuth requires the *end
  user's* business to be on a paid tier; a full access token does not.
  Two schema quirks, both confirmed by introspecting the live endpoint
  (which allows unauthenticated introspection — use it rather than
  guessing): Wave **rejects inline string arguments**, everything must go
  through GraphQL variables; and `businesses` is a **root** field, not a
  field on `User` (`User` exposes only `id`, `defaultEmail`, names).
  `Money.minorUnitValue` is already in cents, matching the app's
  convention everywhere.

## Design decisions worth preserving

- **Money is integer cents** throughout, entered as dollars in the UI.
- **Gaps are shown as blanks, never estimates.** The dashboard's expenses
  row and anything without a data source renders `—` with a note saying
  why. Plausible-looking invented figures on a panel someone acts on are
  worse than an obvious hole.
- **Credentials are validated before being stored.** Mail, Calendly and
  Wave all test against the real service on connect, so a bad value fails
  immediately with the provider's own error instead of producing a
  silently empty view.
- **Synced records are read-only locally.** Calendly bookings and
  ticket-SLA calendar entries reject edits with a 409, because the next
  sync would overwrite them.
- **HTML email renders in a `sandbox` iframe** — no script execution, no
  reach back into the app.
- **Booking confirmations send after the HTTP response**, not before, with
  SMTP timeouts. Blocking on SMTP left people staring at a spinner after
  their booking had already committed, inviting duplicates.
- **Booking slots are re-checked inside a `SERIALIZABLE` transaction** at
  confirm time, closing the race between loading slots and booking one.
- **Buffers pad both sides** — the candidate slot *and* existing events.
  Padding only the candidate let a meeting start the instant another
  ended, which made buffers meaningless.

## Operational gotchas

- **Deploy by commit SHA.** Railway's plain "redeploy" rebuilds the *old*
  commit. Use the `railway-agent` MCP tool: *"Deploy commit `<sha>` for
  service 24ed1c72-…"*. Pushing to GitHub alone does **not** reliably
  trigger a deploy.
- **Builds take about 3 minutes.** Do not read slowness as failure.
- **`get-logs` returns empty while a build is in progress.** This is not
  evidence of a hang — it misled twice in one session, once causing a
  redundant deploy. The Railway agent's own log search does return logs.
- **No Node, npm, `gh`, or `railway` CLI on the dev machine.** No local
  syntax checking or testing — the deploy *is* the test. Perl is
  available; Python is only a Windows Store alias and does not work.
- **The Windows shell mangles non-ASCII in command arguments.** Testing
  UTF-8 by passing characters through `curl -d` produces false corruption
  reports; write the payload to a file and use `--data-binary @file`.

## Outstanding work

**Security debt (do this first — the app now holds live client mail):**
- Rotate `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `AUTH_PASS` in the
  Railway dashboard. **The user should do this, not the assistant** —
  anything the assistant generates lands in a chat transcript.
- Rotating `TOKEN_ENCRYPTION_KEY` makes stored mailbox credentials
  undecryptable; both mailboxes need reconnecting afterwards. It does not
  affect `WAVE_TOKEN`, which lives in the environment, not the database.
- Delete the unused `MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_TENANT_ID` /
  `MS_MAILBOXES` variables and the Microsoft Entra app registration.
- Consider rotating `WAVE_TOKEN` — it grants access to *every* business on
  the Wave account (including "Personal") and cannot be scoped down.

**Feature gaps in what already works:**
- Inbox: no search, no pagination (25 most recent per mailbox), no
  attachment downloads (they are listed but not fetchable), no forward.
- Unread counts are "unread within the recent window", not true
  mailbox-wide totals.
- Tickets: no detail page, no activity log.
- CRM: no client detail page (the reference design has one, with linked
  tickets, projects, invoices and emails).
- Wave: invoices only; expenses are not pulled.

**Not built at all:** Projects, Files, People.

## Design reference

The user supplied a design file at
`C:\Users\Yosef (Work)\OneDrive\PDO\Pocket Data Office.html`. It is a
self-extracting bundle — the real markup is a JSON-encoded string inside
a `<script type="__bundler/template">` tag and must be decoded (perl +
`JSON::PP`) before it can be read.

**Important:** it contains a `:root` stylesheet with a teal palette that
is **never used**. The rendered design comes from ~1,134 inline styles.
The palette that actually applies:

```
background  #faf7f0   surface  #fffdf8   sidebar  #f0ebe0
text        #201e1d   accent   #1800ad   urgent   #a90b56
muted greys #605d5d #7d7979 #8a8683 #9b9797
hover       #e6e0f7   radius   1 / 2 / 4px
font        "Source Serif 4", Georgia, serif   body 15px/1.55
spacing     5 / 10 / 15 / 20 / 30 / 40px
```

The app now matches this. Create and edit flows open in centred modal
dialogs (backdrop, Escape-to-close, focus handling). The reference also
includes an "AI Agent" view — **do not build it**; the project README
explicitly rules out an AI-agent chat feature.
