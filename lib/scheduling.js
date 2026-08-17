// Self-hosted scheduling — the Calendly-equivalent piece.
//
// The reason this exists rather than leaning on Calendly: slot
// availability is computed directly against calendar_events, so every
// event the app knows about — manual blocks, imported bookings, anything
// added later — is subtracted from what's offered. Double-booking is
// prevented by construction rather than by mirroring availability into
// a third-party calendar and hoping it syncs in time.
const crypto = require('crypto');
const { DateTime } = require('luxon');
const { pool } = require('./db');

const DEFAULT_TZ = 'America/New_York';

async function getTimezone() {
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = 'booking_timezone'`);
  return rows.length ? rows[0].value : DEFAULT_TZ;
}

async function setTimezone(tz) {
  if (!DateTime.local().setZone(tz).isValid) throw new Error(`Unknown timezone: ${tz}`);
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('booking_timezone', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [tz],
  );
}

// --- event types ---

function slugify(value) {
  return String(value).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'meeting';
}

function toEventType(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    durationMinutes: row.duration_minutes,
    bufferBeforeMinutes: row.buffer_before_minutes,
    bufferAfterMinutes: row.buffer_after_minutes,
    minNoticeMinutes: row.min_notice_minutes,
    maxDaysAhead: row.max_days_ahead,
    location: row.location,
    active: row.active,
  };
}

async function listEventTypes({ activeOnly = false } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM booking_event_types ${activeOnly ? 'WHERE active' : ''} ORDER BY name`,
  );
  return rows.map(toEventType);
}

async function getEventTypeBySlug(slug) {
  const { rows } = await pool.query(`SELECT * FROM booking_event_types WHERE slug = $1`, [slug]);
  return rows.length ? toEventType(rows[0]) : null;
}

async function createEventType(input) {
  const { rows } = await pool.query(
    `INSERT INTO booking_event_types
       (slug, name, description, duration_minutes, buffer_before_minutes,
        buffer_after_minutes, min_notice_minutes, max_days_ahead, location, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      slugify(input.slug || input.name),
      input.name,
      input.description || null,
      Number(input.durationMinutes) || 30,
      Number(input.bufferBeforeMinutes) || 0,
      Number(input.bufferAfterMinutes) || 0,
      Number(input.minNoticeMinutes) || 0,
      Number(input.maxDaysAhead) || 60,
      input.location || null,
      input.active !== false,
    ],
  );
  return toEventType(rows[0]);
}

async function updateEventType(id, input) {
  const { rows } = await pool.query(
    `UPDATE booking_event_types SET
       name = COALESCE($2, name),
       description = $3,
       duration_minutes = COALESCE($4, duration_minutes),
       buffer_before_minutes = COALESCE($5, buffer_before_minutes),
       buffer_after_minutes = COALESCE($6, buffer_after_minutes),
       min_notice_minutes = COALESCE($7, min_notice_minutes),
       max_days_ahead = COALESCE($8, max_days_ahead),
       location = $9,
       active = COALESCE($10, active),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      id,
      input.name ?? null,
      input.description || null,
      input.durationMinutes ?? null,
      input.bufferBeforeMinutes ?? null,
      input.bufferAfterMinutes ?? null,
      input.minNoticeMinutes ?? null,
      input.maxDaysAhead ?? null,
      input.location || null,
      input.active ?? null,
    ],
  );
  return rows.length ? toEventType(rows[0]) : null;
}

async function deleteEventType(id) {
  const { rowCount } = await pool.query(`DELETE FROM booking_event_types WHERE id = $1`, [id]);
  return rowCount > 0;
}

// --- weekly availability ---

async function getAvailability() {
  const { rows } = await pool.query(
    `SELECT weekday, start_minute, end_minute FROM booking_availability ORDER BY weekday, start_minute`,
  );
  return rows.map((r) => ({ weekday: r.weekday, startMinute: r.start_minute, endMinute: r.end_minute }));
}

