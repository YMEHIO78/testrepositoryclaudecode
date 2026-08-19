// The AI agent: a chat that can read this app's records and propose
// changes to them.
//
// THE SAFETY MODEL, in one sentence: read tools execute immediately,
// write tools do not execute at all — they write a row to agent_actions
// and the turn ends. Nothing in the app changes until a human opens the
// approval queue and approves that row.
//
// This is why the queue is a table rather than an in-process callback.
// Approval happens in a later HTTP request, possibly minutes later,
// possibly after a page reload, possibly never. An in-memory promise
// waiting on a click cannot survive any of that.
//
// The split is the whole design. A tool either reads (safe, immediate) or
// writes (queued, never automatic). There is deliberately no third case,
// and no way for the model to move a tool between the two.
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('./db');
const crm = require('./crm');
const tickets = require('./tickets');
const search = require('./search');

const MODEL = 'claude-opus-5';
const MAX_TOKENS = 8000;

// Bounds one user message: at most this many model round trips before the
// turn is cut off. Without it a confused loop could bill indefinitely.
const MAX_ITERATIONS = 8;

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

let client = null;
function anthropic() {
  if (!isConfigured()) throw new Error('ANTHROPIC_API_KEY is not set.');
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const SYSTEM = `You are the assistant inside Pocket Data Office, an internal ops app for a small data consultancy. You are talking to the owner.

The app holds their clients and leads, service desk tickets, projects, people, files, calendar and meetings, and accounting figures read from Wave.

How you work:

- Read tools run immediately. Use them freely to ground what you say. Never state a figure, name, date or status you have not read from a tool this turn.
- Write tools do NOT take effect. They queue a proposal for the owner to approve or reject in the app. Say plainly that you have queued something and what it would do; never claim you have created, changed or updated anything.
- Propose the smallest set of actions that does the job. One ticket, not one ticket plus a project plus a follow-up nobody asked for.
- If a request is ambiguous in a way that changes what you would queue, ask instead of guessing.

Answer in plain prose. Lead with the answer, then the supporting detail. Keep it short — this is a side panel, not a report.`;

// --- tools ---
//
// Read tools: name -> { schema, run }. These execute the moment the model
// asks, because reading cannot damage anything.
const READ_TOOLS = {
  search_records: {
    description: 'Search across clients, tickets, projects, files and people by keyword. Use this first when the owner names something you do not have an id for.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Two or more characters.' } },
      required: ['query'],
    },
    run: async ({ query }) => search.search(query),
  },

  get_client: {
    description: "A client's full record: stage, terms, health, packages and derived value, their tickets, and their meetings.",
    input_schema: {
      type: 'object',
      properties: { clientId: { type: 'integer' } },
      required: ['clientId'],
    },
    run: async ({ clientId }) => {
      const client_ = await crm.getClient(Number(clientId));
      if (!client_) return { error: 'No client with that id.' };
      const packages = require('./packages');
      const calendar = require('./calendar');
      const all = await tickets.listTickets({ openOnly: false });
      return {
        client: client_,
        packages: await packages.clientPackages(client_.id),
        tickets: all.filter((t) => t.clientId === client_.id),
        meetings: await calendar.listEvents({ clientId: client_.id }),
      };
    },
  },

  list_open_tickets: {
    description: 'Every open ticket, with client, priority and SLA date.',
    input_schema: { type: 'object', properties: {} },
    run: async () => ({ tickets: await tickets.listTickets({ openOnly: true }) }),
  },
};

