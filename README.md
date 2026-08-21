# Pocket Data Office

Internal ops app — dashboard, inbox, calendar, scheduling, CRM, projects,
service desk, files, finance, and people — built to replace the earlier
Notion-based mockup. No Notion dependency. It does now have an AI
assistant - see the Assistant section - which can read your records and
propose changes, but never applies one without your approval.

Every view is backed by real data now; only the `System spec` tab is
still a static reference page. Mail runs on IMAP/SMTP (Outlook was ruled
out — see `HANDOFF.md`), the calendar and booking pages are native, files
live in S3-compatible object storage, and accounting comes from Wave.

The whole thing sits behind an Express login gate — session-based auth
backed by Postgres, rate-limited against brute force. There is one shared
login; there are no per-user accounts or permissions anywhere in the app.

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

## Service desk

Real tickets, raised by hand or created from an email.

- **Reference numbers** (`TKT-101`…) come from their own Postgres
  sequence rather than the primary key, so they stay stable and readable.
- **SLA dates are projected onto the calendar** as `source='ticket'`
  events, which is what makes the "SLA due — TKT-118" line real. Move the
  date and the calendar entry moves; resolve or close the ticket and it
  disappears; clear the date and it's removed. If the calendar entry gets
  deleted behind the app's back, the next save recreates it rather than
  silently losing the deadline.
- **Tickets link to a client** from the CRM, and to the email they came
  from (account + UID) so a ticket can be traced back to its source.
- Overdue and due-within-24h SLAs are colour-coded in the list.

## Projects

One project per package sold, hanging off a client. Each has a kanban
board (drag cards between columns, or click one to edit), milestones,
and a view of the client's tickets and Wave invoices.

**Milestones project onto the calendar** exactly as ticket SLAs do: a
dated, still-pending milestone on a live project shows as an all-day
entry and flows into the `.ics` feed. Mark it hit or missed, or finish
the project, and it disappears. That is what makes the mockup's
"Marlowe milestone" line real.

**Spend is entered by hand.** There is no time tracking or expense feed
behind it, so a derived figure would be invented - the page says so.

Deleting a project cascades to its tasks and milestones, and explicitly
clears their calendar entries first; the cascade alone would leave
deadlines behind for a project that no longer exists.

## People

You plus contractors: role, engagement type, hourly rate, active flag,
and which projects they are on. Assign people to a project from the
project page.

**No access control is implied or provided.** One shared login means
everyone who can sign in sees everything, CRM and Finance included. This
page records who your people are and what they cost - it restricts
nothing. The mockup had an "Access" column claiming contractors were
scoped to their projects; that was not reproduced because it would assert
a security boundary that does not exist. Scoped access needs real
per-user accounts first.

## Files & Folders

Metadata lives in Postgres, the bytes live in S3-compatible object
storage — Railway Buckets, which run on Tigris. Tag a file to a client or
project and it surfaces from their page.

Setup is just the `FILES_*` variables; on Railway they come from the
bucket as reference variables, so nothing is pasted by hand. Uploads are
disabled and the UI says so if they're missing.

The bucket is `pdo-files` in the same project. Its own variable names are
short, and the service maps them across:

```
FILES_BUCKET            ${{pdo-files.BUCKET}}
FILES_ACCESS_KEY_ID     ${{pdo-files.ACCESS_KEY_ID}}
FILES_SECRET_ACCESS_KEY ${{pdo-files.SECRET_ACCESS_KEY}}
FILES_REGION            ${{pdo-files.REGION}}
FILES_ENDPOINT          ${{pdo-files.ENDPOINT}}
```

A new variable only reaches the running app on the next deploy. And do
not trust Railway's `list-variables` API to tell you whether one is set —
it omitted all five of these while they were live. Check
`/api/files/status`, which does a `HeadBucket` with the real credentials.

Decisions worth keeping:

- **Uploads and downloads both stream through the app**, not via
  presigned URLs. A presigned URL works for anyone holding it; routing
  through the app keeps every byte behind the login.
- **Object keys are random UUIDs**, never derived from the filename. A
  user-supplied name in a key invites path traversal and collisions. The
  real name is just a column.
- **Uploads arrive as a raw body**, not multipart — the browser POSTs the
  `File` directly and the server reads it with `express.raw`, which
  avoids a multipart parser and its dependency entirely.
- **Delete removes the object first, then the row.** An orphaned object
  is wasted pennies; an orphaned row is a download that 500s.
- Downloads force `Content-Disposition: attachment` with `nosniff` and a
  sanitised filename, same as mail attachments — stored files are
  untrusted content.

### Folders

The Files view is a folder browser showing one level at a time, and the
client selector narrows the scope rather than switching modes:

- **All clients** — the top level is every client's folders at once, plus
  any file not in a folder. Folder rows show which client they belong to.
  This is what you want when you do not remember whose file it was.