// Replaces the whole schedule — simpler and less error-prone than
// diffing individual windows from the UI.
async function setAvailability(windows) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM booking_availability`);
    for (const w of windows) {
      const weekday = Number(w.weekday);
      const start = Number(w.startMinute);
      const end = Number(w.endMinute);
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
      if (!(end > start)) continue;
      await client.query(
        `INSERT INTO booking_availability (weekday, start_minute, end_minute) VALUES ($1,$2,$3)`,
        [weekday, start, end],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- slot computation ---

// Every existing event counts as busy regardless of where it came from.
// That is the whole point: one source of truth means the scheduler can't
// offer time that's already committed.
async function busyIntervals(fromISO, toISO) {
  const { rows } = await pool.query(
    `SELECT starts_at, ends_at, all_day, title
       FROM calendar_events
      WHERE starts_at < $2 AND COALESCE(ends_at, starts_at + interval '1 hour') > $1`,
    [fromISO, toISO],
  );
  return rows.map((r) => {
    const start = new Date(r.starts_at);
    // An all-day event blocks the whole day; a timed event with no end
    // is treated as an hour, matching how it renders elsewhere.
    const end = r.all_day
      ? new Date(start.getTime() + 86400000)
      : (r.ends_at ? new Date(r.ends_at) : new Date(start.getTime() + 3600000));
    return { start: start.getTime(), end: end.getTime() };
  });
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Returns available start times as UTC ISO strings. The caller renders
// them in whatever timezone the visitor is in.
async function availableSlots(eventType, { from, to } = {}) {
  const tz = await getTimezone();
  const availability = await getAvailability();
  if (!availability.length) return { timezone: tz, slots: [] };

  const now = DateTime.utc();
  const earliest = now.plus({ minutes: eventType.minNoticeMinutes });
  const latest = now.plus({ days: eventType.maxDaysAhead });

  let windowStart = from ? DateTime.fromISO(from, { zone: 'utc' }) : earliest;
  let windowEnd = to ? DateTime.fromISO(to, { zone: 'utc' }) : latest;
  if (windowStart < earliest) windowStart = earliest;
  if (windowEnd > latest) windowEnd = latest;
  if (windowEnd <= windowStart) return { timezone: tz, slots: [] };

  const busy = await busyIntervals(windowStart.toISO(), windowEnd.toISO());

  const byWeekday = new Map();
  for (const w of availability) {
    if (!byWeekday.has(w.weekday)) byWeekday.set(w.weekday, []);
    byWeekday.get(w.weekday).push(w);
  }

  const slots = [];
  const duration = eventType.durationMinutes;
  const bufferBefore = eventType.bufferBeforeMinutes;
  const bufferAfter = eventType.bufferAfterMinutes;

  // Walk local calendar days so DST transitions are handled by luxon
  // rather than by adding fixed 24h offsets.
  let day = windowStart.setZone(tz).startOf('day');
  const lastDay = windowEnd.setZone(tz).endOf('day');

  while (day <= lastDay && slots.length < 500) {
    // luxon weekday: 1=Mon..7=Sun; our storage: 0=Sun..6=Sat.
    const weekday = day.weekday === 7 ? 0 : day.weekday;
    const windows = byWeekday.get(weekday) || [];

    for (const w of windows) {
      let cursor = day.plus({ minutes: w.startMinute });
      const windowClose = day.plus({ minutes: w.endMinute });

      while (cursor.plus({ minutes: duration }) <= windowClose) {
        const slotStart = cursor.toUTC();
        const slotEnd = slotStart.plus({ minutes: duration });

        const withinRange = slotStart >= windowStart && slotStart <= windowEnd;
        if (withinRange) {
          // Both sides get padded. Padding only the candidate would let a
          // slot butt directly against the end of an existing meeting —
          // the buffer has to apply to what's already booked as well, or
          // it buys no breathing room at all.
          const guardStart = slotStart.minus({ minutes: bufferBefore }).toMillis();
          const guardEnd = slotEnd.plus({ minutes: bufferAfter }).toMillis();
          const clash = busy.some((b) =>
            overlaps(guardStart, guardEnd, b.start - bufferBefore * 60000, b.end + bufferAfter * 60000));
          if (!clash) slots.push(slotStart.toISO());
        }
        cursor = cursor.plus({ minutes: duration });
      }
    }
    day = day.plus({ days: 1 });
  }

  return { timezone: tz, slots };
}

// --- booking ---

// Re-checks availability inside a transaction. Between a visitor loading
// slots and submitting, the slot may have been taken; without this the
// scheduler would cheerfully double-book.
async function createBooking(eventType, { startsAt, name, email, notes }) {
  const start = DateTime.fromISO(startsAt, { zone: 'utc' });
  if (!start.isValid) throw new Error('That start time is not valid.');

  const end = start.plus({ minutes: eventType.durationMinutes });
  const guardStart = start.minus({ minutes: eventType.bufferBeforeMinutes });
  const guardEnd = end.plus({ minutes: eventType.bufferAfterMinutes });

  if (start < DateTime.utc().plus({ minutes: eventType.minNoticeMinutes })) {
    throw new Error('That time is no longer available.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serializable so two simultaneous bookings can't both pass the
    // conflict check and land on the same slot.
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');

    // Same padding on both sides as availableSlots, so what's bookable
    // here matches exactly what was offered there.
    const { rows: conflicts } = await client.query(
      `SELECT 1 FROM calendar_events
        WHERE (starts_at - ($3 || ' minutes')::interval) < $2::timestamptz
          AND (COALESCE(ends_at, starts_at + interval '1 hour') + ($4 || ' minutes')::interval) > $1::timestamptz
        LIMIT 1`,
      [
        guardStart.toISO(),
        guardEnd.toISO(),
        String(eventType.bufferBeforeMinutes),
        String(eventType.bufferAfterMinutes),
      ],
    );
    if (conflicts.length) {
      await client.query('ROLLBACK');
      throw new Error('That time was just taken. Please pick another slot.');
    }

    const title = `${eventType.name} — ${name}`;
    const { rows: eventRows } = await client.query(
      `INSERT INTO calendar_events (title, starts_at, ends_at, all_day, location, notes, source)
       VALUES ($1,$2,$3,false,$4,$5,'booking') RETURNING id`,
      [
        title,
        start.toISO(),
        end.toISO(),
        eventType.location || null,
        [`Booked by ${name} <${email}>`, notes].filter(Boolean).join('\n\n'),
      ],
    );

    const cancelToken = crypto.randomBytes(24).toString('hex');
    const { rows: bookingRows } = await client.query(
      `INSERT INTO bookings (event_id, event_type_id, invitee_name, invitee_email, notes, cancel_token)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, cancel_token`,
      [eventRows[0].id, eventType.id, name, email, notes || null, cancelToken],
    );

    await client.query('COMMIT');
    return {
      id: bookingRows[0].id,
      eventId: eventRows[0].id,
      cancelToken,
      startsAt: start.toISO(),
      endsAt: end.toISO(),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getBookingByToken(token) {
  const { rows } = await pool.query(
    `SELECT b.*, e.starts_at, e.ends_at, t.name AS event_type_name, t.location
       FROM bookings b
       LEFT JOIN calendar_events e ON e.id = b.event_id
       LEFT JOIN booking_event_types t ON t.id = b.event_type_id
      WHERE b.cancel_token = $1`,
    [token],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id,
    eventId: r.event_id,
    inviteeName: r.invitee_name,
    inviteeEmail: r.invitee_email,
    notes: r.notes,
    canceledAt: r.canceled_at,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    eventTypeName: r.event_type_name,
    location: r.location,
  };
}

// Frees the slot by removing the calendar event; the booking row stays
// as a record, marked cancelled.
async function cancelBooking(token) {
  const booking = await getBookingByToken(token);
  if (!booking) return null;
  if (booking.canceledAt) return booking;

  await pool.query(`UPDATE bookings SET canceled_at = now() WHERE id = $1`, [booking.id]);
  if (booking.eventId) {
    await pool.query(`DELETE FROM calendar_events WHERE id = $1`, [booking.eventId]);
  }
  return { ...booking, canceledAt: new Date().toISOString() };
}

// Owner-side cancellation. The invitee has their emailed link; without
// this the owner would have no way to free a slot when someone cancels
// by phone or email instead.
async function cancelBookingById(id) {
  const { rows } = await pool.query(`SELECT event_id, canceled_at FROM bookings WHERE id = $1`, [id]);
  if (!rows.length) return null;
  if (rows[0].canceled_at) return { alreadyCanceled: true };

  await pool.query(`UPDATE bookings SET canceled_at = now() WHERE id = $1`, [id]);
  if (rows[0].event_id) {
    await pool.query(`DELETE FROM calendar_events WHERE id = $1`, [rows[0].event_id]);
  }
  return { alreadyCanceled: false };
}

async function listBookings({ upcomingOnly = true } = {}) {
  const { rows } = await pool.query(
    `SELECT b.id, b.invitee_name, b.invitee_email, b.notes, b.canceled_at, b.created_at,
            e.starts_at, e.ends_at, t.name AS event_type_name
       FROM bookings b
       LEFT JOIN calendar_events e ON e.id = b.event_id
       LEFT JOIN booking_event_types t ON t.id = b.event_type_id
      ${upcomingOnly ? `WHERE b.canceled_at IS NULL AND e.starts_at > now()` : ''}
      ORDER BY e.starts_at NULLS LAST LIMIT 100`,
  );
  return rows.map((r) => ({
    id: r.id,
    inviteeName: r.invitee_name,
    inviteeEmail: r.invitee_email,
    notes: r.notes,
    canceledAt: r.canceled_at,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    eventTypeName: r.event_type_name,
  }));
}

module.exports = {
  DEFAULT_TZ,
  getTimezone,
  setTimezone,
  listEventTypes,
  getEventTypeBySlug,
  createEventType,
  updateEventType,
  deleteEventType,
  getAvailability,
  setAvailability,
  availableSlots,
  createBooking,
  getBookingByToken,
  cancelBooking,
  cancelBookingById,
  listBookings,
};
