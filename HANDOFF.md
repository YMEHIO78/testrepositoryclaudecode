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
lib/projects.js        projects, tasks, milestone-to-calendar projection
lib/people.js          the team roster (no permissions - single shared login)
lib/packages.js        packages and quantities; client value is derived, never stored
lib/search.js          search over local records; deliberately excludes mail
lib/export.js          JSON backup export; strips credentials and file bytes
lib/files.js           file metadata in Postgres, bytes in object storage
lib/folders.js         the folder tree; deleting one reparents, never cascades
```

Tables: `session`, `mail_accounts`, `oauth_tokens`, `calendar_events`,
`app_settings`, `booking_event_types`, `booking_availability`, `bookings`,
`clients`, `contacts`, `tickets`, `ticket_events`, `projects`,
`project_tasks`, `project_milestones`, `people`, `project_people`,
`files`, `folders`, `packages`, `client_packages`. Full column-by-column notes in `docs/SCHEMA.md`.

## What is real vs. still mockup

**Real, working, backed by data:**
Dashboard · Inbox · Calendar (+ `.ics` feed) · Scheduling · CRM ·
Service Desk · Finance · Integrations · Projects · Files · People

**Still hardcoded mockup markup in `public/index.html`:**
System spec (a static reference page; nothing to wire up)

## Integrations

| Integration | State | Notes |
|---|---|---|
| Mail (IMAP/SMTP) | **live** | both mailboxes connected, pulling real mail |
| Calendly | **live** | polls every 5 min, bookings land on the calendar |
| Wave | **live** | via `WAVE_TOKEN` env var; business has 0 invoices so far |
| Google Calendar | built, unconnected | needs `GOOGLE_CLIENT_ID`/`SECRET`; optional |
| Outlook mail/calendar | **impossible** | see below |
| Files (Railway Buckets) | **live** | S3-compatible; `FILES_*` reference variables |

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

- **File storage landed on Railway Buckets, and the alternatives were
  checked, not guessed.** There is **no `pocketdataoffice.com` OneDrive** —
  the domain has no Microsoft tenant (same root cause as the Outlook dead
  end), the machine's `Business1` OneDrive registry key is empty and there
  is no `OneDrive - <Org>` folder. The user's *personal* OneDrive is
  Graph-accessible and was ruled out on principle, not capability: client
  files should not sit in a personal account. **Proton Drive has no public
  API** at all. Self-hosting (Nextcloud/MinIO on a VPS) works but adds a
  second server to patch, back up and pay for. Railway Buckets are
  S3-compatible, sit in the same project, and inject `FILES_*` as
  reference variables — no credentials pasted by hand. The price is no
  backup and no version history; see Outstanding work.

- **Railway's volume backups are Pro-gated; this workspace is on Hobby.**
  Creating, restoring, locking and scheduling a volume backup all return
  "Not Authorized" below Pro — Trial, Free and Hobby all carry a backup
  limit of zero, which is what `maxBackupsCount: 0` in the plan-limits API
  means. *Listing* and *deleting* existing backups are not gated, so a
  Hobby workspace can still see and remove any snapshots Railway created
  on its own (pre-patch, pre-HA-conversion), but cannot restore them. On
  Pro the limit becomes 10 backups per volume, with total backup storage
  capped at 50% of the volume's size.
- **Point-in-Time Recovery is probably Pro-only too, but this is inferred,
  not confirmed.** Railway's PITR docs state no plan requirement; the
  inference comes from PITR sharing the Pro-gated backup infrastructure.
  If the answer matters for a decision, confirm it in a Railway Help
  Station thread rather than trusting this note.
- **Storage Buckets have no backups on any plan.** No versioning, no
  object lock, no snapshots — this is a bucket-level gap, so upgrading to
  Pro does not fix it. Only a copy to a second provider does.
- **What that leaves on Hobby:** logical `pg_dump` backups against
  `DATABASE_PUBLIC_URL`, and a copy of bucket objects to somewhere else.
  Both have to be driven from outside Railway.

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
- **`list-variables` omits variables that are actually set.** It reported
  23 names for this service and left out all five `FILES_*` ones, which
  were live. Absence there is not evidence. Verify through the app itself
  (`/api/files/status`) or the Railway agent's service config.
- **Variable changes are staged, not live.** A genuinely new variable
  reaches the app only on the next deploy.
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

**Nothing is backed up — the biggest known hole:**
- **Files**: Railway Buckets have no backups, versioning or object lock on
  any plan. Deleting a file through the app is permanent.
- **Postgres**: Railway's volume backups are Pro-gated and this workspace
  is on Hobby, so there are no database snapshots either. Every client,
  ticket, project and person record has exactly one copy. See the settled
  facts above for what the plan does and does not allow.
- Mail is safe (it lives on Hostinger's IMAP server, not here) and the
  code is on GitHub. Everything else is single-copy.
- **A manual JSON export now exists** at Back office → Backup, covering
  every database table. It excludes credentials by design and does NOT
  include file bytes - see the Backup section of the README.
- Still missing: a **scheduled off-site copy** of both the database and
  the bucket objects to a second S3-compatible provider (Backblaze B2 or
  Cloudflare R2 - the same `@aws-sdk/client-s3` code works against
  either). The manual button only protects you as often as it is pressed,
  and nothing protects the bucket. **Not built.**

**Feature gaps in what already works:**
- Inbox: forward, reply, search, pagination and attachment downloads all
  work. No labels or folders beyond the inbox itself.
- Unread counts come from IMAP `STATUS (UNSEEN)`, so they are true
  mailbox-wide totals.
- Wave: invoices only; expenses are not pulled.
- Files: folders, folder upload, per-client browsing and moving a file
  between folders all work. Still missing: per-file preview and
  drag-and-drop onto the page.
- People: deliberately has **no** access or permission column. The app has
  a single shared login; a permission field would imply enforcement that
  does not exist.

**Not built at all:** nothing major — every navigation item now has a
backing data model except the static System spec page.

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
