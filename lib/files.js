// Files: metadata in Postgres, bytes in S3-compatible object storage
// (Railway Buckets, which run on Tigris).
//
// Uploads and downloads both go through the app rather than using
// presigned URLs direct to the bucket. That keeps every byte behind the
// app's login — a presigned URL is a bearer token that works for anyone
// holding it, which is the wrong default for client files.
const crypto = require('crypto');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { pool } = require('./db');
const dropbox = require('./dropbox');

const MAX_BYTES = Number(process.env.FILES_MAX_BYTES || 25 * 1024 * 1024);

// Is there anywhere at all to put a file? Either store counts, because
// the routes use this to decide whether to accept an upload. Whether the
// bucket specifically is usable is check(), which is a different
// question and has its own answer.
function isConfigured() {
  return bucketConfigured() || dropbox.isConfigured();
}

function bucketConfigured() {
  return !!(process.env.FILES_BUCKET && process.env.FILES_ACCESS_KEY_ID
    && process.env.FILES_SECRET_ACCESS_KEY && process.env.FILES_ENDPOINT);
}

let client = null;
function s3() {
  if (!bucketConfigured()) throw new Error('The object storage bucket is not configured.');
  if (client) return client;
  client = new S3Client({
    region: process.env.FILES_REGION || 'auto',
    endpoint: process.env.FILES_ENDPOINT,
    credentials: {
      accessKeyId: process.env.FILES_ACCESS_KEY_ID,
      secretAccessKey: process.env.FILES_SECRET_ACCESS_KEY,
    },
  });
  return client;
}

// Confirms the bucket is reachable with the configured credentials.
async function check() {
  if (!bucketConfigured()) return { ok: false, reason: 'not_configured' };
  try {
    await s3().send(new HeadBucketCommand({ Bucket: process.env.FILES_BUCKET }));
    return { ok: true, bucket: process.env.FILES_BUCKET };
  } catch (err) {
    return { ok: false, reason: err.name || err.message };
  }
}

// Object keys are random, not derived from the filename. A user-supplied
// name in a key invites traversal and collisions; the real name lives in
// the database where it is just data.
function makeKey(filename) {
  const ext = path.extname(filename || '').slice(0, 12).replace(/[^.\w]/g, '');
  return `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}${ext}`;
}