// Write tools: name -> { schema, summarise }. These never run. `summarise`
// turns the model's arguments into the one line a human reads in the
// approval queue, so the decision can be made without reading JSON.
const WRITE_TOOLS = {
  create_ticket: {
    description: 'Propose a new service desk ticket. Queued for approval; this does not create anything.',
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        body: { type: 'string' },
        clientId: { type: 'integer', description: 'Optional. Omit if it is not for a specific client.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        slaDueAt: { type: 'string', description: 'Optional ISO 8601 timestamp.' },
      },
      required: ['subject'],
    },
    summarise: (i) => `Create ${i.priority || 'normal'}-priority ticket “${i.subject}”`
      + (i.clientId ? ` for client #${i.clientId}` : '')
      + (i.slaDueAt ? `, SLA ${String(i.slaDueAt).slice(0, 10)}` : ''),
    execute: (i) => tickets.createTicket(i),
  },

  update_ticket: {
    description: 'Propose a change to an existing ticket — status, priority, or SLA date. Queued for approval.',
    input_schema: {
      type: 'object',
      properties: {
        ticketId: { type: 'integer' },
        status: { type: 'string', enum: ['open', 'in_progress', 'waiting', 'resolved', 'closed'] },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        slaDueAt: { type: 'string', description: 'ISO 8601 timestamp, or empty string to clear.' },
      },
      required: ['ticketId'],
    },
    summarise: (i) => `Update ticket #${i.ticketId}: `
      + [i.status && `status → ${i.status}`, i.priority && `priority → ${i.priority}`,
        i.slaDueAt !== undefined && `SLA → ${i.slaDueAt || 'cleared'}`].filter(Boolean).join(', '),
    execute: (i) => tickets.updateTicket(Number(i.ticketId), i),
  },

  create_client: {
    description: 'Propose a new client or lead. Queued for approval.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        stage: { type: 'string', enum: ['in_contact', 'engaging', 'offer_sent', 'client', 'lost'] },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
    summarise: (i) => `Add ${i.stage === 'client' ? 'client' : 'lead'} “${i.name}”`
      + (i.stage ? ` at stage ${i.stage}` : ''),
    execute: (i) => crm.createClient(i),
  },

  update_client: {
    description: 'Propose a change to a client — stage, terms, or health. Queued for approval.',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'integer' },
        stage: { type: 'string', enum: ['in_contact', 'engaging', 'offer_sent', 'client', 'lost'] },
        terms: { type: 'string', enum: ['Retainer', 'Project', 'Internal'] },
        health: { type: 'string', enum: ['Green', 'Watch', 'At risk'] },
      },
      required: ['clientId'],
    },
    summarise: (i) => `Update client #${i.clientId}: `
      + [i.stage && `stage → ${i.stage}`, i.terms && `terms → ${i.terms}`,
        i.health && `health → ${i.health}`].filter(Boolean).join(', '),
    execute: (i) => crm.updateClient(Number(i.clientId), i),
  },
};

function toolDefinitions() {
  return [
    ...Object.entries(READ_TOOLS).map(([name, t]) => ({
      name, description: t.description, input_schema: t.input_schema,
    })),
    ...Object.entries(WRITE_TOOLS).map(([name, t]) => ({
      name, description: t.description, input_schema: t.input_schema,
    })),
  ];
}

// --- conversation storage ---

async function createConversation(title) {
  const { rows } = await pool.query(
    `INSERT INTO agent_conversations (title) VALUES ($1) RETURNING *`,
    [title || null],
  );
  return rows[0];
}

async function listConversations() {
  const { rows } = await pool.query(
    `SELECT c.*,
            (SELECT count(*) FROM agent_actions a
              WHERE a.conversation_id = c.id AND a.status = 'pending') AS pending
       FROM agent_conversations c ORDER BY c.updated_at DESC LIMIT 50`,
  );
  return rows.map((r) => ({
    id: r.id, title: r.title, createdAt: r.created_at,
    updatedAt: r.updated_at, pending: Number(r.pending),
  }));
}

async function loadMessages(conversationId) {
  const { rows } = await pool.query(
    `SELECT role, content FROM agent_messages WHERE conversation_id = $1 ORDER BY id`,
    [conversationId],
  );
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

async function saveMessage(conversationId, role, content, usage) {
  const { rows } = await pool.query(
    `INSERT INTO agent_messages (conversation_id, role, content, input_tokens, output_tokens)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [conversationId, role, JSON.stringify(content),
      usage?.input_tokens ?? null, usage?.output_tokens ?? null],
  );
  await pool.query(`UPDATE agent_conversations SET updated_at = now() WHERE id = $1`, [conversationId]);
  return rows[0].id;
}

// --- the approval queue ---

async function queueAction(conversationId, toolUseId, kind, input) {
  const spec = WRITE_TOOLS[kind];
  const { rows } = await pool.query(
    `INSERT INTO agent_actions (conversation_id, tool_use_id, kind, input, summary)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [conversationId, toolUseId, kind, JSON.stringify(input), spec.summarise(input)],
  );
  return rows[0];
}

function toAction(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    kind: row.kind,
    input: row.input,
    summary: row.summary,
    status: row.status,
    result: row.result,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

async function listActions({ pendingOnly = false } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM agent_actions ${pendingOnly ? "WHERE status = 'pending'" : ''}
      ORDER BY id DESC LIMIT 100`,
  );
  return rows.map(toAction);
}

// Approve and run. The status flips inside the same statement that claims
// the row, so a double-click cannot execute an action twice: the second
// call matches no pending row and does nothing.
async function decideAction(id, approve) {
  const { rows } = await pool.query(
    `UPDATE agent_actions SET status = $2, decided_at = now()
      WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, approve ? 'approved' : 'rejected'],
  );
  if (!rows.length) return null;
  const action = rows[0];
  if (!approve) return toAction(action);

  try {
    const spec = WRITE_TOOLS[action.kind];
    if (!spec) throw new Error(`Unknown action kind: ${action.kind}`);
    const result = await spec.execute(action.input);
    const { rows: done } = await pool.query(
      `UPDATE agent_actions SET status = 'executed', result = $2 WHERE id = $1 RETURNING *`,
      [id, `Done: ${result?.reference || result?.name || result?.id || 'ok'}`],
    );
    return toAction(done[0]);
  } catch (err) {
    const { rows: failed } = await pool.query(
      `UPDATE agent_actions SET status = 'failed', result = $2 WHERE id = $1 RETURNING *`,
      [id, err.message.slice(0, 500)],
    );
    return toAction(failed[0]);
  }
}

