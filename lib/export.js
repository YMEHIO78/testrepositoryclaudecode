// Full logical export of the app's own records, as one JSON file.
//
// This exists because nothing here is backed up: Railway's volume
// backups are Pro-gated and this workspace is on Hobby, so the database
// has no snapshots at all. See HANDOFF.md.
//
// What it does NOT cover, and must not be mistaken for:
//
//   - The file *bytes* in object storage. This exports the files table,
//     meaning names, sizes, and where each one was filed — not their
//     contents. A restore from this would rebuild the index and point at
//     objects that may no longer exist. Bucket contents still have no
//     second copy anywhere.
//   - Mail. It lives on Hostinger's IMAP server and was never ours.
//
// Credentials are deliberately excluded rather than encrypted-and-
// included: mail_accounts and oauth_tokens hold encrypted secrets whose
// key is an environment variable, and a file combining the two on
// somebody's laptop is a worse position than not having the file. The
// calendar feed token is a credential too and is stripped from
// app_settings for the same reason.
const { pool } = require('./db');

const TABLES = [
  'clients', 'contacts',
  'packages', 'client_packages',
  'tickets', 'ticket_events',
  'projects', 'project_tasks', 'project_milestones', 'project_people',
  'people',
  'folders', 'files',
  // client_systems is included (names, URLs, notes - not secret);
  // client_secrets is excluded, see EXCLUDED below.
  'client_systems',
  // Worth carrying: rebuilding a blocklist by remembering who you muted
  // is not something anyone can actually do.
  'blocked_senders',
  'calendar_events',
  'booking_event_types', 'booking_availability', 'bookings',
];

// Keys in app_settings that are secrets, not settings.
const SECRET_SETTINGS = ['calendar_feed_token'];

const EXCLUDED = {
  client_secrets: 'client credentials for third-party systems',
  session: 'login sessions, worthless outside this instance',
  mail_accounts: 'encrypted mailbox passwords',
  oauth_tokens: 'encrypted third-party tokens',
};

// Columns that are caches rather than records. files.preview_svg is a
// rendered copy of a diagram that the editor regenerates on every save;
// carrying it would let a handful of diagrams dominate the size of the
// one file standing between you and total loss.
const SKIP_COLUMNS = {
  files: ['preview_svg'],
};

async function columnsFor(table) {
  const skip = SKIP_COLUMNS[table];
  if (!skip) return '*';
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
        AND column_name <> ALL($2::text[])
      ORDER BY ordinal_position`,
    [table, skip],
  );
  // No rows means the table is not there yet; '*' lets the usual
  // missing-table warning below report it properly.
  return rows.length ? rows.map((r) => `"${r.column_name}"`).join(', ') : '*';
}

async function buildExport() {
  const data = {};
  const warnings = [];

  for (const table of TABLES) {
    try {
      const { rows } = await pool.query(
        `SELECT ${await columnsFor(table)} FROM ${table} ORDER BY 1`);
      data[table] = rows;
    } catch (err) {
      // A table that does not exist yet should not lose you the other
      // sixteen. Record it and carry on.
      warnings.push(`${table}: ${err.message}`);
      data[table] = [];
    }
  }

  try {
    const { rows } = await pool.query(
      `SELECT key, value, updated_at FROM app_settings WHERE key <> ALL($1::text[]) ORDER BY key`,
      [SECRET_SETTINGS],
    );
    data.app_settings = rows;
  } catch (err) {
    warnings.push(`app_settings: ${err.message}`);
    data.app_settings = [];
  }

  const counts = Object.fromEntries(
    Object.entries(data).map(([table, rows]) => [table, rows.length]),
  );

  return {
    exportedAt: new Date().toISOString(),
    app: 'pocket-data-office',
    formatVersion: 1,
    counts,
    excluded: EXCLUDED,
    covers: 'Database records only. File contents in object storage are NOT included.',
    warnings,
    data,
  };
}

module.exports = { buildExport, TABLES, EXCLUDED };