- **A client selected** — the same browser narrowed to that client.

An earlier version made "All clients" a flat list of every file with no
folders shown at all. It looked like the folders had vanished unless you
first picked the right client, so it is now a real root. A smoke test
covers it.

You can create folders in the app, nest them up to ten deep, rename them,
and upload straight into whichever one you're looking at. **Upload folder**
picks a directory off your machine and recreates its structure here.

How the folder upload works: the browser hands each file a
`webkitRelativePath` like `Marlowe/2026/report.pdf`. The client sends the
directory part as `?path=` alongside the file, and the server builds the
chain, reusing any folder that already exists. That means the browser
does not have to make a round of folder calls first and then upload
against ids, and re-uploading the same folder does not stack duplicates.

Uploads run **sequentially**, one request per file, each carrying a whole
body. Firing hundreds in parallel would only queue in the browser and
make failures harder to attribute. Partial failure is reported honestly —
"41 uploaded, 6 failed" with the reasons — because a connection dropping
halfway through a large folder is the normal bad case, not an edge case.

**Deleting a folder does not delete files.** Its contents move up a level
instead. Given that nothing here is backed up, one click should not be
able to destroy a client's documents; the confirm dialog says so, and a
smoke test asserts the file is still downloadable afterwards.

Folder names are sanitised on the way in — they come from directory names
on someone's disk, which is untrusted input. Control characters are
dropped and path separators become dashes, so a name can never be read as
a path.

### The backup gap — read this before trusting it with client work

Railway Buckets have **no automatic backups, no versioning, and no object
lock** (their docs state this). Deleting a file through this app is
permanent, and there is nothing to restore from.

That is the known, accepted weakness of this choice. Nextcloud or Google
Drive would have given version history for free; object storage does not.
If these files start mattering, the fix is a scheduled copy to a second
provider (Backblaze B2 or Cloudflare R2 — both S3-compatible, so the same
client code works). That job is **not built yet**.

Storage is cheap enough that keeping a second copy is a rounding error;
see the cost breakdown below.

### What it costs

Storage is **$0.015 per GB-month**, and a fractional total rounds *up* to
the next whole GB-month — 5.1 GB-month bills as 6. So any stored bytes at
all cost at least $0.015/month. All S3 API operations are free and
unlimited, and so is egress *from the bucket*.

Egress *from a service* is not free — it is $0.05/GB — and that is worth
understanding given the proxy design above. Buckets are not on Railway's
private network, so:

- **Upload**: browser → app → bucket. The app-to-bucket leg is service
  egress, billed.
- **Download**: bucket → app is free (bucket egress), but app → browser
  is service egress, billed.

Presigned URLs would avoid both legs. That is the price of keeping every
byte behind the login, and at this app's volumes it is a rounding error —
a gigabyte moved in each direction costs about a dime. It would stop being
a rounding error if files were ever served at scale to the public, which
is not what this is for.

Plan limits: Railway's plan-limits API reports this workspace as **Hobby**
($5/month of included usage), though the owner believes it is on the Free
plan. Worth confirming in the dashboard, because the two plans behave
very differently when usage runs out — see below. Hobby's enforced
ceiling is **50 GB of bucket storage across the workspace**, with 3
buckets per project. (The public docs page says Hobby allows 1 TB; the API reports 50
GB as the actual enforced limit for this account. Trust the API.) At the
ceiling the bucket could cost at most $0.75/month, and Hobby already
includes $5/month of usage, so realistically this line never shows up.

On the **Free** plan the allowance is 10 GB-month, bucket usage counts
against a $1 monthly credit, and **access is suspended once that credit is
spent** — every stored file becomes unreadable until the next billing
cycle. They are not deleted, but the Files view goes dark. If this app is
really on Free, that is a live operational risk, not a theoretical one.

## Detail pages

Clicking a row in **CRM** or **Service Desk** opens a detail page rather
than the edit modal; **Edit** on that page opens the modal, and saving
refreshes the page underneath.

**Client detail** aggregates from four sources: the client record, its
tickets, recent mail from any contact address (an IMAP search, so it
reaches mail that was never downloaded), and Wave invoices. Each source
is wrapped separately - a slow mail search or a Wave outage degrades one
section and reports a warning instead of failing the page.

Wave has no link to these client records, so invoices are matched on
**customer name**. That is imperfect and the page says so.

**Ticket detail** shows the description, an activity log, the linked
client, and a link back to the originating email when the ticket came
from one.

## Inbox

Beyond listing mail, a message can be opened and worked on:

- **Full body**, plain text or original HTML. HTML renders in a
  `sandbox`-attribute iframe — remote mail carries scripts and trackers,
  and sandboxing means none of it executes or can reach back into the
  app.
