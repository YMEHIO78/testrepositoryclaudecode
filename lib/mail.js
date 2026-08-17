// IMAP/SMTP mail integration, for mailboxes hosted outside Microsoft 365
// (this domain's mail is on Hostinger). IMAP reads the inbox, SMTP sends
// replies. Passwords are stored encrypted via lib/crypto.js and never
// leave the server.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const { pool } = require('./db');
const { encryptJSON, decryptJSON } = require('./crypto');

// Hostinger's documented defaults; overridable per account in case a
// mailbox lives somewhere else.
const DEFAULTS = {
  imapHost: process.env.IMAP_HOST || 'imap.hostinger.com',
  imapPort: Number(process.env.IMAP_PORT || 993),
  smtpHost: process.env.SMTP_HOST || 'smtp.hostinger.com',
  smtpPort: Number(process.env.SMTP_PORT || 465),
};

function defaults() {
  return { ...DEFAULTS };
}

async function saveAccount(email, { username, password, imapHost, imapPort, smtpHost, smtpPort }) {
  const { ciphertext, iv, authTag } = encryptJSON({ password });
  await pool.query(
    `INSERT INTO mail_accounts
       (email, username, imap_host, imap_port, smtp_host, smtp_port, encrypted_password, iv, auth_tag, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (email) DO UPDATE SET
       username = $2, imap_host = $3, imap_port = $4, smtp_host = $5,
       smtp_port = $6, encrypted_password = $7, iv = $8, auth_tag = $9,
       updated_at = now()`,
    [
      email,
      username || email,
      imapHost || DEFAULTS.imapHost,
      Number(imapPort) || DEFAULTS.imapPort,
      smtpHost || DEFAULTS.smtpHost,
      Number(smtpPort) || DEFAULTS.smtpPort,
      ciphertext,
      iv,
      authTag,
    ],
  );
}

async function getAccount(email) {
  const { rows } = await pool.query(`SELECT * FROM mail_accounts WHERE email = $1`, [email]);
  if (!rows.length) return null;
  const row = rows[0];
  const { password } = decryptJSON({
    ciphertext: row.encrypted_password,
    iv: row.iv,
    authTag: row.auth_tag,
  });
  return {
    email: row.email,
    username: row.username,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    password,
  };
}

async function listAccounts() {
  const { rows } = await pool.query(`SELECT email FROM mail_accounts ORDER BY email`);
  return rows.map((r) => r.email);
}

async function deleteAccount(email) {
  await pool.query(`DELETE FROM mail_accounts WHERE email = $1`, [email]);
}

function imapClientFor(account) {
  return new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: true,
    auth: { user: account.username, pass: account.password },
    logger: false,
  });
}

// Connect and immediately disconnect — used to validate credentials at
// save time so a typo surfaces right away instead of at first read.
async function verifyCredentials(account) {
  const client = imapClientFor(account);
  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (err) {
    try { client.close(); } catch (_) { /* already down */ }
    return { ok: false, message: err.message };
  }
}

async function fetchMessages(email, { limit = 25 } = {}) {
  const account = await getAccount(email);
  if (!account) return [];

  const client = imapClientFor(account);
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = client.mailbox.exists;
      if (!total) return [];

      const start = Math.max(1, total - limit + 1);
      const messages = [];
      for await (const msg of client.fetch(`${start}:*`, { envelope: true, flags: true, uid: true })) {
        const from = msg.envelope?.from?.[0];
        messages.push({
          id: String(msg.uid),
          account: email,
          subject: msg.envelope?.subject || '(no subject)',
          from: from?.name || from?.address || 'Unknown sender',
          fromAddress: from?.address || '',
          receivedDateTime: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
          messageId: msg.envelope?.messageId || null,
          isRead: msg.flags ? msg.flags.has('\\Seen') : false,
        });
      }
      return messages.reverse(); // newest first
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => { try { client.close(); } catch (_) {} });
  }
}

