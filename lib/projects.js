// Projects: one per package sold, hanging off a client. Carries a kanban
// of tasks and a set of milestones, and — like ticket SLAs — milestone
// dates are projected onto the calendar so deadlines live in one place.
const { pool } = require('./db');

const STAGES = [
  { key: 'scoping', label: 'Scoping', tone: 'grey' },
  { key: 'build', label: 'Build', tone: 'amber' },
  { key: 'review', label: 'Review', tone: 'amber' },
  { key: 'blocked', label: 'Blocked', tone: 'red' },
  { key: 'done', label: 'Done', tone: 'green' },
];

const HEALTH = [
  { key: 'on_track', label: 'On track', tone: 'green' },
  { key: 'at_risk', label: 'At risk', tone: 'amber' },
  { key: 'off_track', label: 'Off track', tone: 'red' },
];

// Kanban columns, in board order.
const TASK_STATUSES = [
  { key: 'todo', label: 'To do' },
  { key: 'doing', label: 'In progress' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'done', label: 'Done' },
];

const MILESTONE_STATUSES = [
  { key: 'pending', label: 'Pending', tone: 'grey' },
  { key: 'hit', label: 'Hit', tone: 'green' },
  { key: 'missed', label: 'Missed', tone: 'red' },
];

const STAGE_KEYS = STAGES.map((s) => s.key);
const HEALTH_KEYS = HEALTH.map((h) => h.key);
const TASK_KEYS = TASK_STATUSES.map((t) => t.key);
const MILESTONE_KEYS = MILESTONE_STATUSES.map((m) => m.key);
const CLOSED_STAGES = ['done'];

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function toProject(row) {
  return {
    id: row.id,
    name: row.name,
    clientId: row.client_id,
    clientName: row.client_name ?? null,
    stage: row.stage,
    health: row.health,
    owner: row.owner,
    budgetCents: row.budget_cents === null ? null : Number(row.budget_cents),
    spentCents: Number(row.spent_cents || 0),
    startsOn: row.starts_on,
    dueOn: row.due_on,
    notes: row.notes,
    openTasks: row.open_tasks !== undefined ? Number(row.open_tasks) : undefined,
  };
}

async function listProjects({ openOnly = false } = {}) {
  const { rows } = await pool.query(
    `SELECT p.*, c.name AS client_name,
            (SELECT count(*) FROM project_tasks t
              WHERE t.project_id = p.id AND t.status <> 'done') AS open_tasks
       FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
      ${openOnly ? `WHERE p.stage <> 'done'` : ''}
      ORDER BY
        CASE WHEN p.stage = 'done' THEN 1 ELSE 0 END,
        p.due_on NULLS LAST,
        p.name
      LIMIT 200`,
  );
  return rows.map(toProject);
}

async function getProject(id) {
  const { rows } = await pool.query(
    `SELECT p.*, c.name AS client_name FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = $1`,
    [id],
  );
  return rows.length ? toProject(rows[0]) : null;
}