- **Reply** with the original quoted underneath.
- **Mark read/unread**; opening a message marks it read like any mail
  client.
- **Delete** moves the message to the server's Trash folder (found via
  its `\Trash` special-use flag) rather than setting `\Deleted`, so it
  stays recoverable from any mail client. Falls back to the flag if no
  Trash folder is advertised.
- **Add as client** creates a CRM client plus a contact from the sender
  in one step — after which their mail is labelled automatically.
- **Create ticket** opens a ticket pre-filled with the subject and body,
  linked to the sender's client if they're known, with an SLA date that
  lands on the calendar.

- **Forward** to any address, with the original quoted. Attachments are
  *not* carried across — only text — and the dialog says so.
- **Download attachments** from the links in the message header.

Message bodies are fetched only when a message is opened. Downloading
bodies for the whole list would make the inbox crawl, so the list query
stays on envelope data.

### Search and paging

Search is handed to the **IMAP server**, not filtered locally — the
point is to reach mail that was never downloaded. It matches subject,
from, to and body, and is debounced so typing doesn't fire a search per
keystroke.

Paging walks backwards from the newest message in pages of 25.
**Newer/Older** controls sit under the list.

Unread counts come from IMAP's `STATUS ... (UNSEEN)`, so they are true
mailbox-wide totals rather than "unread among what happens to be
loaded". The dashboard's preview list uses a snapshot of the unfiltered
first page, so paging or searching in the Inbox doesn't make the
dashboard show search results.

### Attachment downloads

`GET /api/inbox/attachment?account=&uid=&index=` re-fetches and re-parses
the message to pull one attachment out. That is slower than caching, but
attachments are rare and a cache would need eviction and its own bugs.

Downloads are forced with `Content-Disposition: attachment` plus
`X-Content-Type-Options: nosniff`, and the filename is stripped of
anything path-like. Mail attachments are untrusted; letting the browser
render one inline would run it in the app's own origin.

## Assistant (AI agent)

A chat that reads this app's records to answer questions, and can propose
changes to them. **The README used to rule this out**; that decision was
overturned deliberately, and what survives from it is the safety model
below.

Set `ANTHROPIC_API_KEY` in Railway to switch it on. Without it the view
says so and the chat is disabled — nothing else in the app depends on it.

### The safety model — read this before extending it

**Read tools execute immediately. Write tools never execute at all.**

A write tool does not touch the database. It writes a row to
`agent_actions` with status `pending` and the turn ends. Nothing changes
until a human opens the approval queue and approves that row. Approving is
the only code path by which anything the assistant proposes reaches your
data.

The queue is a **table**, not an in-process callback, because approval
happens in a later HTTP request — possibly minutes later, possibly after a
reload, possibly never. A promise waiting on a click survives none of that.

There are exactly two kinds of tool and no third case:

| | Tools | Behaviour |
|---|---|---|
| Read | `search_records`, `get_client`, `list_open_tickets` | Run on request; results go straight back to the model |
| Write | `create_ticket`, `update_ticket`, `create_client`, `update_client` | Queue a proposal; return "queued for approval" |

**Do not add a tool that writes directly.** If a new capability needs to
change data, it belongs in `WRITE_TOOLS` with a `summarise` function — that
one line is what a human reads when deciding, so it has to say what will
actually happen.

### Other decisions

- **Approval is idempotent.** The status flips inside the same statement
  that claims the row, so a double-click matches no pending row the second
  time and cannot create two tickets. The UI also disables the buttons on
  click — the server guard shouldn't be the only thing standing between an
  impatient click and duplicate data.
- **Tool calls are shown in the transcript**, not hidden. Seeing which
  records it read is how you judge whether to trust the answer.
- **Turns are capped** at 8 model round trips. A confused loop bills until
  something stops it.
- **Refusals are handled before reading content.** Opus 5's classifiers can
  decline with an empty content array; indexing into it would throw rather
  than explain. Server-side fallbacks are enabled, so a declined request
  re-runs on Anthropic's recommended fallback instead of failing.
- **Spend is visible in the UI.** Token counts are stored per message and
  the view shows a running dollar estimate at list prices. A feature that
  costs money per use should say what it has cost.

### What leaves the app

Whatever the assistant reads in order to answer — client names, ticket
text, meeting titles, package prices — is sent to Anthropic's API. That is
a new data processor alongside Railway, Hostinger, Wave and Calendly, and
worth knowing about for a consultancy handling client material. The note
under the chat says so in the UI rather than only here.

Mail bodies are **not** currently exposed to it: there is no read tool for
the inbox. Adding one would mean client correspondence leaving the app, so
it is a deliberate omission rather than an oversight.

## Backup

**Back office → Backup** downloads every database record as one JSON
file. It exists because this app has no automatic backups at all:
Railway's volume snapshots are a Pro feature and this workspace is on
Hobby, so nothing is being kept anywhere else.

