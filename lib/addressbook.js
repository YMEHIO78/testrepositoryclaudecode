// The address book: everyone this app already knows about, in one list.
//
// **This is a view, not a table.** There is no addressbook table and
// there should not be one. Every name here already lives somewhere that
// owns it — a person record, a client's contact, a meeting somebody
// booked — and copying them into a fourth place would mean four copies
// drifting apart the first time an address changed. The cost of that
// choice is that this query is a UNION rather than a SELECT; the benefit
// is that it can never be stale.
//
// Three sources today:
//
//   people    — you, employees, contractors
//   contacts  — the people at your clients
//   bookings  — anyone who booked a meeting through the public page
//
// Bookings are included because "everyone we recognise" is the point,
// and someone who booked a call is unambiguously recognised. They are
// labelled as such so a one-off enquiry is never mistaken for a contact
// you have a relationship with.
const { pool } = require('./db');

// Rows arrive one per source. Someone who is both a contractor and a
// client contact appears twice here and is folded into one entry below,
// which is most of the value of this page.
async function rows(term) {
  const escaped = String(term || '').replace(/[%_\\]/g, (ch) => `\\${ch}`);
  const pattern = `%${escaped}%`;
  const filtered = !!String(term || '').trim();

  const { rows: found } = await pool.query(
    `
    SELECT 'person'  AS source,
           p.id      AS source_id,
           p.name,
           p.email,
           NULL::text AS phone,
           p.role,
           NULL::int  AS client_id,
           NULL::text AS org,
           p.engagement AS detail,
           p.active   AS active
      FROM people p
     WHERE NOT $2 OR (p.name ILIKE $1 OR p.email ILIKE $1 OR p.role ILIKE $1)

    UNION ALL

    SELECT 'contact',
           ct.id,
           ct.name,
           ct.email,
           ct.phone,
           ct.role,
           c.id,
           c.name,
           CASE WHEN ct.is_primary THEN 'primary' ELSE NULL END,
           true
      FROM contacts ct
      LEFT JOIN clients c ON c.id = ct.client_id
     WHERE NOT $2 OR (ct.name ILIKE $1 OR ct.email ILIKE $1 OR c.name ILIKE $1)

    UNION ALL

    -- One row per person who has booked, not one per booking: someone
    -- with six calls is still one entry in an address book.
    SELECT 'booking',
           min(b.id),
           min(b.invitee_name),
           b.invitee_email,
           NULL, NULL, NULL, NULL,
           to_char(max(b.created_at), 'YYYY-MM-DD'),
           true
      FROM bookings b
     WHERE NOT $2 OR (b.invitee_name ILIKE $1 OR b.invitee_email ILIKE $1)
     GROUP BY b.invitee_email
    `,
    [pattern, filtered],
  );
  return found;
}

// Folds the rows into one entry per person. Email is the only identifier
// shared across the three sources, so it is what joins them; anyone
// without one cannot be matched to anything and stands alone rather than
// being guessed at by name.
function fold(found) {
  const byKey = new Map();

  for (const r of found) {
    const email = (r.email || '').trim().toLowerCase();
    const key = email || `${r.source}:${r.source_id}`;

    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        name: r.name,
        email: r.email || null,
        phone: r.phone || null,
        known: [],
      });
    }
    const entry = byKey.get(key);

    // Prefer a name that looks fuller than the one already there —
    // bookings often carry "Ada" where a contact record has the surname.
    if (r.name && r.name.length > (entry.name || '').length) entry.name = r.name;
    if (!entry.phone && r.phone) entry.phone = r.phone;
    if (!entry.email && r.email) entry.email = r.email;

    entry.known.push({
      source: r.source,
      id: r.source_id,
      role: r.role || null,
      clientId: r.client_id || null,
      org: r.org || null,
      detail: r.detail || null,
      active: r.active !== false,
    });
  }

  return [...byKey.values()].sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
}

async function list(term) {
  return fold(await rows(term));
}

module.exports = { list, fold };