// --- the turn ---

async function runTurn(conversationId, userText) {
  const history = await loadMessages(conversationId);
  const messages = [...history, { role: 'user', content: [{ type: 'text', text: userText }] }];
  await saveMessage(conversationId, 'user', [{ type: 'text', text: userText }]);

  const queued = [];
  let iterations = 0;

  // A manual loop rather than the SDK's tool runner: a write tool here
  // never executes, so there is no function for the runner to call. The
  // loop's job is to answer tool_use blocks with "queued", which is not
  // what the runner is shaped for.
  while (iterations < MAX_ITERATIONS) {
    iterations += 1;

    const response = await anthropic().beta.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      tools: toolDefinitions(),
      messages,
      // Opus 5's safety classifiers can decline a request; this re-runs it
      // on Anthropic's recommended fallback rather than returning nothing.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });

    // Check before reading content: a refusal can arrive with content
    // empty, and indexing into it would throw rather than explain.
    if (response.stop_reason === 'refusal') {
      const note = [{ type: 'text', text: 'I was not able to answer that one.' }];
      await saveMessage(conversationId, 'assistant', note, response.usage);
      return { reply: note, queued, refused: true };
    }

    messages.push({ role: 'assistant', content: response.content });
    await saveMessage(conversationId, 'assistant', response.content, response.usage);

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length) {
      return { reply: response.content, queued, refused: false };
    }

    // Every tool_use must get a tool_result in one user message, or the
    // model learns to stop making parallel calls.
    const results = [];
    for (const use of toolUses) {
      if (READ_TOOLS[use.name]) {
        try {
          const data = await READ_TOOLS[use.name].run(use.input || {});
          results.push({
            type: 'tool_result', tool_use_id: use.id,
            content: JSON.stringify(data).slice(0, 60000),
          });
        } catch (err) {
          results.push({
            type: 'tool_result', tool_use_id: use.id,
            content: `Error: ${err.message}`, is_error: true,
          });
        }
      } else if (WRITE_TOOLS[use.name]) {
        const action = await queueAction(conversationId, use.id, use.name, use.input || {});
        queued.push(toAction(action));
        results.push({
          type: 'tool_result', tool_use_id: use.id,
          content: `Queued for the owner's approval: ${action.summary}. `
            + 'Nothing has changed yet and will not until they approve it.',
        });
      } else {
        results.push({
          type: 'tool_result', tool_use_id: use.id,
          content: `No such tool: ${use.name}`, is_error: true,
        });
      }
    }

    messages.push({ role: 'user', content: results });
    await saveMessage(conversationId, 'user', results);
  }

  const note = [{ type: 'text', text: `I stopped after ${MAX_ITERATIONS} steps without finishing. Try narrowing the request.` }];
  await saveMessage(conversationId, 'assistant', note);
  return { reply: note, queued, refused: false };
}

// Token spend to date, so the cost of this feature is visible rather than
// arriving on a bill.
async function usage() {
  const { rows } = await pool.query(
    `SELECT COALESCE(sum(input_tokens),0)::bigint AS input,
            COALESCE(sum(output_tokens),0)::bigint AS output
       FROM agent_messages`,
  );
  const input = Number(rows[0].input);
  const output = Number(rows[0].output);
  // Claude Opus 5 list pricing: $5 per million in, $25 per million out.
  return {
    inputTokens: input,
    outputTokens: output,
    estimatedCents: Math.round(((input / 1e6) * 5 + (output / 1e6) * 25) * 100),
  };
}

module.exports = {
  MODEL, isConfigured, toolDefinitions,
  createConversation, listConversations, loadMessages,
  runTurn, listActions, decideAction, usage,
  READ_TOOLS, WRITE_TOOLS,
};
