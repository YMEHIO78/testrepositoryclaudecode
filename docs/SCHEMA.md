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
