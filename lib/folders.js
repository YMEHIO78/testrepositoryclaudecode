// Folders for the Files module.
//
// Object storage has no folders - it is a flat keyspace, and the object
// key here is a random UUID that deliberately carries no path. So folders
// are purely a database structure: a tree of rows that files point at.
// That is why an empty folder can exist at all, and why renaming one
// touches nothing in the bucket.
const { pool } = require('./db');

const MAX_DEPTH = 10;
const MAX_NAME = 100;

// Folder names come from user input and, on a folder upload, straight
// from directory names on someone's disk. Neither is trusted.
function cleanName(name) {
  // Drop control characters and turn either path separator into a dash,
  // so a folder name can never be read as a path. Compared by character
  // code rather than a regex escape (92 is a backslash) - see CLAUDE.md
  // on why escape sequences are avoided in this repo.
  const cleaned = String(name || "")
    .split("")
    .filter((ch) => ch >= " " && ch.charCodeAt(0) !== 127)
    .map((ch) => (ch === "/" || ch.charCodeAt(0) === 92 ? "-" : ch))
    .join("");
  return cleaned.trim().slice(0, MAX_NAME);
}

function toFolder(row) {
  return {
    id: row.id,
    name: row.name,
    clientId: row.client_id,
    clientName: row.client_name ?? null,
    parentId: row.parent_id,
    createdAt: row.created_at,
  };
}

// clientId is tri-state, and the distinction matters: undefined means
// every client (the "All clients" root), null means folders belonging to
// no client at all. Same for parentId - undefined is any depth, null is
// the top level.
async function listFolders({ clientId, parentId } = {}) {
  const where = [];
  const params = [];
  if (clientId === null) where.push('f.client_id IS NULL');
  else if (clientId) { params.push(clientId); where.push(`f.client_id = $${params.length}`); }

  if (parentId === null) where.push('f.parent_id IS NULL');
  else if (parentId) { params.push(parentId); where.push(`f.parent_id = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT f.*, c.name AS client_name
       FROM folders f
       LEFT JOIN clients c ON c.id = f.client_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY lower(f.name)`,
    params,
  );
  return rows.map(toFolder);
}

async function getFolder(id) {
  const { rows } = await pool.query(`SELECT * FROM folders WHERE id = $1`, [id]);
  return rows.length ? toFolder(rows[0]) : null;
}

// Walks up to the root so the UI can render a breadcrumb. Bounded by
// MAX_DEPTH rather than trusting the tree to be well-formed.
async function breadcrumb(id) {
  const trail = [];
  let current = id;
  for (let i = 0; i < MAX_DEPTH && current; i += 1) {
    const folder = await getFolder(current);
    if (!folder) break;
    trail.unshift(folder);
    current = folder.parentId;
  }
  return trail;
}

async function depthOf(parentId) {
  if (!parentId) return 0;
  return (await breadcrumb(parentId)).length;
}

// Same name in the same place is reused rather than duplicated. That is
// what makes re-uploading a folder idempotent instead of producing
// "Reports", "Reports", "Reports".
async function findByName({ name, clientId, parentId }) {
  const { rows } = await pool.query(
    `SELECT * FROM folders
      WHERE lower(name) = lower($1)
        AND client_id IS NOT DISTINCT FROM $2
        AND parent_id IS NOT DISTINCT FROM $3`,
    [name, clientId || null, parentId || null],
  );
  return rows.length ? toFolder(rows[0]) : null;
}

async function createFolder({ name, clientId, parentId }) {
  const clean = cleanName(name);
  if (!clean) throw new Error('A folder name is required.');

  if (parentId) {
    const parent = await getFolder(parentId);
    if (!parent) throw new Error('That parent folder no longer exists.');
    // A folder belongs to whichever client its parent belongs to;
    // otherwise a subfolder could quietly escape its client.
    clientId = parent.clientId;
    if (await depthOf(parentId) >= MAX_DEPTH) {
      throw new Error(`Folders can only nest ${MAX_DEPTH} deep.`);
    }
  }

  const existing = await findByName({ name: clean, clientId, parentId });
  if (existing) return existing;

  const { rows } = await pool.query(
    `INSERT INTO folders (name, client_id, parent_id) VALUES ($1,$2,$3) RETURNING *`,
    [clean, clientId || null, parentId || null],
  );
  return toFolder(rows[0]);
}

async function renameFolder(id, name) {
  const clean = cleanName(name);
  if (!clean) throw new Error('A folder name is required.');
  const { rows } = await pool.query(
    `UPDATE folders SET name = $2 WHERE id = $1 RETURNING *`,
    [id, clean],
  );
  return rows.length ? toFolder(rows[0]) : null;
}

// Deleting a folder never deletes files. Its contents move up to the
// parent instead. Nothing here is backed up - see HANDOFF.md - so a
// single click must not be able to destroy a client's documents.
async function deleteFolder(id) {
  const folder = await getFolder(id);
  if (!folder) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const moved = await client.query(
      `UPDATE files SET folder_id = $2 WHERE folder_id = $1`,
      [id, folder.parentId],
    );
    await client.query(
      `UPDATE folders SET parent_id = $2 WHERE parent_id = $1`,
      [id, folder.parentId],
    );
    await client.query(`DELETE FROM folders WHERE id = $1`, [id]);
    await client.query('COMMIT');
    return { movedFiles: moved.rowCount, parentId: folder.parentId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Turns "2026/Q1/Signed" into a folder chain, creating what is missing
// and reusing what is not. Used by the folder upload, where the path
// comes from webkitRelativePath.
async function ensurePath(pathText, { clientId, parentId } = {}) {
  const segments = String(pathText || '')
    .split('/')
    .map(cleanName)
    .filter((s) => s && s !== '.' && s !== '..')
    .slice(0, MAX_DEPTH);

  let current = parentId || null;
  let scope = clientId || null;
  for (const name of segments) {
    const folder = await createFolder({ name, clientId: scope, parentId: current });
    current = folder.id;
    scope = folder.clientId;
  }
  return current;
}

async function stats(clientId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count FROM folders
      WHERE $1::int IS NULL OR client_id = $1`,
    [clientId || null],
  );
  return { count: rows[0].count };
}

module.exports = {
  MAX_DEPTH, MAX_NAME,
  listFolders, getFolder, breadcrumb, createFolder, renameFolder,
  deleteFolder, ensurePath, findByName, stats,
};