The page shows a row count per table before you download, so you can see
what you are getting.

### What it does not cover — read this before trusting it

- **File contents.** The export includes the `files` table — names,
  sizes, which client and folder each was filed under — but **not the
  stored bytes**. Object storage has no versioning on any plan, so
  uploaded files still have exactly one copy. A restore from this export
  would rebuild the index and point at objects that might not be there.
- **Mail.** It lives on the mail server and was never ours to lose.

### What is deliberately excluded

`mail_accounts` and `oauth_tokens` hold encrypted secrets, and
`app_settings.calendar_feed_token` is a credential in its own right. All
three are stripped.

The reasoning: their encryption key is an environment variable, so a file
combining the ciphertext with anything that could sit alongside the key
is a worse thing to have on a laptop than no file at all. Smoke tests
assert none of the three appear in the output — that check is the point,
not a formality.

### What this still does not solve

This is a manual button. It protects you only as often as you press it,
and it does nothing for the bucket. The remaining gap is a scheduled
copy of both database and objects to a second provider (Backblaze B2 or
Cloudflare R2 — both S3-compatible, so `lib/files.js` already speaks the
protocol). **Not built.**

## Packages

What you sell and what a unit of it costs. **A client's value is the sum
of unit price times quantity across their packages** — it is not typed in
anywhere, and the Value field that used to be in the client editor is
gone.

On a client's page, a **Packages & quantities** section shows a row per
package with a −/+ stepper, a subtotal, and a total labelled Client
value. This is the design reference's model, and its caption there says
it plainly: quantities drive the contract value.

Seeded once with the reference's three — Manual Data at $220 per batch of
500 records, Data Warehousing at $4,200 per environment per quarter, Data
Analysis at $950 per analysis workstream. **Edit them under Back office →
Packages**; they are not hardcoded. A price change is a business event,
not a deploy.

Decisions worth keeping:

- **The value is computed on read, never stored.** A cached total needs
  invalidating on every price change, and the first missed invalidation is
  a wrong number on an invoice. The flip side is that repricing a package
  moves every client carrying it, immediately — that is intended, and the
  editor warns you when the package is in use.
- **The stepper sends an absolute quantity, not a delta.** A double click
  or a retried request cannot compound into money nobody chose.
- **The server returns the recalculated set and the browser paints from
  it.** The front end never computes a figure it then displays as
  authoritative.
- **A package on a client retires rather than deletes.** Deleting would
  cascade its quantities away and silently reduce that client's value.
  Retiring hides it from new work and leaves every existing figure alone.
  A package nothing references deletes outright.
- **Seeding is guarded by a flag, not by an empty table.** Deliberately
  deleting every package is a legitimate state and must not be undone on
  the next boot.

The old typed value survives as `legacyValueCents` and is shown on the
client page until quantities replace it, so nothing vanished on deploy
day. See `docs/SCHEMA.md`.

## Clients & Leads

Real clients and contacts, replacing the mockup table. Built first
because everything else references a client — tickets, projects, and
invoices would otherwise need a fake client link that got rewritten
later.

The module is called **Clients & Leads** in the UI, but the code keeps
the shorter internal name: `lib/crm.js`, the `/api/crm/*` routes, and the
`crm` view id. Renaming those would be churn with no reader on the other
end, so expect both names and treat them as the same thing.

- **Clients** move through a pipeline: In contact → Engaging → Offer sent
  → Client, plus Lost. Value is stored in cents (exact totals, no float
  drift) and can be flagged recurring monthly.
- **Contacts** belong to a client; one is primary. Setting a new primary
  clears the old one on write rather than via constraint, so switching is
  a single action.
- **Inbox linkage.** Mail from an address matching a known contact is
  labelled with that client in the Inbox, automatically. That lookup is
  wrapped so a CRM failure can't take the inbox down with it.

Money handling note: amounts are entered in dollars in the UI and stored
as integer cents.

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
  booking row is kept, marked cancelled, as a record. Either side can
  cancel: the invitee via the link in their confirmation email, or you
  via **Cancel** on the Scheduling page (for when someone cancels by
  phone instead). Owner-side cancellation does not email the invitee —
  tell them yourself.
- **Booking-created events are read-only on the calendar** like other
  synced events, so they can't be edited into an inconsistent state.
  Cancel them through Scheduling rather than deleting the calendar entry.

## Wave (accounting)

Reads invoices from Wave into the **Finance** view and the dashboard's
cash panel. **Read-only** — nothing is ever written back to Wave.

Connect under **Integrations** with a **Full Access Token** from Wave's
Developer Portal (Manage Applications), or set `WAVE_TOKEN` in Railway
to keep it out of the browser. If several businesses are visible, pick
which one to read.

