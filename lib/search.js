// Search across the app's own records.
//
// Deliberately not mail. The inbox already searches over IMAP, which is a
// network round trip against someone else's server with its own matching
// rules — folding it in here would make one box behave two different ways
// and be slow whenever the mail server was. The Inbox keeps its own
// search; this covers everything stored locally.
//
// ILIKE '%term%' rather than full-text: at this size it is instant, it
// matches mid-word (a client searching "olog" finds "Acme Logistics"),
// and it needs no tsvector columns or triggers to keep in step. If these
// tables ever reach five figures this is the thing to revisit — see
// docs/SCHEMA.md.
const { pool } = require('./db');

const PER_GROUP = 8;

// Wraps the term for ILIKE and neutralises the wildcards, so a literal
// % or _ in a query searches for that character instead of matching
// everything.
function pattern(term) {
  const escaped = String(term).replace(/[%_\\]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

async function search(term) {
  const q = String(term || '').trim();
  if (q.length < 2) return { query: q, groups: [], tooShort: true };

  const p = pattern(q);

  // Each group runs independently so one failure degrades that section
  // rather than the whole page — the same rule the client detail page
  // follows.
  const [clients, tickets, projects, files, people] = await Promise.all([
    pool.query(
      `SELECT c.id, c.name, c.stage, c.health,
              (SELECT string_agg(ct.name, ', ') FROM contacts ct
                WHERE ct.client_id = c.id AND (ct.name ILIKE $1 OR ct.email ILIKE $1)) AS matched_contacts
         FROM clients c
        WHERE c.name ILIKE $1 OR c.notes ILIKE $1
           OR EXISTS (SELECT 1 FROM contacts ct
                       WHERE ct.client_id = c.id AND (ct.name ILIKE $1 OR ct.email ILIKE $1))
        -- Name-prefix matches first: searching "acme" should put Acme
        -- above a client whose notes merely mention them.
        ORDER BY (lower(c.name) LIKE lower($2)) DESC, lower(c.name)
        LIMIT $3`,
      [p, `${q.toLowerCase()}%`, PER_GROUP],
    ).catch(() => ({ rows: [] })),

    pool.query(
      `SELECT t.id, t.reference, t.subject, t.status, c.name AS client_name
         FROM tickets t
         LEFT JOIN clients c ON c.id = t.client_id
        WHERE t.subject ILIKE $1 OR t.body ILIKE $1 OR t.reference ILIKE $1
        ORDER BY t.created_at DESC
        LIMIT $2`,
      [p, PER_GROUP],
    ).catch(() => ({ rows: [] })),

    pool.query(
      `SELECT p.id, p.name, p.stage, c.name AS client_name
         FROM projects p
         LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.name ILIKE $1 OR p.notes ILIKE $1 OR p.owner ILIKE $1
           OR EXISTS (SELECT 1 FROM project_tasks pt
                       WHERE pt.project_id = p.id
                         AND (pt.title ILIKE $1 OR pt.notes ILIKE $1))
        ORDER BY lower(p.name)
        LIMIT $2`,
      [p, PER_GROUP],
    ).catch(() => ({ rows: [] })),

    pool.query(
      `SELECT f.id, f.name, f.size_bytes, c.name AS client_name, fo.name AS folder_name
         FROM files f
         LEFT JOIN clients c ON c.id = f.client_id
         LEFT JOIN folders fo ON fo.id = f.folder_id
        WHERE f.name ILIKE $1 OR f.notes ILIKE $1
        ORDER BY f.created_at DESC
        LIMIT $2`,
      [p, PER_GROUP],
    ).catch(() => ({ rows: [] })),

    pool.query(
      `SELECT id, name, role, engagement, active
         FROM people
        WHERE name ILIKE $1 OR role ILIKE $1 OR email ILIKE $1 OR notes ILIKE $1
        ORDER BY lower(name)
        LIMIT $2`,
      [p, PER_GROUP],
    ).catch(() => ({ rows: [] })),
  ]);

  const groups = [
    {
      kind: 'client',
      label: 'Clients & Leads',
      items: clients.rows.map((r) => ({
        id: r.id,
        title: r.name,
        // Says *why* this row matched when the name itself did not.
        subtitle: r.matched_contacts ? `Contact: ${r.matched_contacts}` : null,
        badge: r.stage,
        tone: r.health,
      })),
    },
    {
      kind: 'ticket',
      label: 'Service Desk',
      items: tickets.rows.map((r) => ({
        id: r.id,
        title: `${r.reference} · ${r.subject}`,
        subtitle: r.client_name,
        badge: r.status,
      })),
    },
    {
      kind: 'project',
      label: 'Projects',
      items: projects.rows.map((r) => ({
        id: r.id,
        title: r.name,
        subtitle: r.client_name,
        badge: r.stage,
      })),
    },
    {
      kind: 'file',
      label: 'Files & Folders',
      items: files.rows.map((r) => ({
        id: r.id,
        title: r.name,
        subtitle: [r.client_name, r.folder_name].filter(Boolean).join(' · ') || null,
      })),
    },
    {
      kind: 'person',
      label: 'People',
      items: people.rows.map((r) => ({
        id: r.id,
        title: r.name,
        subtitle: [r.role, r.active ? null : 'inactive'].filter(Boolean).join(' · ') || null,
        badge: r.engagement,
      })),
    },
  ].filter((g) => g.items.length);

  return {
    query: q,
    groups,
    total: groups.reduce((sum, g) => sum + g.items.length, 0),
  };
}

module.exports = { search, PER_GROUP };
