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

  // Which client a meeting was with. ON DELETE SET NULL, not CASCADE:
  // removing a client must not erase the history of having met them.
  // Set by hand on a manual event, and matched automatically on a booking
  // whose attendee email belongs to one of their contacts.
  await pool.query(`
    ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS client_id
      INTEGER REFERENCES clients(id) ON DELETE SET NULL;
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS calendar_events_client_idx ON calendar_events (client_id);`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_source_external_idx
      ON calendar_events (source, external_id) WHERE external_id IS NOT NULL;
  `);

  // Small key/value store — the .ics feed token, the Google target
  // calendar, the booking timezone.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // --- CRM ---
  // One row per company, moving through a pipeline from cold name to
  // paying client — mirroring how the mockup framed it. Money is stored
  // in cents to keep totals exact.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'in_contact',
      value_cents BIGINT,
      recurring BOOLEAN NOT NULL DEFAULT false,
      notes TEXT,
      last_touch_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Terms, health and start date come from the design reference's client
  // page. All nullable: each is a judgement about a relationship, and
  // "not set" is meaningfully different from a default someone guessed.
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS terms TEXT;`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS health TEXT;`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS client_since DATE;`);

  // A logo, as a small square image in a data URI.
  //
  // In the database rather than the bucket on purpose. The bucket has no
  // backups on any plan, so a logo there would be unrecoverable; here it
  // rides along in the JSON export. It is affordable because the browser
  // shrinks the image to 192px before uploading — a few KB each — and
  // the server refuses anything bigger.
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS logo TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      role TEXT,
      is_primary BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Case-insensitive lookup, so an inbox sender can be matched back to a
  // contact regardless of how the address was typed.
  await pool.query(`CREATE INDEX IF NOT EXISTS contacts_email_idx ON contacts (lower(email));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS contacts_client_idx ON contacts (client_id);`);

  // --- Service desk ---
  // A ticket may originate from an email (source='email', carrying the
  // originating account + uid so it can be traced back) or be raised by
  // hand. sla_due_at is projected onto the calendar as a 'ticket' event.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      reference TEXT UNIQUE,
      subject TEXT NOT NULL,
      body TEXT,
      client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      contact_email TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'normal',
      sla_due_at TIMESTAMPTZ,
      source TEXT NOT NULL DEFAULT 'manual',
      source_account TEXT,
      source_uid TEXT,
      calendar_event_id INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets (status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS tickets_client_idx ON tickets (client_id);`);

  // Human-facing ticket numbers (TKT-101...), independent of the serial
  // primary key so references stay stable and readable.
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS ticket_reference_seq START 101;`);

  // Append-only activity log. Without it a ticket detail page is just the
  // edit form in a different shape — the history is the point.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_events (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ticket_events_ticket_idx ON ticket_events (ticket_id, created_at);`);

  // --- Projects ---
  // One project per package sold, hanging off a client. `spent_cents` is
  // entered by hand: there is no time tracking or expense feed to derive
  // it from, and deriving it from nothing would be a fabricated number.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      stage TEXT NOT NULL DEFAULT 'scoping',
      health TEXT NOT NULL DEFAULT 'on_track',
      owner TEXT,
      budget_cents BIGINT,
      spent_cents BIGINT NOT NULL DEFAULT 0,
      starts_on DATE,
      due_on DATE,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS projects_client_idx ON projects (client_id);`);

  // Kanban cards. `position` orders within a column; gaps are fine.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_tasks (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      assignee TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS project_tasks_project_idx ON project_tasks (project_id, status, position);`);

  // Milestones project onto the calendar the same way ticket SLAs do —
  // that is what makes the mockup's "Marlowe milestone" line real.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_milestones (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      due_on DATE,
      status TEXT NOT NULL DEFAULT 'pending',
      calendar_event_id INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS project_milestones_project_idx ON project_milestones (project_id, due_on);`);

  // --- People ---
  // You plus contractors. Note there is deliberately NO access/permission
  // column: the app has a single shared login, so per-person access does
  // not exist. Recording one would imply a security boundary that isn't
  // there.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS people (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      role TEXT,
      engagement TEXT NOT NULL DEFAULT 'contractor',
      rate_cents BIGINT,
      active BOOLEAN NOT NULL DEFAULT true,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Who is on which project.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_people (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      PRIMARY KEY (project_id, person_id)
    );
  `);

  // --- Files ---
  // Metadata only. The bytes live in S3-compatible object storage
  // (Railway Buckets); `storage_key` is the object key. Rows and objects
  // can drift if a delete half-fails, so deletes remove the object first
  // and the row second - an orphaned object is wasted pennies, an
  // orphaned row is a broken download.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS files (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      content_type TEXT,
      size_bytes BIGINT,
      client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS files_client_idx ON files (client_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS files_project_idx ON files (project_id);`);

  // Folders exist only here. The bucket has no folders - its keys are
  // random UUIDs carrying no path - so this tree is the whole structure,
  // which is what lets an empty folder exist and a rename touch nothing
  // in storage. Deleting a folder reparents its contents rather than
  // cascading, because nothing in this app is backed up.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS folders (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      parent_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS folders_client_idx ON folders (client_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS folders_parent_idx ON folders (parent_id);`);
  await pool.query(`
    ALTER TABLE files ADD COLUMN IF NOT EXISTS folder_id
      INTEGER REFERENCES folders(id) ON DELETE SET NULL;
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS files_folder_idx ON files (folder_id);`);

  // A rendered copy of a diagram, as an SVG data URI, so a client page
  // can show one without loading draw.io. It is produced in the browser
  // by the editor on save — there is no way to rasterise .drawio on the
  // server without draw.io's separate export server.
  //
  // Cached, not authoritative: the .drawio file in the bucket is the
  // real thing, and this is regenerated every time it is saved.
  await pool.query(`ALTER TABLE files ADD COLUMN IF NOT EXISTS preview_svg TEXT;`);

  // The one diagram shown on a client's page — their data architecture
  // at a glance. Declared here rather than with the other client columns
  // because it points at files, which does not exist until above.
  //
  // SET NULL rather than RESTRICT: deleting a diagram should quietly
  // clear the pin, not refuse to delete the file.
  await pool.query(`
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS diagram_file_id INTEGER
      REFERENCES files(id) ON DELETE SET NULL;
  `);

  // --- AI agent ---
  // Conversations and their messages. content is the raw Claude content
  // block array, stored whole: thinking and tool_use blocks have to go back
  // to the API unmodified on the next turn, so keeping only the text would
  // break multi-turn tool use.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_conversations (
      id SERIAL PRIMARY KEY,
      title TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content JSONB NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS agent_messages_conv_idx ON agent_messages (conversation_id, id);`);

  // The approval queue. This is the whole safety model: a write tool does
  // not act, it writes a row here and the turn ends. Nothing changes in the
  // app until someone opens this queue and approves the row.
  //
  // Durable rather than an in-process callback because approval happens in
  // a later HTTP request - possibly minutes later, possibly after a reload.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_actions (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER REFERENCES agent_conversations(id) ON DELETE CASCADE,
      tool_use_id TEXT,
      kind TEXT NOT NULL,
      input JSONB NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      decided_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS agent_actions_status_idx ON agent_actions (status, id);`);

  // --- Client systems and credentials ---
  // The third-party systems a client uses (Databricks, a POS, Dropbox...)
  // and the credentials for each. Values are encrypted with the same
  // AES-256-GCM helper as mailbox passwords; only the label, username and
  // notes are readable in the clear.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_systems (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      url TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS client_systems_client_idx ON client_systems (client_id);`);

  // RESTRICT, not CASCADE, on the client link above. Everywhere else in
  // this app a delete either cascades or nulls out; here neither is safe.
  // These credentials cannot be re-derived, are deliberately absent from
  // the backup export, and are often not even ours - they belong to the
  // client. Deleting a client must therefore fail loudly while their
  // systems still exist, rather than quietly destroying the one copy.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_secrets (
      id SERIAL PRIMARY KEY,
      system_id INTEGER NOT NULL REFERENCES client_systems(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'password',
      username TEXT,
      encrypted_value BYTEA NOT NULL,
      iv BYTEA NOT NULL,
      auth_tag BYTEA NOT NULL,
      notes TEXT,
      last_revealed_at TIMESTAMPTZ,
      reveal_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS client_secrets_system_idx ON client_secrets (system_id);`);

  // --- Packages and per-client quantities ---
  // A client's value is not typed in: it is the sum of unit_cents *
  // quantity across their packages, which is why there is no cached total
  // anywhere. One source of truth cannot drift from itself.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS packages (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      unit_cents BIGINT NOT NULL,
      unit_note TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_packages (
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (client_id, package_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS client_packages_pkg_idx ON client_packages (package_id);`);

  // Seed the three packages from the design reference, once and only
  // once. Guarded by a flag rather than "insert if the table is empty":
  // prices are meant to be edited and packages retired, and an empty
  // table is a legitimate state that must not be silently refilled on the
  // next boot.
  const seeded = await pool.query(`SELECT 1 FROM app_settings WHERE key = 'packages_seeded'`);
  if (!seeded.rowCount) {
    await pool.query(`
      INSERT INTO packages (name, unit_cents, unit_note, sort_order) VALUES
        ('Manual Data', 2200, 'per Unit', 1),
        ('Data Warehousing', 4900, 'per Unit', 2),
        ('Data Analysis', 9900, 'per Unit', 3)
    `);
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('packages_seeded', 'true')
       ON CONFLICT (key) DO NOTHING`,
    );
  }

  // --- Scheduling (self-hosted booking pages) ---
  // Bookable meeting types. Each gets a public /book/<slug> page.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_event_types (
      id SERIAL PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      duration_minutes INTEGER NOT NULL DEFAULT 30,
      buffer_before_minutes INTEGER NOT NULL DEFAULT 0,
      buffer_after_minutes INTEGER NOT NULL DEFAULT 10,
      min_notice_minutes INTEGER NOT NULL DEFAULT 240,
      max_days_ahead INTEGER NOT NULL DEFAULT 60,
      location TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Recurring weekly hours, expressed in the booking timezone
  // (app_settings.booking_timezone) as minutes from midnight.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_availability (
      id SERIAL PRIMARY KEY,
      weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1440),
      end_minute INTEGER NOT NULL CHECK (end_minute BETWEEN 0 AND 1440),
      CHECK (end_minute > start_minute)
    );
  `);

  // A booking owns a calendar_events row (source='booking'); deleting the
  // event cascades here so the two can't drift apart.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      event_id INTEGER REFERENCES calendar_events(id) ON DELETE CASCADE,
      event_type_id INTEGER REFERENCES booking_event_types(id) ON DELETE SET NULL,
      invitee_name TEXT NOT NULL,
      invitee_email TEXT NOT NULL,
      notes TEXT,
      cancel_token TEXT NOT NULL UNIQUE,
      canceled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Reusable reply bodies. No subject column on purpose — the Inbox only
  // replies and forwards, and both keep the thread's subject, so a
  // subject here would be stored, shown and never used.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      used_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // A subject was deliberately omitted when templates only served
  // replies and forwards, which keep their thread's subject. The compose
  // screen changed that: a new email needs one, so the column earns its
  // place now. Nullable, because a template can still be body-only.
  await pool.query(`ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS subject TEXT;`);

  // Senders whose mail gets filed to Junk on sight.
  //
  // `pattern` is either a full address (foo@bar.com) or a domain written
  // with a leading @ (@bar.com), stored lowercased. There is no separate
  // "type" column because the leading @ already says which it is, and a
  // type that can disagree with the value is a bug waiting to happen.
  //
  // This is a rule this app applies when it fetches, not a block at the
  // mail server — see the Inbox section of the README.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocked_senders (
      id SERIAL PRIMARY KEY,
      pattern TEXT NOT NULL UNIQUE,
      note TEXT,
      filed_count INTEGER NOT NULL DEFAULT 0,
      last_filed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Seed sensible defaults once, so the booking page works immediately
  // rather than 404ing until someone configures it.
  const { rows: typeCount } = await pool.query(`SELECT count(*)::int AS n FROM booking_event_types`);
  if (typeCount[0].n === 0) {
    await pool.query(
      `INSERT INTO booking_event_types (slug, name, description, duration_minutes, location)
       VALUES ('discovery-call', 'Discovery call', 'A short intro call to talk through what you need.', 30, 'Phone / video — details in the confirmation email')`,
    );
  }
  const { rows: availCount } = await pool.query(`SELECT count(*)::int AS n FROM booking_availability`);
  if (availCount[0].n === 0) {
    // Weekdays 9:00–17:00.
    for (const weekday of [1, 2, 3, 4, 5]) {
      await pool.query(
        `INSERT INTO booking_availability (weekday, start_minute, end_minute) VALUES ($1, 540, 1020)`,
        [weekday],
      );
    }
  }
}

module.exports = { migrate };