// Dropbox shows real filenames to whoever opens the folder, so unlike an
// S3 key the name is worth keeping readable. Still stripped of anything
// that could act as a path or upset the API.
function safeName(filename) {
  return String(filename || 'file')
    .replace(/[\\/:*?"<>|#%]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'file';
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

// Where new files go. Dropbox when it is connected, the bucket
// otherwise — so losing the Dropbox connection degrades to the old
// behaviour instead of refusing uploads. Existing files are unaffected
// either way; each row records its own store.
async function activeProvider() {
  try {
    if (dropbox.isConfigured() && await dropbox.isConnected()) return 'dropbox';
  } catch (err) {
    console.error('Could not check Dropbox, falling back to the bucket:', err.message);
  }
  return 'bucket';
}

async function upload({ name, buffer, contentType, clientId, projectId, folderId, notes }) {
  if (!buffer || !buffer.length) throw new Error('Empty file.');
  if (buffer.length > MAX_BYTES) {
    throw new Error(`That file is larger than the ${Math.round(MAX_BYTES / 1024 / 1024)}MB limit.`);
  }

  const provider = await activeProvider();
  const key = makeKey(name);
  let storageKey = key;

  if (provider === 'dropbox') {
    // The stored name is kept for humans browsing the drive; the random
    // key still prefixes it so two files called report.pdf cannot
    // collide, and so a user-supplied name never becomes a path.
    const item = await dropbox.upload(`${key}-${safeName(name)}`, buffer, contentType);
    storageKey = item.id;
  } else {
    await s3().send(new PutObjectCommand({
      Bucket: process.env.FILES_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType || 'application/octet-stream',
    }));
  }

  // Object first, row second: a row without an object is a broken
  // download, whereas an object without a row is just wasted pennies.
  const { rows } = await pool.query(
    `INSERT INTO files (name, storage_key, storage_provider, content_type, size_bytes,
                        client_id, project_id, folder_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [name, storageKey, provider, contentType || null, buffer.length, clientId || null,
      projectId || null, folderId || null, notes || null],
  );
  return getFile(rows[0].id);
}

// Moves every bucket-stored file into Dropbox, keeping each row's id.
//
// Keeping the id is the whole point: a re-upload would mint new ids and
// silently break anything pointing at the old ones — clients.
// diagram_file_id, for one, which would unpin an architecture diagram
// with no error anywhere.
//
// Deliberately one-way and one-off. This exists to empty the bucket so
// its code can be deleted, and should go with it.
async function migrateBucketToDropbox({ limit = 500 } = {}) {
  if (!(await dropbox.isConnected())) throw new Error('Dropbox is not connected.');

  const { rows } = await pool.query(
    `SELECT id FROM files WHERE storage_provider = 'bucket' ORDER BY id LIMIT $1`, [limit]);

  const moved = [];
  const failed = [];

  for (const { id } of rows) {
    try {
      const file = await getFile(id);
      const res = await s3().send(new GetObjectCommand({
        Bucket: process.env.FILES_BUCKET,
        Key: file.storageKey,
      }));
      const chunks = [];
      for await (const chunk of res.Body) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      const item = await dropbox.upload(
        `${makeKey(file.name)}-${safeName(file.name)}`, buffer, file.contentType);

      // Row last: if this throws, the file still downloads from the
      // bucket and the migration can simply be run again. The cost is a
      // stray Dropbox copy, which is cheaper than a row pointing at
      // nothing.
      await pool.query(
        `UPDATE files SET storage_key = $2, storage_provider = 'dropbox' WHERE id = $1`,
        [id, item.id]);

      // The bucket object is left in place; the bucket is about to be
      // deleted wholesale, and deleting per-file here would mean a
      // failure halfway leaves no way back.
      moved.push({ id, name: file.name });
    } catch (err) {
      failed.push({ id, error: err.message });
    }
  }
  return { moved, failed };
}

// Dispatches on the row's own provider, not on what is configured now.
// A file uploaded to the bucket before Dropbox was connected must keep
// downloading from the bucket for ever.
async function download(id) {
  const file = await getFile(id);
  if (!file) return null;

  if (file.storageProvider === 'dropbox') {
    return { file, buffer: await dropbox.download(file.storageKey) };
  }

  const res = await s3().send(new GetObjectCommand({
    Bucket: process.env.FILES_BUCKET,
    Key: file.storageKey,
  }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return { file, buffer: Buffer.concat(chunks) };
}

// Overwrites a file's bytes while keeping its id, name, folder and
// storage key. Diagrams get edited over and over, and a new row per save
// would bury the folder in near-identical copies — the file someone
// linked to should stay the file they linked to.
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

  if (file.storageProvider === 'dropbox') {
    // Overwrites in place and keeps the id, and Dropbox keeps the
    // previous copy in its own version history — which the bucket
    // cannot do at all.
    await dropbox.overwrite(file.storageKey, buffer, contentType || file.contentType);
  } else {
    await s3().send(new PutObjectCommand({
      Bucket: process.env.FILES_BUCKET,
      Key: file.storageKey,
      Body: buffer,
      ContentType: contentType || file.contentType || 'application/octet-stream',
    }));
  }

  await pool.query(
    `UPDATE files SET size_bytes = $2, content_type = COALESCE($3, content_type) WHERE id = $1`,
    [id, buffer.length, contentType || null],
  );
  return getFile(id);
}

// Moving a file is purely a metadata change — the object keeps its key,
// because the key is a random UUID that never encoded a path in the
// first place. Nothing touches the bucket.
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
    if (file.storageProvider === 'dropbox') {
      await dropbox.remove(file.storageKey);
    } else {
      await s3().send(new DeleteObjectCommand({
        Bucket: process.env.FILES_BUCKET,
        Key: file.storageKey,
      }));
    }
  } catch (err) {
    // Leaving the row would show a file that can't be downloaded; the
    // orphaned object is the lesser problem, so log and carry on.
    console.error('Could not delete object, removing the row anyway:', err.message);
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
  MAX_BYTES, isConfigured, bucketConfigured, activeProvider, check, migrateBucketToDropbox,
  listFiles, getFile, upload, download, replaceContent, move, remove, stats,
};