function transporterFor(account) {
  return nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpPort === 465,
    auth: { user: account.username, pass: account.password },
    // Without these an unreachable or slow SMTP server hangs the request
    // indefinitely rather than failing.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

// Send from a connected mailbox without replying to anything — used for
// booking confirmations. Falls back to the first connected mailbox so
// scheduling works as soon as any mailbox is set up.
async function sendMail({ from, to, subject, text, replyTo }) {
  const sender = from || (await listAccounts())[0];
  if (!sender) throw new Error('No mailbox is connected to send from.');

  const account = await getAccount(sender);
  if (!account) throw new Error(`${sender} is not connected.`);

  await transporterFor(account).sendMail({
    from: account.email,
    to,
    subject,
    text,
    ...(replyTo ? { replyTo } : {}),
  });
  return account.email;
}

// Runs `fn` against an open INBOX and always tears the connection down,
// so a thrown error can't leak a socket.
async function withInbox(email, fn) {
  const account = await getAccount(email);
  if (!account) throw new Error(`${email} is not connected.`);

  const client = imapClientFor(account);
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      return await fn(client, account);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => { try { client.close(); } catch (_) {} });
  }
}

// Full message including body. Kept separate from the list query on
// purpose — downloading bodies for every message in the list would make
// the inbox crawl, so this runs only when a message is opened.
async function getMessage(email, uid) {
  return withInbox(email, async (client) => {
    const msg = await client.fetchOne(String(uid), { source: true, flags: true, envelope: true }, { uid: true });
    if (!msg || !msg.source) return null;

    const parsed = await simpleParser(msg.source);
    return {
      id: String(uid),
      account: email,
      subject: parsed.subject || '(no subject)',
      from: parsed.from?.value?.[0]?.name || parsed.from?.value?.[0]?.address || 'Unknown sender',
      fromAddress: parsed.from?.value?.[0]?.address || '',
      to: (parsed.to?.value || []).map((v) => v.address).filter(Boolean),
      date: parsed.date ? parsed.date.toISOString() : null,
      messageId: parsed.messageId || null,
      text: parsed.text || '',
      html: parsed.html || null,
      isRead: msg.flags ? msg.flags.has('\\Seen') : false,
      // Metadata only — downloading attachment content is not wired up.
      attachments: (parsed.attachments || []).map((a) => ({
        filename: a.filename || '(unnamed)',
        contentType: a.contentType,
        size: a.size,
      })),
    };
  });
}

async function setRead(email, uid, read) {
  return withInbox(email, async (client) => {
    if (read) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    else await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
    return true;
  });
}

// Prefer moving to the server's Trash folder over setting \Deleted, so
// the message stays recoverable from any mail client.
async function deleteMessage(email, uid) {
  return withInbox(email, async (client) => {
    let trash = null;
    try {
      for (const box of await client.list()) {
        if (box.specialUse === '\\Trash') { trash = box.path; break; }
      }
    } catch (err) { /* fall through to the flag approach */ }

    if (trash) {
      await client.messageMove(String(uid), trash, { uid: true });
      return { movedTo: trash };
    }
    await client.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true });
    return { movedTo: null, flagged: true };
  });
}

async function sendReply(email, { to, subject, body, inReplyTo }) {
  const account = await getAccount(email);
  if (!account) throw new Error(`${email} is not connected.`);

  const replySubject = /^re:/i.test(subject || '') ? subject : `Re: ${subject || ''}`.trim();

  await transporterFor(account).sendMail({
    from: account.email,
    to,
    subject: replySubject,
    text: body,
    ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
  });
}

module.exports = {
  defaults,
  saveAccount,
  getAccount,
  listAccounts,
  deleteAccount,
  verifyCredentials,
  fetchMessages,
  getMessage,
  setRead,
  deleteMessage,
  sendMail,
  sendReply,
};
