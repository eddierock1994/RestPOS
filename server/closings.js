'use strict';
// Session closings (e.g. Morning / Afternoon / Night).
// A settled bill belongs to the session that most recently started before it was settled.
// Closing a session takes every not-yet-closed bill up to the moment of closing, so bills settled a little
// after the session's end time still fall in it; later bills go to the next closing. If an older session was
// never closed it must be closed first, and then only takes bills up to the start of the next session
// (unless it's closed within the grace period after that start).

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const z = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
const fmt = (d) => `${ymd(d)} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fail = (status, message) => Object.assign(new Error(message), { status });

function parseTs(s) {
  const [a, b = '00:00:00'] = String(s).split(/[ T]/);
  const [y, m, d] = a.split('-').map(Number);
  const [hh, mm, ss = 0] = b.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, ss);
}

/** Validates and normalises the session list. Sorted by start time; windows may cross midnight but not overlap. */
function validateSessions(list) {
  if (!Array.isArray(list) || !list.length) throw fail(400, 'Add at least one session');
  if (list.length > 8) throw fail(400, 'At most 8 sessions are allowed');
  const out = list.map((s, i) => {
    const name = String(s?.name ?? '').trim();
    if (!name) throw fail(400, `Session ${i + 1}: name is required`);
    if (name.length > 30) throw fail(400, `${name}: name is too long`);
    if (!TIME_RE.test(s.start || '') || !TIME_RE.test(s.end || '')) throw fail(400, `${name}: enter the start and end time`);
    if (s.start === s.end) throw fail(400, `${name}: start and end time can't be the same`);
    return { name, start: s.start, end: s.end };
  });
  const names = out.map((s) => s.name.toLowerCase());
  if (new Set(names).size !== names.length) throw fail(400, 'Session names must be different');
  out.sort((a, b) => toMin(a.start) - toMin(b.start));
  out.forEach((a, i) => {
    const st = toMin(a.start);
    let en = toMin(a.end);
    if (en <= st) en += 1440;
    const b = out[(i + 1) % out.length];
    const nextSt = i + 1 < out.length ? toMin(b.start) : toMin(out[0].start) + 1440;
    if (out.length > 1 && en > nextSt) throw fail(400, `${a.name} (${a.start}–${a.end}) overlaps ${b.name} (${b.start}–${b.end})`);
  });
  return out;
}

function instanceFor(sessions, day, idx) {
  const s = sessions[idx];
  const [sh, sm] = s.start.split(':').map(Number);
  const [eh, em] = s.end.split(':').map(Number);
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), sh, sm);
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), eh, em);
  if (end <= start) end.setDate(end.getDate() + 1);
  return { date: ymd(start), idx, session: s.name, start, end };
}

/** The session instance that most recently started at or before time t. */
function instanceAt(sessions, t) {
  let best = null;
  for (let back = 1; back >= 0; back--) {
    const day = new Date(t.getFullYear(), t.getMonth(), t.getDate() - back);
    for (let i = 0; i < sessions.length; i++) {
      const inst = instanceFor(sessions, day, i);
      if (inst.start <= t && (!best || inst.start > best.start)) best = inst;
    }
  }
  return best;
}

function nextInstance(sessions, inst) {
  const day = parseTs(inst.date);
  if (inst.idx + 1 < sessions.length) return instanceFor(sessions, day, inst.idx + 1);
  return instanceFor(sessions, new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1), 0);
}

