// Files: metadata in Postgres, bytes in Dropbox.
//
// Uploads and downloads both go through the app rather than handing out
// Dropbox share links. That keeps every byte behind the app's login — a
// share link is a bearer token that works for anyone holding it, which
// is the wrong default for client files.
//
// This used to talk to an S3-compatible bucket as well, chosen per file.
// Everything was migrated to Dropbox and the bucket removed, because two
// stores meant two code paths on every read, write and delete for no
// benefit once one of them was empty.
//
// `storage_provider` survives that removal on purpose. It records where
// a row's bytes actually are, and the guard below turns "this file
// predates Dropbox" into a sentence rather than a confusing 500. It is
// also what a second store would need if one is ever added again — which
// has now happened twice.
const crypto = require('crypto');
const path = require('path');
const { pool } = require('./db');
const dropbox = require('./dropbox');

const MAX_BYTES = Number(process.env.FILES_MAX_BYTES || 25 * 1024 * 1024);

function isConfigured() {
  return dropbox.isConfigured();
}

// Surfaced in Integrations so a broken connection is visible before
// someone tries to upload.
async function check() {
  const status = await dropbox.status();
  if (!status.configured) return { ok: false, reason: 'not_configured' };
  if (!status.connected) return { ok: false, reason: 'not_connected' };
  if (status.error) return { ok: false, reason: status.error };
  return { ok: true, account: status.account };
}

// Every stored object gets a random key, not one derived from the
// filename: a user-supplied name in a path invites traversal and
// collisions. The readable name is kept alongside it so the Dropbox
// folder is legible to a human, and the real name lives in the database
// where it is just data.
function makeKey(filename) {
  const ext = path.extname(filename || '').slice(0, 12).replace(/[^.\w]/g, '');
  return `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}${ext}`;
}

function safeName(filename) {
  return String(filename || 'file')
    .replace(/[\\/:*?"<>|#%]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'file';
}

// Rows written before the migration would point at a bucket that no
// longer exists. There should be none, but failing with a sentence beats
// failing with a stack trace about an undefined client.
function assertReachable(file) {
  if (file.storageProvider !== 'dropbox') {
    throw new Error(
      `"${file.name}" is stored in the old object-storage bucket, which has been removed. `
      + 'It cannot be opened from here.');
  }
}

function toFile(row) {
  return {
    id: row.id,
    name: row.name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    clientId: row.client_id,
    clientName: row.client_name ?? null,
    projectId: row.project_id,
    projectName: row.project_name ?? null,
    folderId: row.folder_id,
    storageProvider: row.storage_provider || 'bucket',
    notes: row.notes,
    createdAt: row.created_at,
  };
}

async function listFiles({ clientId, projectId, folderId } = {}) {
  const where = [];
  const params = [];
  if (clientId) { params.push(clientId); where.push(`f.client_id = $${params.length}`); }
  if (projectId) { params.push(projectId); where.push(`f.project_id = $${params.length}`); }

  // null means "loose in this scope, not in any folder", which is a
  // different query from undefined, meaning "every folder". The Files
  // view needs the first; a client's page needs the second.
  if (folderId === null) where.push('f.folder_id IS NULL');
  else if (folderId) { params.push(folderId); where.push(`f.folder_id = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT f.*, c.name AS client_name, p.name AS project_name
       FROM files f
       LEFT JOIN clients c ON c.id = f.client_id
       LEFT JOIN projects p ON p.id = f.project_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY f.created_at DESC LIMIT 500`,
    params,
  );
  return rows.map(toFile);
}

async function getFile(id) {
  const { rows } = await pool.query(
    `SELECT f.*, c.name AS client_name, p.name AS project_name
       FROM files f
       LEFT JOIN clients c ON c.id = f.client_id
       LEFT JOIN projects p ON p.id = f.project_id
      WHERE f.id = $1`,
    [id],
  );
  return rows.length ? { ...toFile(rows[0]), storageKey: rows[0].storage_key } : null;
}

async function upload({ name, buffer, contentType, clientId, projectId, folderId, notes }) {
  if (!buffer || !buffer.length) throw new Error('Empty file.');
  if (buffer.length > MAX_BYTES) {
    throw new Error(`That file is larger than the ${Math.round(MAX_BYTES / 1024 / 1024)}MB limit.`);
  }

  const item = await dropbox.upload(`${makeKey(name)}-${safeName(name)}`, buffer, contentType);

  // Object first, row second: a row without an object is a broken
  // download, whereas an object without a row is just a stray file.
  const { rows } = await pool.query(
    `INSERT INTO files (name, storage_key, storage_provider, content_type, size_bytes,
                        client_id, project_id, folder_id, notes)
     VALUES ($1,$2,'dropbox',$3,$4,$5,$6,$7,$8) RETURNING id`,
    [name, item.id, contentType || null, buffer.length, clientId || null,
      projectId || null, folderId || null, notes || null],
  );
  return getFile(rows[0].id);
}

async function download(id) {
  const file = await getFile(id);
  if (!file) return null;
  assertReachable(file);
  return { file, buffer: await dropbox.download(file.storageKey) };
}

// Overwrites a file's bytes while keeping its id, name and folder.
// Diagrams get edited over and over, and a new row per save would bury
// the folder in near-identical copies — the file someone linked to
// should stay the file they linked to. Dropbox keeps the previous copy
// in its own version history, which the bucket could not do at all.
//
// Deliberately not wired to uploads. Replacing content in place is right
// for a document you are editing and wrong for one somebody sent you.
async function replaceContent(id, buffer, contentType) {
  if (!buffer || !buffer.length) throw new Error('Empty file.');
  if (buffer.length > MAX_BYTES) {
    throw new Error(`That file is larger than the ${Math.round(MAX_BYTES / 1024 / 1024)}MB limit.`);
  }
  const file = await getFile(id);
  if (!file) return null;
  assertReachable(file);

  await dropbox.overwrite(file.storageKey, buffer, contentType || file.contentType);

  await pool.query(
    `UPDATE files SET size_bytes = $2, content_type = COALESCE($3, content_type) WHERE id = $1`,
    [id, buffer.length, contentType || null],
  );
  return getFile(id);
}

// Moving a file is purely a metadata change — the stored object keeps
// its key, because the key never encoded a path in the first place.
// Nothing touches Dropbox.
async function move(id, folderId) {
  const { rows } = await pool.query(
    `UPDATE files SET folder_id = $2 WHERE id = $1 RETURNING id`,
    [id, folderId || null],
  );
  return rows.length ? getFile(id) : null;
}

async function remove(id) {
  const file = await getFile(id);
  if (!file) return false;
  try {
    if (file.storageProvider === 'dropbox') await dropbox.remove(file.storageKey);
  } catch (err) {
    // Leaving the row would show a file that cannot be downloaded; a
    // stray object in Dropbox is the lesser problem, so log and carry on.
    console.error('Could not delete the stored file, removing the row anyway:', err.message);
  }
  await pool.query(`DELETE FROM files WHERE id = $1`, [id]);
  return true;
}

async function stats() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count, COALESCE(sum(size_bytes), 0)::bigint AS bytes FROM files`,
  );
  return { count: rows[0].count, bytes: Number(rows[0].bytes) };
}

module.exports = {
  MAX_BYTES, isConfigured, check,
  listFiles, getFile, upload, download, replaceContent, move, remove, stats,
};
