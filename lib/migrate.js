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
}

module.exports = { migrate };
