# Schema

`lib/migrate.js` is the source of truth — it runs on every boot and is
idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).
Add changes there; there is no migration tool and no down-migrations.

## Tables

### `session`
Created automatically by `connect-pg-simple`. Not in `migrate.js`.
Sessions idle out after 12 hours.

### `mail_accounts` — connected mailboxes
`email` (unique), `username`, `imap_host`, `imap_port`, `smtp_host`,
`smtp_port`, `encrypted_password`, `iv`, `auth_tag`.

The password is AES-256-GCM encrypted (`lib/crypto.js`) under
`TOKEN_ENCRYPTION_KEY` and is **never** returned to the browser — the API
only reports connected/not-connected. Rotating that key makes these rows
undecryptable and both mailboxes need reconnecting.

### `oauth_tokens` — third-party credentials
`(provider, account_label)` unique, plus `encrypted_payload`, `iv`,
`auth_tag`. One generic table for several providers:

| provider | label | payload |
|---|---|---|
| `calendly` | `default` | `{ token }` |
| `google` | `default` | `{ access_token, refresh_token, expires_at }` |
| `wave` | `default` | `{ token, businessId }` |

Environment variables take precedence over stored rows where supported
(`CALENDLY_TOKEN`, `WAVE_TOKEN`), which keeps a token out of the browser
entirely. Wave is currently configured that way, so **no `wave` row
exists** — its credentials are not encrypted in the database at all.

### `calendar_events` — everything on the calendar
`title`, `starts_at`, `ends_at` (nullable), `all_day`, `location`,
`notes`, `source`, `external_id`, `google_event_id`.

`source` is the important column:

| source | origin | editable in app? |
|---|---|---|
| `manual` | typed into the Calendar view | yes |
| `booking` | someone booked via `/book/<slug>` | no — cancel via Scheduling |
| `calendly` | synced from Calendly | no — 409; change it in Calendly |
| `ticket` | projected from a ticket's SLA date | no — change the ticket |

A partial unique index on `(source, external_id) WHERE external_id IS NOT
NULL` is what makes repeated syncs update rather than duplicate.
A timed event with no `ends_at` is treated as one hour; an all-day event
blocks the whole day. Both conventions are relied on by the slot maths.

### `app_settings` — key/value
`calendar_feed_token` (the `.ics` URL secret), `google_calendar_id`,
`booking_timezone`.

### `booking_event_types` — bookable meeting types
`slug` (unique, drives `/book/<slug>`), `name`, `duration_minutes`,
`buffer_before_minutes`, `buffer_after_minutes`, `min_notice_minutes`,
`max_days_ahead`, `location`, `active`.

Seeded once with a 30-minute "Discovery call" so the booking page works
out of the box.

### `booking_availability` — weekly hours
`weekday` (0=Sun … 6=Sat), `start_minute`, `end_minute` — minutes from
midnight **in `app_settings.booking_timezone`**, not UTC. Seeded weekdays
09:00–17:00. Saving replaces the whole set rather than diffing.

### `bookings` — who booked what
`event_id` → `calendar_events` **ON DELETE CASCADE**, `event_type_id` →
`booking_event_types` ON DELETE SET NULL, plus invitee name/email, notes,
`cancel_token` (unique, powers the public cancel link), `canceled_at`.

The cascade is deliberate: deleting the calendar event must not leave an
orphan booking claiming a slot that is now free.

### `clients` — CRM pipeline
`name`, `stage`, `value_cents`, `recurring`, `notes`, `last_touch_at`.
Stages: `in_contact` → `engaging` → `offer_sent` → `client`, plus `lost`.

### `contacts` — people at clients
`client_id` → `clients` **ON DELETE CASCADE**, `name`, `email`, `phone`,
`role`, `is_primary`.

Indexed on `lower(email)` — that index is what lets an inbox sender be
matched to a client on every inbox load. Only one contact per client may
be primary; enforced on write, not by constraint.

### `people` / `project_people`
`people`: name, email, role, engagement (`owner`/`employee`/`contractor`),
`rate_cents`, active, notes. `project_people` joins people to projects,
cascading from both sides.