**Why a token rather than OAuth:** Wave's OAuth flow requires the end
user's business to be on a paid plan (Pro or Wave Advisor). A Full
Access Token reads your own business without that. If your plan does
block it, the connect dialog surfaces Wave's own error rather than
failing silently.

Implementation notes:

- Query shapes were confirmed against Wave's live schema by
  introspection rather than guessed. Two things that matter: Wave
  **rejects inline string arguments** (everything must go through
  GraphQL variables), and `Money.minorUnitValue` is already in cents,
  which matches how this app stores money everywhere else.
- Statuses come from Wave's `InvoiceStatus` enum (`DRAFT`, `SENT`,
  `VIEWED`, `PARTIAL`, `UNPAID`, `OVERDUE`, `PAID`, `OVERPAID`,
  `SAVED`).
- **Expenses aren't pulled**, only invoices — so the "Expenses this
  month" row stays blank rather than being estimated.

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

## Documentation

- `CLAUDE.md` - how to work in this repo (deploys, conventions, constraints)
- `HANDOFF.md` - current state, outstanding work, project IDs
- `docs/SCHEMA.md` - tables, relationships, and what will bite
- `docs/DESIGN.md` - the design system, extracted from the reference
- `scripts/smoke-test.sh` - regression checks for paths that broke before

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
lib/crm.js              clients, contacts, and inbox sender matching
lib/tickets.js          service desk, including SLA-to-calendar projection
lib/wave.js             Wave GraphQL client: invoices into Finance
lib/projects.js         projects, tasks, milestone-to-calendar projection
lib/people.js           the team roster
lib/packages.js         service packages; client value is derived from these
lib/search.js           search across local records (not mail)
lib/export.js           the JSON backup export; excludes credentials
lib/agent.js            the AI assistant and its approval queue
lib/files.js            file metadata in Postgres, bytes in object storage
lib/folders.js          the folder tree; deleting one reparents, never cascades
scripts/smoke-test.sh   regression checks against a running instance
docs/SCHEMA.md          tables and relationships
docs/DESIGN.md          design tokens and layout specs
CLAUDE.md               working notes for Claude Code
package.json
.env.example          placeholders for the secrets you'll need
```

## Diagrams (draw.io)

Diagrams live on each client's detail page, in their own section above
Files. Clicking one opens a full-page editor at `/diagram/:id`; "New
diagram" creates one already filed under that client.

**There is no diagrams table.** A diagram is a `.drawio` file in the
`files` table like any other, which is what lets it inherit folders,
client filing, move, delete and the backup export without a line of
extra code. `lib/diagrams.js` is a lens over `lib/files.js`, not a
parallel store. The client detail endpoint splits them out of the Files
list so they are not listed twice.

### Why the editor is embedded rather than a link to draw.io

This was the whole design question, because the two obvious wants pull
against each other: *click a diagram and be taken to draw.io*, and *save
straight back into a client's folder*.

You cannot have both by linking out. app.diagrams.net saves to a fixed
list of backends — Google Drive, OneDrive, Dropbox, GitHub, GitLab,
Bitbucket, the local device — and there is no supported way to add a
seventh. Send someone there and the diagram can come back only by being
downloaded and re-uploaded by hand.

Embed mode inverts that relationship. `embed.diagrams.net` holds no
storage of its own: it takes the XML from the page that framed it and
posts the XML back on save (`{event:'save', xml}`), leaving the host to
decide where that goes. So the app becomes the storage backend, and
"save into a client's folder" is the normal case rather than a feature
draw.io would have to support. The editor is served full-page instead of
in a modal so it still *feels* like going to draw.io.

The protocol is in `public/diagram.html`:

| Direction | Message |
| --- | --- |
| iframe → app | `{event:'configure'}`, `{event:'init'}`, `{event:'save', xml}`, `{event:'autosave', xml}`, `{event:'exit'}` |
| app → iframe | `{action:'configure', config}`, `{action:'load', xml, autosave:1}`, `{action:'status', message, modified}` |

Autosaves are coalesced (2.5s) because every save is a bucket write.
Explicit saves go straight through. A failed save says so and leaves the
state dirty — the editor still holds the work, so claiming "saved" would
be the one genuinely dangerous lie this page could tell.

### What is checked, and what is trusted

- `message` handlers drop anything whose `evt.origin` is not
  `https://embed.diagrams.net`. Without that, any page that got itself
  framed here could push XML at us and have it written to the bucket.
- `configure` sets draw.io's `lockdown` option, which disables
  transmission other than between the browser and the storage it was
  handed — that is this app.
- `GET /api/diagrams/:id` 404s for a file that exists but is not a
  `.drawio`. The editor route hands bytes to a third-party iframe, so it
  must not double as a general file reader.

