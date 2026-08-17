const { pool } = require('./db');

// Generic encrypted store for future OAuth integrations (Outlook mail x2,
// Outlook Calendar, Wave). One row per connected account; payload holds
// whatever token shape that provider needs, encrypted with lib/crypto.js.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id SERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      account_label TEXT NOT NULL,
      encrypted_payload BYTEA NOT NULL,
      iv BYTEA NOT NULL,
      auth_tag BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (provider, account_label)
    );
  `);

  // IMAP/SMTP mailboxes. Unlike OAuth these need a stored password, so it
  // goes in encrypted (lib/crypto.js) and is never sent back to the
  // browser — only the connection status is.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mail_accounts (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      imap_host TEXT NOT NULL,
      imap_port INTEGER NOT NULL,
      smtp_host TEXT NOT NULL,
      smtp_port INTEGER NOT NULL,
      encrypted_password BYTEA NOT NULL,
      iv BYTEA NOT NULL,
      auth_tag BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Calendar events. `source` distinguishes events someone typed in from
  // ones derived elsewhere in the app — once tickets and projects are
  // real records rather than mockup markup, their SLA dates and
  // milestones can be projected in here as 'ticket'/'project' rows
  // without changing the read path or the .ics feed.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ,
      all_day BOOLEAN NOT NULL DEFAULT false,
      location TEXT,
      notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS calendar_events_starts_at_idx ON calendar_events (starts_at);`);

  // external_id ties a row back to the record it was synced from (a
  // Calendly booking URI, later a ticket or project id) so repeated syncs
  // update rather than duplicate. Null for events typed in by hand.
  await pool.query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS external_id TEXT;`);

  // Mirror of this event in Google Calendar, so Calendly (which reads
  // Google for conflicts but can't read our .ics feed) knows the slot is
  // taken. Null until the event has been pushed.
  await pool.query(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS google_event_id TEXT;`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_source_external_idx
      ON calendar_events (source, external_id) WHERE external_id IS NOT NULL;
  `);

  // Small key/value store — currently just the secret token for the .ics
  // subscription URL, which needs to be rotatable without a redeploy.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

module.exports = { migrate };
