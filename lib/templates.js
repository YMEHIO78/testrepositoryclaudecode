// Email templates: reusable subjects and bodies.
//
// The subject is optional and only used by the compose screen. A reply
// or a forward keeps the subject of the thread it belongs to, so setting
// one there would be wrong — the composer is the only place it applies.
// (It was left out entirely until compose existed, on the grounds that a
// field nothing acts on is a lie about what the app does.)
//
// Placeholders are filled from the message you are answering. Anything
// that cannot be filled is left standing in the text rather than blanked
// — "Hi ," sent to a client is worse than "Hi {{first_name}}," caught in
// the composer, because only one of them is still fixable.
const { pool } = require('./db');

// Every placeholder, and where its value comes from. Kept as data so the
// UI can list them accurately instead of documenting them separately and
// drifting.
const PLACEHOLDERS = {
  '{{name}}': "the sender's name, as their mail client sends it",
  '{{first_name}}': 'the first word of that name',
  '{{email}}': "the sender's address",
  '{{client}}': 'the client this sender is matched to, if any',
  '{{subject}}': 'the subject of the message you are answering',
  '{{account}}': 'the mailbox of yours it arrived at',
  '{{today}}': "today's date",
};

function toRow(row) {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    body: row.body,
    usedCount: row.used_count,
    lastUsedAt: row.last_used_at,
    updatedAt: row.updated_at,
  };
}

async function list() {
  const { rows } = await pool.query(
    `SELECT * FROM email_templates ORDER BY used_count DESC, name ASC`);
  return rows.map(toRow);
}

async function get(id) {
  const { rows } = await pool.query(`SELECT * FROM email_templates WHERE id = $1`, [id]);
  return rows.length ? toRow(rows[0]) : null;
}

function check({ name, subject, body }) {
  const n = String(name || '').trim();
  const s = String(subject || '').trim();
  const b = String(body || '');
  if (!n) throw new Error('Give the template a name.');
  if (n.length > 120) throw new Error('That name is too long.');
  if (s.length > 500) throw new Error('That subject is too long.');
  if (!b.trim()) throw new Error('A template needs a body.');
  if (b.length > 20000) throw new Error('That body is too long.');
  // Empty becomes null, so "no subject set" is one value rather than two.
  return { name: n, subject: s || null, body: b };
}

async function create(input) {
  const { name, subject, body } = check(input);
  const { rows } = await pool.query(
    `INSERT INTO email_templates (name, subject, body) VALUES ($1, $2, $3) RETURNING *`,
    [name, subject, body],
  );
  return toRow(rows[0]);
}

async function update(id, input) {
  const { name, subject, body } = check(input);
  const { rows } = await pool.query(
    `UPDATE email_templates SET name = $2, subject = $3, body = $4, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, name, subject, body],
  );
  return rows.length ? toRow(rows[0]) : null;
}

async function remove(id) {
  const { rowCount } = await pool.query(`DELETE FROM email_templates WHERE id = $1`, [id]);
  return rowCount > 0;
}

// Builds the substitution map from a message. Values that are absent stay
// absent rather than becoming '' — render() needs to tell "no client
// matched" apart from "the client's name is empty".
function contextFrom(message = {}) {
  const name = message.from || '';
  const values = {};
  if (name) {
    values['{{name}}'] = name;
    values['{{first_name}}'] = name.trim().split(/\s+/)[0];
  }
  if (message.fromAddress) values['{{email}}'] = message.fromAddress;
  if (message.client && message.client.name) values['{{client}}'] = message.client.name;
  if (message.subject) values['{{subject}}'] = message.subject;
  if (message.account) values['{{account}}'] = message.account;
  values['{{today}}'] = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  return values;
}

// Returns the filled text plus whichever placeholders had no value, so
// the composer can say so before anything is sent. Subject and body are
// filled from the same values and share one unresolved list — you want
// to be told about {{client}} in the subject line just as much.
function render(template, values) {
  const unresolved = [];
  const fill = (text) => String(text || '').replace(/\{\{[a-z_]+\}\}/g, (token) => {
    if (Object.prototype.hasOwnProperty.call(values, token)) return values[token];
    // Unknown tokens and known-but-unfilled ones are both left alone.
    if (!unresolved.includes(token)) unresolved.push(token);
    return token;
  });

  // Accepts a whole template or just a body string, so callers that only
  // care about the body do not have to wrap it.
  const source = typeof template === 'string' ? { body: template, subject: null } : template;
  return {
    subject: source.subject ? fill(source.subject) : null,
    body: fill(source.body),
    unresolved,
  };
}

async function recordUse(id) {
  await pool.query(
    `UPDATE email_templates SET used_count = used_count + 1, last_used_at = now()
      WHERE id = $1`,
    [id],
  );
}

module.exports = {
  PLACEHOLDERS, list, get, create, update, remove,
  contextFrom, render, recordUse,
};