async function createProject(input) {
  const { rows } = await pool.query(
    `INSERT INTO projects (name, client_id, stage, health, owner, budget_cents, spent_cents, starts_on, due_on, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      input.name,
      input.clientId || null,
      pick(input.stage, STAGE_KEYS, 'scoping'),
      pick(input.health, HEALTH_KEYS, 'on_track'),
      input.owner || null,
      input.budgetCents ?? null,
      input.spentCents ?? 0,
      input.startsOn || null,
      input.dueOn || null,
      input.notes || null,
    ],
  );
  return getProject(rows[0].id);
}

async function updateProject(id, input) {
  const current = await getProject(id);
  if (!current) return null;

  await pool.query(
    `UPDATE projects SET
       name = COALESCE($2, name),
       client_id = $3,
       stage = $4,
       health = $5,
       owner = $6,
       budget_cents = $7,
       spent_cents = COALESCE($8, spent_cents),
       starts_on = $9,
       due_on = $10,
       notes = $11,
       updated_at = now()
     WHERE id = $1`,
    [
      id,
      input.name ?? null,
      input.clientId === undefined ? current.clientId : (input.clientId || null),
      input.stage ? pick(input.stage, STAGE_KEYS, current.stage) : current.stage,
      input.health ? pick(input.health, HEALTH_KEYS, current.health) : current.health,
      input.owner === undefined ? current.owner : (input.owner || null),
      input.budgetCents === undefined ? current.budgetCents : (input.budgetCents ?? null),
      input.spentCents ?? null,
      input.startsOn === undefined ? current.startsOn : (input.startsOn || null),
      input.dueOn === undefined ? current.dueOn : (input.dueOn || null),
      input.notes === undefined ? current.notes : (input.notes || null),
    ],
  );

  const updated = await getProject(id);
  // Finishing a project retires its milestone entries from the calendar.
  if (CLOSED_STAGES.includes(updated.stage) !== CLOSED_STAGES.includes(current.stage)) {
    await resyncMilestones(id);
  }
  return updated;
}

async function deleteProject(id) {
  // Tasks and milestones cascade; their calendar entries do not, so clear
  // those first or the calendar keeps deadlines for a deleted project.
  const { rows } = await pool.query(
    `SELECT calendar_event_id FROM project_milestones
      WHERE project_id = $1 AND calendar_event_id IS NOT NULL`,
    [id],
  );
  for (const r of rows) {
    await pool.query(`DELETE FROM calendar_events WHERE id = $1`, [r.calendar_event_id]);
  }
  const { rowCount } = await pool.query(`DELETE FROM projects WHERE id = $1`, [id]);
  return rowCount > 0;
}

// --- tasks ---

async function listTasks(projectId) {
  const { rows } = await pool.query(
    `SELECT * FROM project_tasks WHERE project_id = $1 ORDER BY status, position, id`,
    [projectId],
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    notes: r.notes,
    status: r.status,
    assignee: r.assignee,
    position: r.position,
  }));
}

async function createTask(projectId, input) {
  const status = pick(input.status, TASK_KEYS, 'todo');
  const { rows } = await pool.query(
    `INSERT INTO project_tasks (project_id, title, notes, status, assignee, position)
     VALUES ($1,$2,$3,$4,$5,
       COALESCE((SELECT max(position) + 1 FROM project_tasks WHERE project_id = $1 AND status = $4), 0))
     RETURNING id`,
    [projectId, input.title, input.notes || null, status, input.assignee || null],
  );
  return rows[0].id;
}

async function updateTask(id, input) {
  const { rowCount } = await pool.query(
    `UPDATE project_tasks SET
       title = COALESCE($2, title),
       notes = $3,
       status = COALESCE($4, status),
       assignee = $5,
       position = COALESCE($6, position),
       updated_at = now()
     WHERE id = $1`,
    [
      id,
      input.title ?? null,
      input.notes ?? null,
      input.status ? pick(input.status, TASK_KEYS, null) : null,
      input.assignee ?? null,
      input.position ?? null,
    ],
  );
  return rowCount > 0;
}

async function deleteTask(id) {
  const { rowCount } = await pool.query(`DELETE FROM project_tasks WHERE id = $1`, [id]);
  return rowCount > 0;
}

// --- milestones ---

async function listMilestones(projectId) {
  const { rows } = await pool.query(
    `SELECT * FROM project_milestones WHERE project_id = $1 ORDER BY due_on NULLS LAST, id`,
    [projectId],
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    dueOn: r.due_on,
    status: r.status,
  }));
}

// Same contract as the ticket SLA projection: a dated, still-pending
// milestone on a live project has a calendar entry; anything else does not.
async function syncMilestoneEvent(milestoneId) {
  const { rows } = await pool.query(
    `SELECT m.*, p.name AS project_name, p.stage AS project_stage, c.name AS client_name
       FROM project_milestones m
       JOIN projects p ON p.id = m.project_id
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE m.id = $1`,
    [milestoneId],
  );
  if (!rows.length) return;
  const m = rows[0];

  const wanted = m.due_on && m.status === 'pending' && !CLOSED_STAGES.includes(m.project_stage);

  if (!wanted) {
    if (m.calendar_event_id) {
      await pool.query(`DELETE FROM calendar_events WHERE id = $1`, [m.calendar_event_id]);
      await pool.query(`UPDATE project_milestones SET calendar_event_id = NULL WHERE id = $1`, [m.id]);
    }
    return;
  }

  const title = `${m.project_name} — ${m.name}`;
  const notes = [m.client_name, 'Project milestone'].filter(Boolean).join(' · ');
  // Milestones are day-granular, so they land as all-day entries.
  const startsAt = new Date(`${m.due_on instanceof Date ? m.due_on.toISOString().slice(0, 10) : m.due_on}T00:00:00.000Z`).toISOString();

  if (m.calendar_event_id) {
    const { rowCount } = await pool.query(
      `UPDATE calendar_events SET title = $2, starts_at = $3, all_day = true, notes = $4, updated_at = now()
        WHERE id = $1`,
      [m.calendar_event_id, title, startsAt, notes],
    );
    if (rowCount) return;
    // Deleted from the calendar behind our back — recreate rather than
    // silently lose the deadline.
  }

  const { rows: created } = await pool.query(
    `INSERT INTO calendar_events (title, starts_at, all_day, notes, source)
     VALUES ($1,$2,true,$3,'project') RETURNING id`,
    [title, startsAt, notes],
  );
  await pool.query(`UPDATE project_milestones SET calendar_event_id = $2 WHERE id = $1`, [m.id, created[0].id]);
}

async function resyncMilestones(projectId) {
  const { rows } = await pool.query(`SELECT id FROM project_milestones WHERE project_id = $1`, [projectId]);
  for (const r of rows) await syncMilestoneEvent(r.id);
}

async function createMilestone(projectId, input) {
  const { rows } = await pool.query(
    `INSERT INTO project_milestones (project_id, name, due_on, status)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [projectId, input.name, input.dueOn || null, pick(input.status, MILESTONE_KEYS, 'pending')],
  );
  await syncMilestoneEvent(rows[0].id);
  return rows[0].id;
}