Still true regardless: the editor is third-party JavaScript running with
access to the diagram. The XML moves by `postMessage` and stays in the
browser by design, but draw.io's docs make no claim either way about
what their editor transmits, so this is a stated intention rather than
something the app can enforce. Self-hosting `jgraph/drawio` as another
Railway service is the only way to make it a guarantee; `EDITOR_ORIGIN`
and `EDITOR_URL` in `public/diagram.html` are the only two lines that
would change.

### Known limits

- **No thumbnails.** Rendering a `.drawio` to PNG or SVG server-side
  needs draw.io's separate export server. Previews would have to be
  produced in the browser at save time.
- **No offline editing.** If `embed.diagrams.net` is unreachable the
  page loads and the diagram does not.
- **No revision history.** Saving overwrites in place, deliberately —
  the alternative buries the folder in near-identical copies. The bucket
  has no versioning, so there is no undo beyond draw.io's own.

### Spam and blocked senders

The Inbox has a **Spam** tab next to the account tabs, and every message
carries **Mark spam** and **Block sender**.

**Read this before trusting the word "block".** These are two different
promises and only one of them is kept here:

- **Mark spam** is real and server-side. The message is moved to the
  mailbox's Junk folder over IMAP, so it leaves the inbox everywhere —
  webmail, phone, any other client. The unread badge follows on its own,
  because that count comes from an IMAP `STATUS (UNSEEN)` on `INBOX`.
- **Block sender** is a rule *this app* applies when it fetches. It is
  **not** a block at the mail server. The message is still accepted,
  still delivered, still counts against the mailbox quota; this app just
  files it to Junk on sight. If the app never runs, nothing is filed.
  Real blocking would need a Sieve rule or a filter in Hostinger's
  control panel, neither of which exposes an API we can drive.

Filing happens during `GET /api/inbox`: the page is fetched, matched
against the blocklist, and matches are moved in **one** IMAP call rather
than one per message. The response reports `filed` so the UI can say what
disappeared — mail vanishing from a page with no explanation is
indistinguishable from a bug.

A pattern is either a full address (`someone@example.com`) or a domain
with a leading `@` (`@example.com`), stored lowercased. Anything else is
rejected rather than stored, because a blocklist entry that silently
matches nothing is worse than one that refuses to be created.

**Not spam** moves the message back to `INBOX` *and* unblocks the sender.
Doing only the first would re-file it on the next fetch, which looks
exactly like a broken button.

### Why the Junk folder is discovered, not named

The same folder is `Junk` on one server, `Spam` on another and
`INBOX.spam` on a third. `specialUseFolder()` asks the server via the
IMAP SPECIAL-USE extension (`\Junk`, `\Trash`) and only falls back to
matching common names if the server advertises nothing. A hard-coded
name silently creates a folder nobody ever looks in.

Two consequences:

- A mailbox with no Junk folder cannot mark spam at all. It says so
  rather than inventing one.
- The Spam view shows the **whole** Junk folder, including whatever your
  provider's own filter put there. That is deliberate — the point of the
  view is to see what was caught, not to see only what this app caught.

Opening a message in Junk does **not** mark it read. Reading there is
inspection, not attention.

### The architecture diagram on a client's page

Each client page carries a **Data architecture** section, directly above
Meetings, showing one diagram of your choosing. Pick it with **Show at
top** in the Diagrams section further down; **Remove** takes it down.

It is a rendered image, not an embedded editor. Loading draw.io into
every client page you open would be slow and would put third-party
JavaScript on the page you use most.

**How the picture gets made.** There is no server-side renderer for
`.drawio` — that needs draw.io's separate export server. But the editor
can render, and it is already running in the browser, so after every
successful save the page asks it for one:

    app → iframe   {action:'export', format:'svg'}
    iframe → app   {event:'export', data:'data:image/svg+xml;base64,…'}

and the result is stored in `files.preview_svg`.

Consequences worth knowing:

- **A diagram that has never been opened in the editor has no picture.**
  The section says so and links you in; opening and saving it once is
  enough. This includes diagrams generated by the app itself.
- **The preview is a cache, never the truth.** The `.drawio` in the
  bucket is the real thing; the SVG is regenerated on every save and is
  excluded from the backup export (`SKIP_COLUMNS` in `lib/export.js`) so
  a few diagrams cannot dominate the one file standing between you and
  total loss.
- **Previews are rendered as `<img src="data:…">`, never injected as
  markup.** An SVG placed into the page with `innerHTML` can carry script
  and would run in this app's origin; as an image source it cannot. The
  server refuses any preview that is not an `image/svg+xml` data URI, and
  the smoke suite asserts that.
- **A diagram can only be pinned to the client it belongs to**, or a
  diagram could be shown on somebody else's page.
- Deleting a pinned diagram clears the pin (`ON DELETE SET NULL`) rather
  than refusing the delete.