function summarize(db, where, params) {
  const PAID = `o.status = 'paid' AND ${where}`;
  const t = db.prepare(`SELECT COUNT(*) AS bills, COALESCE(SUM(subtotal),0) AS gross, COALESCE(SUM(discount),0) AS discount,
      COALESCE(SUM(taxable),0) AS taxable, COALESCE(SUM(cgst),0) AS cgst, COALESCE(SUM(sgst),0) AS sgst,
      COALESCE(SUM(round_off),0) AS roundOff, COALESCE(SUM(total),0) AS total, MIN(closed_at) AS firstAt, MAX(closed_at) AS lastAt
    FROM orders o WHERE ${PAID}`).get(...params);
  const first = db.prepare(`SELECT bill_no FROM orders o WHERE ${PAID} ORDER BY closed_at, id LIMIT 1`).get(...params);
  const last = db.prepare(`SELECT bill_no FROM orders o WHERE ${PAID} ORDER BY closed_at DESC, id DESC LIMIT 1`).get(...params);
  const payments = db.prepare(`SELECT COALESCE(payment_mode, 'Unknown') AS mode, COUNT(*) AS bills, SUM(total) AS total
    FROM orders o WHERE ${PAID} GROUP BY 1 ORDER BY total DESC`).all(...params).map((p) => ({ ...p, total: r2(p.total) }));
  const categories = db.prepare(`SELECT COALESCE(NULLIF(TRIM(oi.category), ''), 'Uncategorised') AS category, SUM(oi.qty) AS qty,
      SUM(oi.price * oi.qty * (1 - o.discount_pct / 100.0)) AS net
    FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${PAID} GROUP BY 1 ORDER BY net DESC`).all(...params)
    .map((c) => ({ ...c, net: r2(c.net) }));
  const cancelled = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(subtotal),0) AS amount FROM orders o
    WHERE o.status = 'cancelled' AND ${where}`).get(...params);
  return {
    bills: t.bills, gross: r2(t.gross), discount: r2(t.discount), taxable: r2(t.taxable), cgst: r2(t.cgst), sgst: r2(t.sgst),
    gst: r2(t.cgst + t.sgst), roundOff: r2(t.roundOff), total: r2(t.total), firstAt: t.firstAt, lastAt: t.lastAt,
    firstBill: first?.bill_no || null, lastBill: last?.bill_no || null, payments, categories,
    cancelled: { count: cancelled.count, amount: r2(cancelled.amount) },
  };
}

/** Pending sessions, the session to close next (target) and a preview of its closing. */
function status(db, settings, now = new Date(), { withSummary = true } = {}) {
  const sessions = settings.sessions;
  const grace = Math.max(0, Number(settings.closingGraceMinutes) || 0);
  const current = instanceAt(sessions, now);
  const map = new Map();
  const add = (inst) => {
    const k = `${inst.date}|${inst.idx}`;
    if (!map.has(k)) map.set(k, { ...inst, bills: 0 });
    return map.get(k);
  };
  const unclosed = db.prepare("SELECT closed_at FROM orders WHERE closing_id IS NULL AND status IN ('paid','cancelled') AND closed_at IS NOT NULL").all();
  for (const o of unclosed) add(instanceAt(sessions, parseTs(o.closed_at))).bills++;
  add(current);
  const pending = [...map.values()].filter((p) => p.start <= now).sort((a, b) => a.start - b.start);
  const target = pending[0];
  const next = nextInstance(sessions, target);
  const capped = next.start <= now && now.getTime() >= next.start.getTime() + grace * 60000;
  const cutoff = capped ? new Date(next.start.getTime() - 1000) : now;
  const part = db.prepare('SELECT COUNT(*) AS c FROM closings WHERE business_date = ? AND session = ?').get(target.date, target.session).c + 1;
  const view = (i) => ({ date: i.date, session: i.session, start: fmt(i.start), end: fmt(i.end), bills: i.bills, ended: now >= i.end });
  const result = {
    now: fmt(now),
    pending: pending.map(view),
    target: { ...view(target), part, cutoff: fmt(cutoff), cappedAt: capped ? fmt(next.start) : null, nextSession: next.session },
  };
  if (withSummary) {
    result.summary = summarize(db, 'o.closing_id IS NULL AND o.closed_at <= ?', [fmt(cutoff)]);
    result.openOrders = db.prepare(`SELECT COUNT(*) AS count,
        COALESCE(SUM((SELECT SUM(oi.price * oi.qty) FROM order_items oi WHERE oi.order_id = o.id)), 0) AS amount
      FROM orders o WHERE o.status = 'open' AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id)`).get();
  }
  return result;
}

function rowToClosing(row) {
  if (!row) return null;
  const d = JSON.parse(row.details || '{}');
  return {
    ...d, id: row.id, date: row.business_date, session: row.session, part: row.part, sessionStart: row.session_start,
    sessionEnd: row.session_end, periodTo: row.period_to, closedAt: row.closed_at, bills: row.bills, taxable: row.taxable,
    gst: r2(row.cgst + row.sgst), cgst: row.cgst, sgst: row.sgst, total: row.total,
  };
}

/** Closes the target session. `date`/`session` must match the current target (guards against stale screens). */
function closeSession(db, settings, { date, session }, now = new Date()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const st = status(db, settings, now);
    const tg = st.target;
    if (tg.date !== date || tg.session !== session) {
      throw fail(409, `${tg.session} on ${tg.date} must be closed first. Refresh the page.`);
    }
    const s = st.summary;
    const id = Number(db.prepare(`INSERT INTO closings(business_date, session, part, session_start, session_end, period_to, closed_at,
        bills, taxable, cgst, sgst, total, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(tg.date, tg.session, tg.part, tg.start, tg.end, tg.cutoff, fmt(now), s.bills, s.taxable, s.cgst, s.sgst, s.total, JSON.stringify(s)).lastInsertRowid);
    db.prepare("UPDATE orders SET closing_id = ? WHERE closing_id IS NULL AND status IN ('paid','cancelled') AND closed_at <= ?").run(id, tg.cutoff);
    db.exec('COMMIT');
    return getClosing(db, id);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function getClosing(db, id) {
  return rowToClosing(db.prepare('SELECT * FROM closings WHERE id = ?').get(id));
}

function listClosings(db, from, to) {
  return db.prepare('SELECT * FROM closings WHERE business_date BETWEEN ? AND ? ORDER BY id DESC').all(from, to).map(rowToClosing);
}

/** Undoes the most recent closing only; its bills become unclosed again. */
function undoClosing(db, id) {
  const latest = db.prepare('SELECT MAX(id) AS id FROM closings').get().id;
  if (!latest || Number(id) !== latest) throw fail(409, 'Only the most recent closing can be undone');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE orders SET closing_id = NULL WHERE closing_id = ?').run(latest);
    db.prepare('DELETE FROM closings WHERE id = ?').run(latest);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { validateSessions, instanceAt, status, closeSession, getClosing, listClosings, undoClosing, parseTs, fmt };