async function updateMilestone(id, input) {
  const { rowCount } = await pool.query(
    `UPDATE project_milestones SET
       name = COALESCE($2, name),
       due_on = $3,
       status = COALESCE($4, status),
       updated_at = now()
     WHERE id = $1`,
    [id, input.name ?? null, input.dueOn || null,
     input.status ? pick(input.status, MILESTONE_KEYS, null) : null],
  );
  if (rowCount) await syncMilestoneEvent(id);
  return rowCount > 0;
}

async function deleteMilestone(id) {
  const { rows } = await pool.query(`SELECT calendar_event_id FROM project_milestones WHERE id = $1`, [id]);
  if (!rows.length) return false;
  if (rows[0].calendar_event_id) {
    await pool.query(`DELETE FROM calendar_events WHERE id = $1`, [rows[0].calendar_event_id]);
  }
  await pool.query(`DELETE FROM project_milestones WHERE id = $1`, [id]);
  return true;
}

async function stats() {
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE stage <> 'done')::int AS active,
       count(*) FILTER (WHERE health <> 'on_track' AND stage <> 'done')::int AS needs_attention,
       COALESCE(sum(budget_cents) FILTER (WHERE stage <> 'done'), 0)::bigint AS active_budget
       FROM projects`,
  );
  return {
    active: rows[0].active,
    needsAttention: rows[0].needs_attention,
    activeBudgetCents: Number(rows[0].active_budget),
  };
}

module.exports = {
  STAGES, HEALTH, TASK_STATUSES, MILESTONE_STATUSES,
  listProjects, getProject, createProject, updateProject, deleteProject,
  listTasks, createTask, updateTask, deleteTask,
  listMilestones, createMilestone, updateMilestone, deleteMilestone,
  stats,
};
