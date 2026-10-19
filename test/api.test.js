'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { computeTotals } = require('../server/billing');
const { buildReceipt } = require('../server/escpos');
const { createApp } = require('../server/index');

test('computeTotals: exclusive GST with discount and round off', () => {
  const t = computeTotals([{ price: 220, qty: 2 }, { price: 45, qty: 3 }], { discountPct: 10, cgstPercent: 2.5, sgstPercent: 2.5, roundOff: true });
  assert.equal(t.subtotal, 575);
  assert.equal(t.discount, 57.5);
  assert.equal(t.taxable, 517.5);
  assert.equal(t.cgst, 12.94);
  assert.equal(t.sgst, 12.94);
  assert.equal(t.total, 543);
  assert.equal(t.roundOff, -0.38);
});

test('computeTotals: inclusive GST', () => {
  const t = computeTotals([{ price: 105, qty: 1 }], { cgstPercent: 2.5, sgstPercent: 2.5, pricesIncludeTax: true, roundOff: false });
  assert.equal(t.taxable, 100);
  assert.equal(t.cgst + t.sgst, 5);
  assert.equal(t.total, 105);
});

test('migration adds and backfills order_items.category on old databases', () => {
  const { DatabaseSync } = require('node:sqlite');
  const dbm = require('../server/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-mig-'));
  const file = path.join(dir, 'pos.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE menu_items (id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT, category TEXT DEFAULT '', price REAL, is_veg INTEGER DEFAULT 1, available INTEGER DEFAULT 1, created_at TEXT);
    CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, item_id INTEGER, code TEXT, name TEXT, price REAL, qty REAL, added_at TEXT);
    INSERT INTO menu_items(id, code, name, category, price) VALUES (1, 'J1', 'Apple Juice', 'Juices', 80);
    INSERT INTO order_items(order_id, item_id, code, name, price, qty) VALUES (1, 1, 'J1', 'Apple Juice', 80, 2);`);
  old.close();
  const db = dbm.open(file);
  assert.equal(db.prepare('SELECT category FROM order_items').get().category, 'Juices');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('API flow: order, bill, settle, reports, layout', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-test-'));
  const app = createApp({ dataDir: path.join(dir, 'data'), backupDir: path.join(dir, 'backups') });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => new Promise((r) => app.server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r(); })));

  let token = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token }, body: body && JSON.stringify(body) });
    const data = await res.json();
    return { status: res.status, data };
  };

  // static
  const html = await fetch(base + '/');
  assert.equal(html.status, 200);

  // admin protection
  assert.equal((await call('PUT', '/api/settings', { cgstPercent: 9 })).status, 401);
  assert.equal((await call('POST', '/api/login', { pin: '0000' })).status, 401);
  token = (await call('POST', '/api/login', { pin: '1234' })).data.token;
  assert.ok(token);
  const s = await call('PUT', '/api/settings', { restaurantName: 'Test Cafe', cgstPercent: 2.5, sgstPercent: 2.5, billPrefix: 'T-' });
  assert.equal(s.status, 200);
  assert.equal(s.data.restaurantName, 'Test Cafe');

  // menu
  const dup = await call('POST', '/api/menu', { code: '101', name: 'Dup', price: 1 });
  assert.equal(dup.status, 409);
  const added = await call('POST', '/api/menu', { code: 'X1', name: 'Special Thali', category: 'Main', price: 300, is_veg: true });
  assert.equal(added.status, 200);
  const imp = await call('POST', '/api/menu/import', { items: [{ code: 'x1', name: 'Special Thali', price: 320 }, { code: 'NEW', name: 'New', price: 10 }] });
  assert.equal(imp.data.imported, 2);
  const menu = (await call('GET', '/api/menu')).data;
  assert.equal(menu.find((m) => m.code === 'X1').price, 320);

  // floor & ordering
  const floor = (await call('GET', '/api/floor')).data;
  assert.equal(floor.length, 2);
  const table = floor[0].tables[0];
  assert.equal(table.status, 'free');
  await call('POST', `/api/tables/${table.id}/busy`, { busy: true });
  assert.equal((await call('GET', '/api/floor')).data[0].tables[0].status, 'busy');
  let o = (await call('POST', `/api/tables/${table.id}/items`, { code: '102', qty: 2 })).data;
  o = (await call('POST', `/api/tables/${table.id}/items`, { code: '102', qty: 1 })).data;
  assert.equal(o.items.length, 1);
  assert.equal(o.items[0].qty, 3);
  o = (await call('POST', `/api/tables/${table.id}/items`, { code: 'X1', qty: 1 })).data;
  assert.equal(o.totals.subtotal, 980);
  const lineId = o.items[0].id;
  o = (await call('PATCH', `/api/order-items/${lineId}`, { qty: 2 })).data;
  assert.equal(o.totals.subtotal, 760);
  assert.equal((await call('POST', `/api/tables/${table.id}/busy`, { busy: false })).status, 409);

  // move order to another table and back
  const other = floor[0].tables[1];
  assert.equal((await call('POST', `/api/tables/${table.id}/move`, { toTableId: other.id })).status, 200);
  assert.equal((await call('POST', `/api/tables/${other.id}/move`, { toTableId: table.id })).status, 200);

  // bill & settle
  const billed = (await call('POST', `/api/tables/${table.id}/bill`)).data;
  assert.equal(billed.bill_no, 'T-1');
  assert.equal((await call('GET', '/api/floor')).data[0].tables[0].status, 'billed');
  const paid = (await call('POST', `/api/tables/${table.id}/settle`, { paymentMode: 'UPI' })).data;
  assert.equal(paid.status, 'paid');
  assert.equal(paid.bill_no, 'T-1');
  assert.equal(paid.total, 798); // 760 + 5% = 798
  assert.equal((await call('GET', '/api/floor')).data[0].tables[0].status, 'free');

  // receipt bytes build
  const receipt = buildReceipt(paid, (await call('GET', '/api/settings')).data);
  assert.ok(receipt.includes(Buffer.from('T-1')));
  assert.ok(receipt.includes(Buffer.from('Rs. 798.00')));

  // cancel needs PIN
  await call('POST', `/api/tables/${table.id}/items`, { code: '101', qty: 1 });
  assert.equal((await call('POST', `/api/tables/${table.id}/cancel`, { pin: '9999' })).status, 401);
  assert.equal((await call('POST', `/api/tables/${table.id}/cancel`, { pin: '1234' })).status, 200);

  // reports
  const rep = (await call('GET', '/api/bills')).data;
  assert.equal(rep.summary.count, 1);
  assert.equal(rep.summary.total, 798);
  assert.equal(rep.byMode[0].mode, 'UPI');
  assert.match(rep.bills[0].items_text, /Paneer Tikka x2/);

  // analytics: category split (net after discount), trend, previous period
  await call('POST', `/api/tables/${table.id}/items`, { code: '501', qty: 3 }); // Orange Juice 90
  await call('POST', `/api/tables/${table.id}/items`, { code: '102', qty: 1 }); // Paneer Tikka 220
  await call('PATCH', `/api/tables/${table.id}/order`, { discountPct: 10 });
  await call('POST', `/api/tables/${table.id}/settle`, { paymentMode: 'Cash' });
  const an = await call('GET', '/api/analytics');
  assert.equal(an.status, 200);
  assert.equal(an.data.granularity, 'hour');
  assert.equal(an.data.summary.bills, 2);
  const juice = an.data.categories.find((c) => c.category === 'Juices');
  assert.equal(juice.qty, 3);
  assert.equal(juice.gross, 270);
  assert.equal(juice.net, 243);
  assert.equal(juice.items[0].name, 'Orange Juice');
  const starters = an.data.categories.find((c) => c.category === 'Starters');
  assert.equal(starters.qty, 3); // 2 + 1 Paneer Tikka
  assert.equal(an.data.trend.reduce((a, t) => a + t.bills, 0), 2);
  const week = (await call('GET', '/api/analytics?from=2026-01-01&to=2026-01-07')).data;
  assert.equal(week.granularity, 'day');
  assert.equal(week.trend.length, 7);
  assert.equal(week.prevFrom, '2025-12-25');
  const fy = (await call('GET', '/api/analytics?from=2026-04-01&to=2027-03-31')).data;
  assert.equal(fy.granularity, 'month');
  assert.equal(fy.trend.length, 12);

  // layout editing
  const hall = floor[1];
  const tables = hall.tables.map((x) => ({ ...x }));
  tables.pop();
  tables.push({ name: 'A9', seats: 2, shape: 'round', x: 10, y: 10, w: 80, h: 80 });
  const saved = (await call('PUT', `/api/halls/${hall.id}/layout`, { tables })).data;
  assert.equal(saved.tables.length, hall.tables.length);
  assert.ok(saved.tables.some((x) => x.name === 'A9'));
  assert.equal((await call('PUT', `/api/halls/${hall.id}/layout`, { tables: [{ name: 'Z', x: 0, y: 0, w: 50, h: 50 }, { name: 'z', x: 0, y: 0, w: 50, h: 50 }] })).status, 400);

  // network printing to a fake ESC/POS printer
  const received = [];
  const fake = net.createServer((sock) => sock.on('data', (d) => received.push(d)));
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  await call('PUT', '/api/settings', { printerMode: 'network', printerIp: '127.0.0.1', printerPort: fake.address().port });
  const pr = await call('POST', `/api/print/order/${paid.id}`, {});
  assert.equal(pr.status, 200);
  await new Promise((r) => setTimeout(r, 100));
  fake.close();
  assert.ok(Buffer.concat(received).includes(Buffer.from('TOTAL')));

  // backup
  const b = await call('POST', '/api/backups');
  assert.equal(b.status, 200);
  assert.ok(fs.existsSync(b.data.file));
});
