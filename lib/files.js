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

const MAX_BYTES = Number(process.env.FILES_MAX_BYTES || 25 * 1024 * 1024);

function isConfigured() {
  return !!(process.env.FILES_BUCKET && process.env.FILES_ACCESS_KEY_ID
    && process.env.FILES_SECRET_ACCESS_KEY && process.env.FILES_ENDPOINT);
}

let client = null;
function s3() {
  if (!isConfigured()) throw new Error('File storage is not configured.');
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
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
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

  const key = makeKey(name);
  await s3().send(new PutObjectCommand({
    Bucket: process.env.FILES_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  }));

  // Object first, row second: a row without an object is a broken
  // download, whereas an object without a row is just wasted pennies.
  const { rows } = await pool.query(
    `INSERT INTO files (name, storage_key, content_type, size_bytes, client_id, project_id, folder_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [name, key, contentType || null, buffer.length, clientId || null, projectId || null,
      folderId || null, notes || null],
  );
  return getFile(rows[0].id);
}

async function download(id) {
  const file = await getFile(id);
  if (!file) return null;
  const res = await s3().send(new GetObjectCommand({
    Bucket: process.env.FILES_BUCKET,
    Key: file.storageKey,
  }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return { file, buffer: Buffer.concat(chunks) };
}

async function remove(id) {
  const file = await getFile(id);
  if (!file) return false;
  try {
    await s3().send(new DeleteObjectCommand({
      Bucket: process.env.FILES_BUCKET,
      Key: file.storageKey,
    }));
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
  MAX_BYTES, isConfigured, check,
  listFiles, getFile, upload, download, remove, stats,
};
