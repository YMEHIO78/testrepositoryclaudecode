// Wave accounting integration.
//
// Uses a Full Access Token rather than OAuth: OAuth requires the
// *end user's* business to be on Wave's paid tier, whereas a Full Access
// Token works for reading your own business. Same shape as the Calendly
// token — pasted once, validated before storage, kept encrypted.
//
// Query shapes below were confirmed against Wave's live schema by
// introspection, not guessed: Money exposes `minorUnitValue` (cents,
// matching how this app stores money everywhere else), and the invoices
// connection takes page/pageSize/status.
const { pool } = require('./db');
const { encryptJSON, decryptJSON } = require('./crypto');

const ENDPOINT = 'https://gql.waveapps.com/graphql/public';

// Wave rejects inline string arguments — everything goes through variables.
async function gql(token, query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await res.json().catch(() => ({}));
  if (data.errors?.length) {
    const first = data.errors[0];
    const code = first.extensions?.code;
    // Surface Wave's own wording; plan/permission problems read clearly.
    throw new Error(`Wave API${code ? ` (${code})` : ''}: ${first.message}`);
  }
  if (!res.ok) throw new Error(`Wave API returned ${res.status}`);
  return data.data;
}

// --- token storage ---

async function saveToken(token, businessId) {
  const { ciphertext, iv, authTag } = encryptJSON({ token, businessId });
  await pool.query(
    `INSERT INTO oauth_tokens (provider, account_label, encrypted_payload, iv, auth_tag, updated_at)
     VALUES ('wave', 'default', $1, $2, $3, now())
     ON CONFLICT (provider, account_label)
     DO UPDATE SET encrypted_payload = $1, iv = $2, auth_tag = $3, updated_at = now()`,
    [ciphertext, iv, authTag],
  );
}

async function loadCredentials() {
  if (process.env.WAVE_TOKEN) {
    return { token: process.env.WAVE_TOKEN, businessId: process.env.WAVE_BUSINESS_ID || null };
  }
  const { rows } = await pool.query(
    `SELECT encrypted_payload, iv, auth_tag FROM oauth_tokens
      WHERE provider = 'wave' AND account_label = 'default'`,
  );
  if (!rows.length) return null;
  const r = rows[0];
  return decryptJSON({ ciphertext: r.encrypted_payload, iv: r.iv, authTag: r.auth_tag });
}

async function isConnected() {
  return !!(await loadCredentials());
}

async function disconnect() {
  await pool.query(`DELETE FROM oauth_tokens WHERE provider = 'wave'`);
}

async function setBusiness(businessId) {
  const creds = await loadCredentials();
  if (!creds) throw new Error('Wave is not connected.');
  await saveToken(creds.token, businessId);
}

// --- queries ---

// `businesses` is a ROOT field, not a field on User — User exposes only
// id/defaultEmail/names. Querying it under user fails validation.
const BUSINESSES_QUERY = `
  query Businesses {
    user { id defaultEmail }
    businesses(page: 1, pageSize: 20, isArchived: false) {
      edges { node { id name isArchived currency { code } } }
    }
  }`;

const INVOICES_QUERY = `
  query Invoices($businessId: ID!, $page: Int!, $pageSize: Int!) {
    business(id: $businessId) {
      id
      name
      invoices(page: $page, pageSize: $pageSize, sort: [INVOICE_DATE_DESC]) {
        pageInfo { currentPage totalPages totalCount }
        edges {
          node {
            id
            invoiceNumber
            status
            invoiceDate
            dueDate
            viewUrl
            customer { id name }
            total { minorUnitValue currency { code } }
            amountDue { minorUnitValue }
            amountPaid { minorUnitValue }
          }
        }
      }
    }
  }`;

async function listBusinesses(token) {
  const data = await gql(token, BUSINESSES_QUERY);
  const edges = data?.businesses?.edges || [];
  return {
    email: data?.user?.defaultEmail || null,
    businesses: edges
      .map((e) => e.node)
      .filter((b) => !b.isArchived)
      .map((b) => ({ id: b.id, name: b.name, currency: b.currency?.code || null })),
  };
}

async function fetchInvoices({ pageSize = 100 } = {}) {
  const creds = await loadCredentials();
  if (!creds) return null;
  if (!creds.businessId) throw new Error('No Wave business selected.');

  const data = await gql(creds.token, INVOICES_QUERY, {
    businessId: creds.businessId,
    page: 1,
    pageSize,
  });

  const conn = data?.business?.invoices;
  return {
    businessName: data?.business?.name || null,
    totalCount: conn?.pageInfo?.totalCount ?? 0,
    invoices: (conn?.edges || []).map((e) => {
      const n = e.node;
      return {
        id: n.id,
        number: n.invoiceNumber,
        status: n.status,
        invoiceDate: n.invoiceDate,
        dueDate: n.dueDate,
        viewUrl: n.viewUrl,
        customer: n.customer?.name || null,
        currency: n.total?.currency?.code || null,
        // minorUnitValue is already cents, matching the rest of the app.
        totalCents: Number(n.total?.minorUnitValue ?? 0),
        dueCents: Number(n.amountDue?.minorUnitValue ?? 0),
        paidCents: Number(n.amountPaid?.minorUnitValue ?? 0),
      };
    }),
  };
}

// Rolls invoices into the figures the dashboard's cash panel wants.
// Deliberately derived only from invoices — Wave's expense side isn't
// wired up, so "expenses" stays absent rather than being guessed at.
function summarise(invoices) {
  const now = Date.now();
  const outstanding = invoices.filter((i) => i.dueCents > 0 && i.status !== 'DRAFT');

  const awaitingCents = outstanding.reduce((s, i) => s + i.dueCents, 0);
  const overdueCents = outstanding
    .filter((i) => i.status === 'OVERDUE' ||
      (i.dueDate && (now - new Date(i.dueDate).getTime()) > 30 * 86400000))
    .reduce((s, i) => s + i.dueCents, 0);

  const draftCents = invoices
    .filter((i) => i.status === 'DRAFT')
    .reduce((s, i) => s + i.totalCents, 0);

  return {
    awaitingCents,
    overdueCents,
    draftCents,
    outstandingCount: outstanding.length,
  };
}

module.exports = {
  gql,
  saveToken,
  loadCredentials,
  isConnected,
  disconnect,
  setBusiness,
  listBusinesses,
  fetchInvoices,
  summarise,
};
