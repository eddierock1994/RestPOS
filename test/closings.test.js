'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dbm = require('../server/db');
const closings = require('../server/closings');

const SESSIONS = [
  { name: 'Morning', start: '06:00', end: '11:30' },
  { name: 'Afternoon', start: '11:30', end: '17:00' },
  { name: 'Night', start: '18:00', end: '01:00' },
];
const settings = { sessions: SESSIONS, closingGraceMinutes: 30 };
const at = (s) => closings.parseTs(s);

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-close-'));
  const db = dbm.open(path.join(dir, 'pos.db'), { seedDemo: false });
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let n = 1;
  const bill = (closedAt, total = 105, status = 'paid', mode = 'Cash') => {
    const id = Number(db.prepare(`INSERT INTO orders(table_id, hall_name, table_name, status, bill_no, subtotal, taxable, cgst_pct, sgst_pct, cgst, sgst, total, payment_mode, closed_at)
      VALUES (1, 'Main', 'T1', ?, ?, 100, 100, 2.5, 2.5, 2.5, 2.5, ?, ?, ?)`).run(status, `B${n++}`, total, mode, closedAt).lastInsertRowid);
    db.prepare("INSERT INTO order_items(order_id, item_id, code, name, price, qty, category) VALUES (?, 1, 'J01', 'Apple Juice', 100, 1, 'Juices & Milkshakes')").run(id);
    return id;
  };
  return { db, bill };
}

test('validateSessions sorts, allows crossing midnight, rejects overlaps', () => {
  const v = closings.validateSessions([SESSIONS[2], SESSIONS[0], SESSIONS[1]]);
  assert.deepEqual(v.map((s) => s.name), ['Morning', 'Afternoon', 'Night']);
  assert.throws(() => closings.validateSessions([{ name: 'A', start: '06:00', end: '12:00' }, { name: 'B', start: '11:00', end: '15:00' }]), /overlaps/);
  assert.throws(() => closings.validateSessions([{ name: 'A', start: '20:00', end: '07:00' }, { name: 'B', start: '06:00', end: '12:00' }]), /overlaps/);
  assert.throws(() => closings.validateSessions([{ name: 'A', start: '06:00', end: '9' }]), /start and end/);
  assert.throws(() => closings.validateSessions([]), /at least one/);
});

test('instanceAt: gaps belong to the previous session, after midnight to the previous night', () => {
  assert.equal(closings.instanceAt(SESSIONS, at('2026-10-20 17:30:00')).session, 'Afternoon');
  const late = closings.instanceAt(SESSIONS, at('2026-10-21 00:30:00'));
  assert.equal(late.session, 'Night');
  assert.equal(late.date, '2026-10-20');
  assert.equal(closings.instanceAt(SESSIONS, at('2026-10-21 05:00:00')).date, '2026-10-20');
});

test('closing takes late bills until it is closed; later bills go to the next closing', (t) => {
  const { db, bill } = setup(t);
  bill('2026-10-20 12:00:00');
  bill('2026-10-20 17:10:00'); // after Afternoon ends, before Night starts
  let st = closings.status(db, settings, at('2026-10-20 17:20:00'));
  assert.equal(st.target.session, 'Afternoon');
  assert.equal(st.summary.bills, 2);
  assert.equal(st.summary.taxable, 200);
  assert.equal(st.summary.gst, 10);
  assert.equal(st.summary.total, 210);
  assert.equal(st.summary.categories[0].category, 'Juices & Milkshakes');
  const c = closings.closeSession(db, settings, { date: '2026-10-20', session: 'Afternoon' }, at('2026-10-20 17:20:00'));
  assert.equal(c.bills, 2);
  assert.equal(c.firstBill, 'B1');
  assert.equal(c.lastBill, 'B2');

  bill('2026-10-20 17:40:00'); // after the close -> next closing (Afternoon part 2)
  st = closings.status(db, settings, at('2026-10-20 17:45:00'));
  assert.equal(st.target.session, 'Afternoon');
  assert.equal(st.target.part, 2);
  assert.equal(st.summary.bills, 1);
});

test('forgotten session must be closed first and is capped at the next session start (after grace)', (t) => {
  const { db, bill } = setup(t);
  bill('2026-10-20 10:00:00');
  bill('2026-10-20 12:00:00');
  const now = at('2026-10-20 14:00:00');
  let st = closings.status(db, settings, now);
  assert.equal(st.pending.length, 2);
  assert.equal(st.target.session, 'Morning');
  assert.equal(st.target.cappedAt, '2026-10-20 11:30:00');
  assert.equal(st.summary.bills, 1);
  assert.throws(() => closings.closeSession(db, settings, { date: '2026-10-20', session: 'Afternoon' }, now), /Morning on 2026-10-20 must be closed first/);
  closings.closeSession(db, settings, { date: '2026-10-20', session: 'Morning' }, now);
  st = closings.status(db, settings, now);
  assert.equal(st.target.session, 'Afternoon');
  assert.equal(st.summary.bills, 1);
});

test('within the grace period, late bills after the next session start stay in the old session', (t) => {
  const { db, bill } = setup(t);
  bill('2026-10-20 16:50:00');
  bill('2026-10-20 18:05:00');
  assert.equal(closings.status(db, settings, at('2026-10-20 18:15:00')).summary.bills, 2);
  assert.equal(closings.status(db, settings, at('2026-10-20 18:45:00')).summary.bills, 1);
});

test('cancelled orders are reported, undo only works on the latest closing', (t) => {
  const { db, bill } = setup(t);
  bill('2026-10-20 12:00:00');
  bill('2026-10-20 12:30:00', 105, 'cancelled');
  const now = at('2026-10-20 13:00:00');
  const c1 = closings.closeSession(db, settings, { date: '2026-10-20', session: 'Afternoon' }, now);
  assert.equal(c1.bills, 1);
  assert.equal(c1.cancelled.count, 1);
  bill('2026-10-20 13:10:00');
  const c2 = closings.closeSession(db, settings, { date: '2026-10-20', session: 'Afternoon' }, at('2026-10-20 13:20:00'));
  assert.equal(c2.part, 2);
  assert.throws(() => closings.undoClosing(db, c1.id), /most recent/);
  closings.undoClosing(db, c2.id);
  assert.equal(closings.status(db, settings, at('2026-10-20 13:30:00')).summary.bills, 1);
  assert.equal(closings.listClosings(db, '2026-10-20', '2026-10-20').length, 1);
});

test('migration marks bills from before closings existed as already closed', () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-mig2-'));
  const file = path.join(dir, 'pos.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, table_id INTEGER, hall_name TEXT DEFAULT '', table_name TEXT DEFAULT '', status TEXT DEFAULT 'open',
    bill_no TEXT, discount_pct REAL DEFAULT 0, subtotal REAL DEFAULT 0, discount REAL DEFAULT 0, taxable REAL DEFAULT 0, cgst_pct REAL DEFAULT 0, sgst_pct REAL DEFAULT 0,
    cgst REAL DEFAULT 0, sgst REAL DEFAULT 0, round_off REAL DEFAULT 0, total REAL DEFAULT 0, payment_mode TEXT, opened_at TEXT, billed_at TEXT, closed_at TEXT);
    INSERT INTO orders(status, closed_at) VALUES ('paid', '2026-10-01 12:00:00'), ('open', NULL);`);
  old.close();
  const db = dbm.open(file);
  assert.deepEqual(db.prepare('SELECT closing_id FROM orders ORDER BY id').all().map((r) => r.closing_id), [0, null]);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