### Browsing files from the client page

The **Files** section on a client's page is a working file browser, not a
summary. It shows the path directly under the heading (starting at "All
files"), lists the folders and files at that level, and carries **New
folder** and **Upload files**.

It calls the same `/api/files?clientId=&folder=` endpoint the Files
module uses — one level plus its breadcrumb — rather than a second
endpoint that could drift from it.

Decisions worth keeping:

- **Only this section re-renders when you open a folder.** Re-rendering
  the whole client page would throw away your scroll position on every
  click into a folder.
- **Uploads land in the folder you are looking at**, filed to the client
  whose page you are on. There is no dialog because both questions the
  Files module asks are already answered by where you are standing.
- **The path is shown even at the top level.** A breadcrumb that appears
  only once you are inside something leaves the first screen ambiguous.
- **Diagrams appear in this list**, unlike the summary it replaced. A
  browser that hides files which really are in the folder sends you
  hunting for something the page chose not to mention. They keep the
  diagram icon and still open in the editor rather than downloading.
- **The open folder survives a re-render of the same client** (pinning a
  diagram, say) but resets when you move to a different client, whose
  folder ids are unrelated.
- Failed uploads are named individually. "3 of 4 uploaded" leaves you to
  work out which one is missing.

### Email templates

Reusable reply bodies, picked from a dropdown under the reply box.
**Manage** opens the editor: add, edit, delete.

**There is no subject field.** The Inbox only replies and forwards, and
both keep the subject of the thread they belong to, so a subject would
be stored, shown and never used — the same reasoning that keeps a
permission column off the People module. If a "new email" composer is
ever added, that is when a subject earns its place.

**Placeholders** are filled from the message you are answering:

| Token | Filled from |
| --- | --- |
| `{{name}}` | the sender's name, as their mail client sends it |
| `{{first_name}}` | the first word of that name |
| `{{email}}` | the sender's address |
| `{{client}}` | the client this sender is matched to, if any |
| `{{subject}}` | the subject of the message you are answering |
| `{{account}}` | the mailbox of yours it arrived at |
| `{{today}}` | today's date |

The list is served by `GET /api/templates` and rendered into the editor
from there, so the UI cannot drift from what the server supports.

Two decisions that matter more than they look:

- **Anything that cannot be filled is left standing in the text**, and
  named under the composer ("Still to fill in: `{{client}}`"). Blanking
  it would send *"Hi ,"* to a client — and only one of those two failures
  is still fixable when you spot it.
- **A template is inserted above the quoted original, never over your
  draft.** Losing what you had already typed to a mis-click on a dropdown
  would be its own small disaster.

Rendering happens server-side (`POST /api/templates/:id/render`) so there
is one implementation of the substitution and it can be tested. It
re-fetches the message rather than trusting what the page sent, because
the client match comes from the CRM rather than the browser.

### Writing a new email

**New email** sits beside the Inbox heading. It opens in the reading pane
rather than a modal — something you have spent five minutes typing into
should not be one stray Escape key away from gone.

Pick which mailbox it comes from, one or more recipients (comma
separated), a subject, and a body; templates can be inserted the same way
as in a reply. **This is where a template's subject applies** — a reply
or forward keeps the subject of its own thread, so it is ignored there.

Guards, because this is the one place in the app that sends something
irreversible to an address of your choosing:

- Recipients are validated **on the server**, not only in the browser,
  and capped at 20 per message.
- An empty body is refused.
- An empty subject asks first. It is allowed — some mail genuinely has
  none — but it is never silently filled in with something invented.
- A template never overwrites a subject you have already typed, and is
  inserted above an existing draft rather than over it.

### Sent mail is now actually saved

SMTP delivers a message and forgets it. Nothing about sending puts a copy
anywhere you can look, which meant **every reply and forward sent from
this app before this change existed only in the recipient's inbox** — not
in Sent on the server, not in webmail, not on the phone, not here. "Did
that go?" with no way to check is a bad position to be in about client
correspondence.

Now every outgoing message — new mail, replies and forwards alike — is
appended to the mailbox's Sent folder over IMAP, marked `\Seen`:

- The bytes filed are the **same bytes that were sent**, composed once
  with `MailComposer` and handed to both SMTP and `append`, rather than
  re-rendered into something that could differ.
- The Sent folder is found via SPECIAL-USE, same as Junk and Trash.
- If the copy fails, **the send is still reported as a success**, because
  it was one — the message is already delivered by that point. The UI
  says the copy could not be filed instead of implying it is somewhere it
  is not.
- `MailComposer` is loaded defensively. It is an internal path in
  nodemailer, and losing the ability to send mail because a copy could
  not be filed would be a poor trade.

### Recipient suggestions

Typing two or more characters in **To** searches your contacts by name,
address, or company, and offers them below the field. Arrow keys move,
Enter or Tab picks, Escape dismisses, clicking works too.

The details that make it usable rather than annoying:

- **It works on the fragment after the last comma**, not the whole box.
  Typing a second recipient must not search for the first one as well.
- **Contacts with no email address are never offered.** Picking one would
  put nothing in the box — a suggestion that does not work when taken is
  worse than no suggestion.
- **Anyone already in the box is filtered out**, so the list stops
  offering someone you have just added.
- **Enter is only intercepted when a row is actually highlighted**, so an
  address you typed out in full is never hijacked by a stale list.
- **Under two characters returns nothing**, on the server as well as in
  the browser. A list that ignores what you typed is not a suggestion.
- **The list overlays the form** rather than pushing it down. Fields that
  jump while you are typing into them are horrible.
- Selection uses `mousedown`, not `click`: blur would close the list
  before a click ever landed.
- The company name is searched too, so "Zephyr" finds everyone there, and
  each row shows which client the contact belongs to — two people called
  John are otherwise indistinguishable.

Wildcards are escaped the same way as global search, so a literal `%`
searches for that character instead of matching the whole address book.

### Client logos

Each client can carry a logo. Click the square beside their name on the
client page to add one; click it again to remove it. It then appears in
the client list and on the pipeline board.

**Stored in Postgres, not the bucket.** The bucket has no backups on any
plan, so a logo there would be unrecoverable; in `clients.logo` it rides
along in the JSON export like everything else. That is only affordable
because of the next point.

**Shrunk in the browser before upload.** A canvas crops the picked image
to a centre square and redraws it at 192px, so a few KB crosses the wire
instead of whatever came off someone's desktop. Doing it server-side
would mean an image library — a native dependency and a build step — for
something a canvas does in ten lines.

- **PNG, JPEG and WebP only.** SVG is refused even though it is an image:
  it can carry markup, and storing markup invites something to render it
  as markup later rather than as a picture. Everything that arrives has
  been through a canvas anyway, so it is already raster.
- **Cropped square.** Logos arrive in every shape; a row of ragged
  rectangles reads as broken rather than as branding.
- **PNG rather than JPEG on the way out**, so flat logo colours stay
  crisp and transparency survives — JPEG would put a grey box behind
  every transparent logo.
- **128KB cap, enforced on the server.** A rejected upload leaves the
  stored logo untouched.
- **No logo shows initials**, on a colour derived from the client's name
  so it is stable rather than changing on every render. A blank hole or a
  broken-image icon would look like a fault.

### The address book

**People → Address book** lists everyone this app already knows about,
folded into one entry per person.

**It is a view, not a table**, and that is the whole design. There is no
`addressbook` table and there should not be one: every name already
lives somewhere that owns it, and copying them into a fourth place would
mean four copies drifting apart the first time an address changed. The
cost is a `UNION` query instead of a `SELECT`; the benefit is that it
cannot go stale, and deleting a person removes them from here with
nothing to clean up separately.

Three sources:

| Source | Who that is |
| --- | --- |
| `people` | you, employees, contractors |
| `contacts` | the people at your clients |
| `bookings` | anyone who booked through the public page |

Bookings are included because "everyone we recognise" is the point, and
someone who booked a call is unambiguously recognised. They are labelled
by **when they last booked** rather than dressed up as a role — a
one-off enquiry should not look like a relationship.

**Folding** is matched on email address, lowercased, because that is the
only identifier the three sources share. Someone who is both a
contractor and a client contact is one row showing both, which is most of
the value of the page. Two consequences worth knowing:

- **Anyone without an email address stands alone.** They cannot be
  matched to anything, and guessing by name would eventually merge two
  different people — a worse failure than listing one person twice.
- **The fullest name wins.** Bookings often carry "Ada" where a contact
  record has the surname, so the longer of the two is kept. A phone
  number from any source survives the fold.

### Assigning a task

The **Assignee** field on a task suggests from the address book as you
type — team, client contacts, and anyone who has booked a meeting. Each
row says where that person is known from, so two people with the same
first name are still tellable apart.

It searches the **whole** address book rather than only the project's
team. Work gets handed to people who were never formally added to a
project, and refusing to name them would just push the field back to
being typed by hand — which is what it was before.

`project_tasks.assignee` is unchanged: still a plain text column holding
a name. Nothing was migrated, because the address book spans three
tables with no single id to point at, and a task's assignee is a label
rather than a live link to a record.

The suggestion list itself is one shared widget (`attachSuggest`), used
by both this and the recipient box. It is positioned `fixed` against the
input's own rectangle rather than absolutely inside its wrapper: the task
dialog scrolls, and an absolutely-positioned list is clipped the moment
it reaches the bottom edge — which is exactly where a dropdown appears.
It flips above the field when there is more room there.
