// Blocked senders: addresses and domains whose mail gets filed straight
// to Junk.
//
// Be clear about what this is, because the word "block" promises more
// than it delivers here. This is a rule *this app* applies when it
// fetches mail. It is not a block at the mail server: the message is
// still accepted, still delivered, still counts against the mailbox, and
// if this app never runs it stays in the inbox. Real blocking would mean
// a Sieve rule or a filter in Hostinger's control panel, neither of
// which has an API we can drive.
//
// What it does buy is that the move is real — the message leaves the
// inbox on the server, so it is gone from webmail and the phone too, not
// merely hidden here.
const { pool } = require('./db');

// A pattern is either a full address or a domain written with a leading
// @. Anything else is a typo, and a blocklist that silently matches
// nothing is worse than one that refuses the entry.
function normalise(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) throw new Error('Enter an address or a domain.');
  if (value.length > 320) throw new Error('That is too long to be an address.');

  if (value.startsWith('@')) {
    if (!/^@[^@\s]+\.[^@\s]+$/.test(value)) throw new Error('That does not look like a domain.');
    return value;
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    throw new Error('Enter a full address (someone@example.com) or a domain (@example.com).');
  }
  return value;
}

function toRow(row) {
  return {
    id: row.id,
    pattern: row.pattern,
    note: row.note,
    filedCount: row.filed_count,
    lastFiledAt: row.last_filed_at,
    createdAt: row.created_at,
    isDomain: String(row.pattern).startsWith('@'),
  };
}

async function list() {
  const { rows } = await pool.query(
    `SELECT * FROM blocked_senders ORDER BY filed_count DESC, pattern ASC`);
  return rows.map(toRow);
}

async function add(pattern, note) {
  const value = normalise(pattern);
  const { rows } = await pool.query(
    `INSERT INTO blocked_senders (pattern, note) VALUES ($1, $2)
     ON CONFLICT (pattern) DO UPDATE SET note = COALESCE(EXCLUDED.note, blocked_senders.note)
     RETURNING *`,
    [value, note || null],
  );
  return toRow(rows[0]);
}

// Takes the pattern rather than an id so that "not spam" can undo a
// block without the caller having to look the row up first.
async function remove(patternOrId) {
  const isId = /^\d+$/.test(String(patternOrId));
  const { rowCount } = isId
    ? await pool.query(`DELETE FROM blocked_senders WHERE id = $1`, [Number(patternOrId)])
    : await pool.query(`DELETE FROM blocked_senders WHERE pattern = $1`, [normalise(patternOrId)]);
  return rowCount > 0;
}

// Returns the matching pattern, or null. An address matches either
// itself or its domain, so blocking @spam.example catches every sender
// there without listing them one by one.
function matchOne(address, patterns) {
  const value = String(address || '').trim().toLowerCase();
  if (!value) return null;
  if (patterns.has(value)) return value;

  const at = value.lastIndexOf('@');
  if (at === -1) return null;
  const domain = value.slice(at);
  return patterns.has(domain) ? domain : null;
}

// Splits a page of messages into what should be shown and what should be
// filed. Deliberately pure — the caller does the IMAP move, so this stays
// testable and cannot half-apply a rule by throwing partway through.
async function partition(messages) {
  const rows = await list();
  if (!rows.length) return { keep: messages, file: [], hits: new Map() };

  const patterns = new Set(rows.map((r) => r.pattern));
  const keep = [];
  const file = [];
  const hits = new Map();

  for (const m of messages) {
    const hit = matchOne(m.fromAddress, patterns);
    if (hit) {
      file.push(m);
      hits.set(hit, (hits.get(hit) || 0) + 1);
    } else {
      keep.push(m);
    }
  }
  return { keep, file, hits };
}

// Called after a successful move, so the counts reflect mail actually
// filed rather than mail merely matched.
async function recordFiled(hits) {
  for (const [pattern, n] of hits) {
    await pool.query(
      `UPDATE blocked_senders
          SET filed_count = filed_count + $2, last_filed_at = now()
        WHERE pattern = $1`,
      [pattern, n],
    );
  }
}

module.exports = { normalise, list, add, remove, partition, recordFiled, matchOne };