**There is deliberately no access or permission column.** The app has a
single shared login, so per-person access does not exist - storing a
permission level would imply a boundary nothing enforces. The mockup
showed an "Access: Project only" column; reproducing it would have been a
fabricated security control, which is worse than a fabricated number.

### `projects` / `project_tasks` / `project_milestones`
`projects`: name, `client_id` -> `clients` ON DELETE SET NULL, stage
(`scoping`/`build`/`review`/`blocked`/`done`), health
(`on_track`/`at_risk`/`off_track`), owner, `budget_cents`,
`spent_cents`, `starts_on`, `due_on`, notes.

`spent_cents` is entered by hand. There is no time tracking or expense
feed to derive it from, and deriving it from nothing would be a
fabricated number.

`project_tasks`: kanban cards - `project_id` **ON DELETE CASCADE**,
title, notes, status (`todo`/`doing`/`blocked`/`done`), assignee,
`position` (orders within a column; gaps are fine).

`project_milestones`: `project_id` **ON DELETE CASCADE**, name, `due_on`,
status (`pending`/`hit`/`missed`), `calendar_event_id` -> `calendar_events`
ON DELETE SET NULL.

Milestones project onto the calendar exactly as ticket SLAs do: a dated,
**pending** milestone on a **non-done** project has an all-day
`source='project'` event; anything else does not. Note that deleting a
project cascades to milestones but **not** to their calendar events, so
`deleteProject` clears those first - otherwise the calendar keeps
deadlines for a project that no longer exists.

### `ticket_events` - append-only activity log
`ticket_id` -> `tickets` ON DELETE CASCADE, `kind`, `detail`, `created_at`.

Written on creation and whenever status, priority, SLA, client or subject
changes - only fields that actually changed are logged, so the history
reads as history rather than noise. Without it a ticket detail page would
just be the edit form in a different shape.

### `tickets` — service desk
`reference` (unique, `TKT-###`), `subject`, `body`, `client_id` →
`clients` ON DELETE SET NULL, `contact_email`, `status`, `priority`,
`sla_due_at`, `source`, `source_account`, `source_uid`,
`calendar_event_id` → `calendar_events` ON DELETE SET NULL,
`resolved_at`.

Statuses: `open`, `in_progress`, `waiting`, `resolved`, `closed`.
Priorities: `low`, `normal`, `high`, `urgent`.

`reference` comes from its own sequence (`ticket_reference_seq`, starting
at 101) rather than the primary key, so numbers stay stable and readable.

`source_account` + `source_uid` trace a ticket back to the email it came
from.

## Relationships

```
clients ─┬─< contacts            (cascade delete)
         ├─< tickets             (set null)
         └   (referenced by bookings only via the event)

projects ─┬─< project_tasks       (cascade delete)
         └─< project_milestones  (cascade delete)
project_milestones ──> calendar_events  (set null)
projects ──> clients             (set null)

tickets ─< ticket_events         (cascade delete)
tickets ──> calendar_events      (set null; SLA projection)
bookings ──> calendar_events     (cascade delete)
bookings ──> booking_event_types (set null)
```

`calendar_events` is the hub: manual entries, bookings, Calendly imports
and ticket SLA dates all land in it, which is why the scheduler can
compute conflict-free slots from one query and the `.ics` feed shows
everything.

## Things that will bite

- **Rotating `TOKEN_ENCRYPTION_KEY`** invalidates `mail_accounts` and any
  `oauth_tokens` rows. Decryption throws on the auth-tag check rather
  than returning garbage, so failures are loud — but reconnection is
  required.
- **Deleting a client** cascades to its contacts but only nulls the
  `client_id` on its tickets. Tickets survive deliberately.
- **`ends_at` is nullable** and a null means "one hour" in the slot maths
  and the `.ics` feed. Changing that convention means changing both.
- **Booking availability is stored in local minutes**, so changing
  `booking_timezone` reinterprets existing hours rather than converting
  them.
