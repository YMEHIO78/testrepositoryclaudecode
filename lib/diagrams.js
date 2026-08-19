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

module.exports = {
  EXT, MIME, isDiagram, normaliseName, blankXml,
  listForClient, create, read, save, file,
};
