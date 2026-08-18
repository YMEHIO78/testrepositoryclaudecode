// People: you plus contractors, their rates, and which projects they're on.
//
// Deliberately no access/permission model. The app has one shared login,
// so per-person access does not exist — recording a permission level here
// would imply a boundary that isn't enforced anywhere. Adding contractors
// as actual users needs real per-user accounts first.
const { pool } = require('./db');

const ENGAGEMENTS = [
  { key: 'owner', label: 'Owner', tone: 'brand' },
  { key: 'employee', label: 'Employee', tone: 'grey' },
  { key: 'contractor', label: 'Contractor', tone: 'grey' },
];
const ENGAGEMENT_KEYS = ENGAGEMENTS.map((e) => e.key);

function toPerson(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    engagement: row.engagement,
    rateCents: row.rate_cents === null ? null : Number(row.rate_cents),
    active: row.active,
    notes: row.notes,
    projects: [],
  };
}

async function listPeople({ activeOnly = false } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM people ${activeOnly ? 'WHERE active' : ''}
      ORDER BY active DESC, array_position($1::text[], engagement), name`,
    [ENGAGEMENT_KEYS],
  );
  const people = rows.map(toPerson);
  if (!people.length) return people;

  // One query for every assignment rather than one per person.
  const { rows: links } = await pool.query(
    `SELECT pp.person_id, p.id, p.name, p.stage
       FROM project_people pp
       JOIN projects p ON p.id = pp.project_id
      WHERE pp.person_id = ANY($1::int[])
      ORDER BY p.name`,
    [people.map((p) => p.id)],
  );
  const byPerson = new Map(people.map((p) => [p.id, p]));
  for (const l of links) {
    byPerson.get(l.person_id)?.projects.push({ id: l.id, name: l.name, stage: l.stage });
  }
  return people;
}

async function getPerson(id) {
  const { rows } = await pool.query(`SELECT * FROM people WHERE id = $1`, [id]);
  return rows.length ? toPerson(rows[0]) : null;
}

async function createPerson(input) {
  const { rows } = await pool.query(
    `INSERT INTO people (name, email, role, engagement, rate_cents, active, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      input.name,
      input.email || null,
      input.role || null,
      ENGAGEMENT_KEYS.includes(input.engagement) ? input.engagement : 'contractor',
      input.rateCents ?? null,
      input.active !== false,
      input.notes || null,
    ],
  );
  return toPerson(rows[0]);
}

async function updatePerson(id, input) {
  const { rows } = await pool.query(
    `UPDATE people SET
       name = COALESCE($2, name),
       email = $3,
       role = $4,
       engagement = COALESCE($5, engagement),
       rate_cents = $6,
       active = COALESCE($7, active),
       notes = $8,
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      id,
      input.name ?? null,
      input.email || null,
      input.role || null,
      input.engagement && ENGAGEMENT_KEYS.includes(input.engagement) ? input.engagement : null,
      input.rateCents ?? null,
      input.active ?? null,
      input.notes || null,
    ],
  );
  return rows.length ? toPerson(rows[0]) : null;
}

async function deletePerson(id) {
  // Assignments cascade.
  const { rowCount } = await pool.query(`DELETE FROM people WHERE id = $1`, [id]);
  return rowCount > 0;
}

// --- project assignments ---

async function listTeam(projectId) {
  const { rows } = await pool.query(
    `SELECT p.* FROM project_people pp
       JOIN people p ON p.id = pp.person_id
      WHERE pp.project_id = $1
      ORDER BY p.name`,
    [projectId],
  );
  return rows.map(toPerson);
}

async function assign(projectId, personId) {
  await pool.query(
    `INSERT INTO project_people (project_id, person_id) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`,
    [projectId, personId],
  );
}

async function unassign(projectId, personId) {
  await pool.query(
    `DELETE FROM project_people WHERE project_id = $1 AND person_id = $2`,
    [projectId, personId],
  );
}

module.exports = {
  ENGAGEMENTS,
  listPeople,
  getPerson,
  createPerson,
  updatePerson,
  deletePerson,
  listTeam,
  assign,
  unassign,
};
