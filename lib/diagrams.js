// Diagrams: draw.io files, stored as ordinary files.
//
// There is no diagrams table. A diagram is a .drawio file in the files
// table like any other, which means it inherits folders, client filing,
// move, delete and the backup export for free. This module is a thin
// lens over files.js, not a parallel system — the moment diagrams need
// their own storage is the moment they stop appearing in Files &
// Folders, and they should appear there.
//
// The editor is draw.io in embed mode (see public/diagram.html). Embed
// mode inverts the usual arrangement: the editor holds no storage of its
// own and hands the XML back to the page that opened it, so this app is
// the storage backend rather than a place you export to afterwards.
const files = require('./files');
const { pool } = require('./db');

const EXT = '.drawio';
// draw.io's own type for the format. Stored so a download re-opens in
// the desktop app rather than as a text file.
const MIME = 'application/vnd.jgraph.mxfile';

function isDiagram(name) {
  return /\.(drawio|dio)$/i.test(String(name || ''));
}

// A filename that will round-trip: draw.io decides how to open a file by
// its extension, so one without .drawio would come back as plain XML.
function normaliseName(name) {
  const trimmed = String(name || '').trim().replace(/[\\/]+/g, '-').slice(0, 180);
  if (!trimmed) return `Untitled${EXT}`;
  return isDiagram(trimmed) ? trimmed : trimmed + EXT;
}

// An empty page. draw.io will accept an empty string and start blank,
// but then the stored file is zero bytes and downloads as something that
// no other tool can open, so it gets a real skeleton from the start.
function blankXml() {
  return '<mxfile host="pocket-data-office">'
    + '<diagram name="Page-1">'
    + '<mxGraphModel dx="1042" dy="655" grid="1" gridSize="10" guides="1" tooltips="1"'
    + ' connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850"'
    + ' pageHeight="1100" math="0" shadow="0">'
    + '<root><mxCell id="0"/><mxCell id="1" parent="0"/></root>'
    + '</mxGraphModel></diagram></mxfile>';
}

async function listForClient(clientId) {
  const all = await files.listFiles({ clientId });
  return all.filter((f) => isDiagram(f.name));
}

async function create({ name, clientId, folderId }) {
  return files.upload({
    name: normaliseName(name),
    buffer: Buffer.from(blankXml(), 'utf8'),
    contentType: MIME,
    clientId: clientId || null,
    folderId: folderId || null,
  });
}

// Returns null for a file that is not a diagram as well as for one that
// does not exist. The editor route should not open arbitrary files and
// hand their bytes to a third-party iframe.
async function read(id) {
  const file = await files.getFile(id);
  if (!file || !isDiagram(file.name)) return null;
  const got = await files.download(id);
  if (!got) return null;
  return { file, xml: got.buffer.toString('utf8') };
}

async function save(id, xml) {
  const file = await files.getFile(id);
  if (!file || !isDiagram(file.name)) return null;
  if (typeof xml !== 'string' || !xml.trim()) throw new Error('Empty diagram.');
  return files.replaceContent(id, Buffer.from(xml, 'utf8'), MIME);
}

// Re-filing: which client and folder a diagram belongs to, plus its
// name. files.move only handles folders, and the point of doing this
// from inside the editor is to be able to say "this one belongs to that
// client" without going back to Files & Folders to drag it.
//
// A null clientId is a real answer meaning "no client", so the caller
// signals "leave it alone" by omitting the key rather than passing null.
async function file(id, { name, clientId, folderId } = {}) {
  const existing = await files.getFile(id);
  if (!existing || !isDiagram(existing.name)) return null;

  const sets = [];
  const values = [id];
  if (name !== undefined) { values.push(normaliseName(name)); sets.push(`name = $${values.length}`); }
  if (clientId !== undefined) { values.push(clientId); sets.push(`client_id = $${values.length}`); }
  if (folderId !== undefined) { values.push(folderId); sets.push(`folder_id = $${values.length}`); }
  if (!sets.length) return existing;

  await pool.query(`UPDATE files SET ${sets.join(', ')} WHERE id = $1`, values);
  return files.getFile(id);
}

// A rendered preview, as an SVG data URI produced by the editor in the
// browser. Capped so a diagram with a big embedded bitmap cannot sit in
// a row that gets read on every client page load; over the cap the
// preview is dropped rather than the save failing, since the .drawio
// itself is what matters. It is excluded from the backup export as a
// cache — see SKIP_COLUMNS in lib/export.js.
const MAX_PREVIEW_BYTES = 512 * 1024;

// Only ever an SVG data URI. Accepting arbitrary strings here would mean
// putting whatever the page sent into an <img src> on the client page.
function isSvgDataUri(value) {
  return typeof value === 'string' && /^data:image\/svg\+xml[;,]/.test(value);
}

async function savePreview(id, dataUri) {
  const f = await files.getFile(id);
  if (!f || !isDiagram(f.name)) return null;

  if (dataUri === null) {
    await pool.query(`UPDATE files SET preview_svg = NULL WHERE id = $1`, [id]);
    return { id, preview: false };
  }
  if (!isSvgDataUri(dataUri)) throw new Error('A preview must be an SVG data URI.');
  if (dataUri.length > MAX_PREVIEW_BYTES) return { id, preview: false, tooLarge: true };

  await pool.query(`UPDATE files SET preview_svg = $2 WHERE id = $1`, [id, dataUri]);
  return { id, preview: true };
}

// The diagram pinned to a client's page, preview included. Everything
// else that lists diagrams leaves preview_svg out — it is far larger
// than the rest of the row and would bloat every listing.
async function pinnedFor(clientId) {
  const { rows } = await pool.query(
    `SELECT f.id, f.name, f.preview_svg, f.size_bytes
       FROM clients c JOIN files f ON f.id = c.diagram_file_id
      WHERE c.id = $1`,
    [clientId],
  );
  if (!rows.length) return null;
  return {
    id: rows[0].id,
    name: rows[0].name,
    preview: rows[0].preview_svg,
    sizeBytes: rows[0].size_bytes === null ? null : Number(rows[0].size_bytes),
  };
}

// Passing null unpins. The file must belong to this client, or a diagram
// could be pinned onto somebody else's page.
async function pin(clientId, fileId) {
  if (fileId === null) {
    await pool.query(`UPDATE clients SET diagram_file_id = NULL WHERE id = $1`, [clientId]);
    return { pinned: null };
  }
  const f = await files.getFile(fileId);
  if (!f || !isDiagram(f.name)) throw new Error('That is not a diagram.');
  if (f.clientId !== clientId) throw new Error('That diagram belongs to a different client.');

  await pool.query(`UPDATE clients SET diagram_file_id = $2 WHERE id = $1`, [clientId, fileId]);
  return { pinned: fileId };
}

module.exports = {
  EXT, MIME, isDiagram, normaliseName, blankXml, MAX_PREVIEW_BYTES,
  listForClient, create, read, save, file, savePreview, pinnedFor, pin,
};
