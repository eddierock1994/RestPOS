'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dbm = require('./db');
const { computeTotals } = require('./billing');
const { buildReceipt, buildTestPage } = require('./escpos');
const printer = require('./printer');
const { analytics } = require('./analytics');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const PAYMENT_MODES = ['Cash', 'Card', 'UPI', 'Other'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function createApp({ dataDir = process.env.POS_DATA_DIR || path.join(ROOT, 'data'), backupDir, seedDemo = true } = {}) {
  const dbFile = path.join(dataDir, 'pos.db');
  backupDir = backupDir || process.env.POS_BACKUP_DIR || path.join(ROOT, 'backups');
  const db = dbm.open(dbFile, { seedDemo });
  const tokens = new Map();

  // ---------- helpers ----------
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  function getSettings({ includeSecret = false } = {}) {
    const out = {};
    for (const row of db.prepare('SELECT key, value FROM settings').all()) {
      if (row.key === 'adminPin' && !includeSecret) continue;
      out[row.key] = JSON.parse(row.value);
    }
    return out;
  }
  const putSetting = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  function requireAdmin(req) {
    const t = req.headers['x-admin-token'];
    const exp = t && tokens.get(t);
    if (!exp || exp < Date.now()) throw new HttpError(401, 'Admin login required');
    tokens.set(t, Date.now() + TOKEN_TTL_MS);
  }
  function checkPin(pin) {
    const stored = getSettings({ includeSecret: true }).adminPin;
    return dbm.verifyPin(pin ?? '', stored);
  }

  const int = (v, name) => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new HttpError(400, `Invalid ${name}`);
    return n;
  };
  const num = (v, name, { min = -Infinity, max = Infinity } = {}) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `Invalid ${name}`);
    return n;
  };
  const str = (v, name, { required = false, max = 200 } = {}) => {
    const s = String(v ?? '').trim();
    if (required && !s) throw new HttpError(400, `${name} is required`);
    if (s.length > max) throw new HttpError(400, `${name} is too long`);
    return s;
  };

  function getTable(id) {
    const t = db.prepare('SELECT t.*, h.name AS hall_name FROM tables t JOIN halls h ON h.id = t.hall_id WHERE t.id = ?').get(id);
    if (!t) throw new HttpError(404, 'Table not found');
    return t;
  }
  const openOrderStmt = db.prepare("SELECT * FROM orders WHERE table_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1");
  const itemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id');

  function totalsFor(order, items, settings = getSettings()) {
    return computeTotals(items, { ...settings, discountPct: order.discount_pct });
  }

  function orderView(order, settings = getSettings()) {
    if (!order) return null;
    const items = itemsStmt.all(order.id);
    const totals = order.status === 'open'
      ? totalsFor(order, items, settings)
      : {
          subtotal: order.subtotal, discountPct: order.discount_pct, discount: order.discount, taxable: order.taxable,
          cgstPct: order.cgst_pct, sgstPct: order.sgst_pct, cgst: order.cgst, sgst: order.sgst,
          roundOff: order.round_off, total: order.total,
        };
    return { ...order, items, totals };
  }

  function ensureOpenOrder(table) {
    let order = openOrderStmt.get(table.id);
    if (!order) {
      const id = db.prepare('INSERT INTO orders(table_id, hall_name, table_name) VALUES (?, ?, ?)').run(table.id, table.hall_name, table.name).lastInsertRowid;
      order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    }
    db.prepare('UPDATE tables SET busy = 1 WHERE id = ?').run(table.id);
    return order;
  }

  function assignBillNo(order) {
    if (order.bill_no) return order.bill_no;
    const s = getSettings();
    let n = Math.max(1, Number(s.nextBillNumber) || 1);
    let billNo;
    const exists = db.prepare('SELECT 1 FROM orders WHERE bill_no = ?');
    do { billNo = `${s.billPrefix || ''}${n++}`; } while (exists.get(billNo));
    putSetting.run('nextBillNumber', JSON.stringify(n));
    return billNo;
  }

  function snapshotTotals(order, extra) {
    const settings = getSettings();
    const items = itemsStmt.all(order.id);
    if (!items.length) throw new HttpError(400, 'No items on this table');
    const t = totalsFor(order, items, settings);
    db.prepare(`UPDATE orders SET subtotal=?, discount=?, taxable=?, cgst_pct=?, sgst_pct=?, cgst=?, sgst=?, round_off=?, total=?,
      bill_no=?, billed_at=COALESCE(billed_at, datetime('now','localtime')) ${extra ? ', ' + extra : ''} WHERE id=?`)
      .run(t.subtotal, t.discount, t.taxable, t.cgstPct, t.sgstPct, t.cgst, t.sgst, t.roundOff, t.total, assignBillNo(order), order.id);
  }

  function floor() {
    const halls = db.prepare('SELECT * FROM halls ORDER BY sort_order, id').all();
    const tables = db.prepare(`
      SELECT t.*, o.id AS order_id, o.bill_no, o.opened_at,
        (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
        (SELECT COALESCE(SUM(oi.price * oi.qty), 0) FROM order_items oi WHERE oi.order_id = o.id) AS amount
      FROM tables t
      LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'open'
      ORDER BY t.id`).all();
    for (const t of tables) {
      t.status = t.bill_no ? 'billed' : (t.busy || t.item_count > 0 ? 'busy' : 'free');
    }
    return halls.map((h) => ({ ...h, tables: tables.filter((t) => t.hall_id === h.id) }));
  }

  function backupNow(tag = '') {
    fs.mkdirSync(backupDir, { recursive: true });
    const d = new Date();
    const z = (n) => String(n).padStart(2, '0');
    const name = `pos-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}${tag}.db`;
    const file = path.join(backupDir, name);
    db.prepare('VACUUM INTO ?').run(file);
    return { name, file };
  }

  function dailyAutoBackup() {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const d = new Date();
      const today = `pos-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.db'));
      if (!files.some((f) => f.startsWith(today))) backupNow('-auto');
      const keepDays = Math.max(1, Number(getSettings().autoBackupDays) || 30);
      const cutoff = Date.now() - keepDays * 86400000;
      for (const f of files) {
        if (!f.includes('-auto')) continue;
        const p = path.join(backupDir, f);
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      }
    } catch (e) {
      console.error('Auto backup failed:', e.message);
    }
  }

  async function serverPrint(buffer) {
    await printer.print(buffer, getSettings());
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };

  // auth
  route('POST', '/api/login', ({ body }) => {
    if (!checkPin(body.pin)) throw new HttpError(401, 'Wrong PIN');
    const token = crypto.randomBytes(24).toString('hex');
    tokens.set(token, Date.now() + TOKEN_TTL_MS);
    return { token };
  });
  route('POST', '/api/logout', ({ req }) => { tokens.delete(req.headers['x-admin-token']); return { ok: true }; });
  route('GET', '/api/session', ({ req }) => {
    const exp = tokens.get(req.headers['x-admin-token']);
    return { admin: !!exp && exp > Date.now() };
  });

  // settings
  route('GET', '/api/settings', () => getSettings());
  route('PUT', '/api/settings', ({ req, body }) => {
    requireAdmin(req);
    const allowed = Object.keys(dbm.DEFAULT_SETTINGS);
    const s = { ...getSettings(), ...body };
    s.cgstPercent = num(s.cgstPercent, 'CGST %', { min: 0, max: 50 });
    s.sgstPercent = num(s.sgstPercent, 'SGST %', { min: 0, max: 50 });
    s.nextBillNumber = int(s.nextBillNumber, 'next bill number');
    if (s.nextBillNumber < 1) throw new HttpError(400, 'Next bill number must be at least 1');
    s.printerPort = int(s.printerPort, 'printer port');
    s.paperWidth = Number(s.paperWidth) === 58 ? 58 : 80;
    s.printCopies = Math.max(1, Math.min(5, int(s.printCopies, 'print copies')));
    s.autoBackupDays = Math.max(1, int(s.autoBackupDays, 'backup days'));
    if (!['browser', 'windows', 'network'].includes(s.printerMode)) throw new HttpError(400, 'Invalid printer mode');
    s.restaurantName = str(s.restaurantName, 'Restaurant name', { required: true });
    s.pricesIncludeTax = !!s.pricesIncludeTax;
    s.roundOff = !!s.roundOff;
    s.autoCut = !!s.autoCut;
    tx(() => { for (const k of allowed) putSetting.run(k, JSON.stringify(s[k])); });
    return getSettings();
  });
  route('POST', '/api/settings/pin', ({ req, body }) => {
    requireAdmin(req);
    if (!checkPin(body.currentPin)) throw new HttpError(400, 'Current PIN is wrong');
    const pin = String(body.newPin ?? '');
    if (!/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'New PIN must be 4-8 digits');
    putSetting.run('adminPin', JSON.stringify(dbm.hashPin(pin)));
    return { ok: true };
  });

  // menu
  route('GET', '/api/menu', () => db.prepare('SELECT * FROM menu_items ORDER BY category, code').all());
  const menuFields = (b) => ({
    code: str(b.code, 'Code', { required: true, max: 20 }),
    name: str(b.name, 'Name', { required: true }),
    category: str(b.category, 'Category', { max: 60 }),
    price: num(b.price, 'Price', { min: 0 }),
    is_veg: b.is_veg ? 1 : 0,
    available: b.available === undefined || b.available ? 1 : 0,
  });
  const uniqueGuard = (fn) => {
    try { return fn(); } catch (e) {
      if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'An item with this code already exists');
      throw e;
    }
  };
  route('POST', '/api/menu', ({ req, body }) => {
    requireAdmin(req);
    const m = menuFields(body);
    return uniqueGuard(() => {
      const id = db.prepare('INSERT INTO menu_items(code, name, category, price, is_veg, available) VALUES (?, ?, ?, ?, ?, ?)')
        .run(m.code, m.name, m.category, m.price, m.is_veg, m.available).lastInsertRowid;
      return db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
    });
  });
  route('PUT', '/api/menu/:id', ({ req, body, params }) => {
    requireAdmin(req);
    const m = menuFields(body);
    return uniqueGuard(() => {
      const r = db.prepare('UPDATE menu_items SET code=?, name=?, category=?, price=?, is_veg=?, available=? WHERE id=?')
        .run(m.code, m.name, m.category, m.price, m.is_veg, m.available, int(params.id, 'id'));
      if (!r.changes) throw new HttpError(404, 'Item not found');
      return db.prepare('SELECT * FROM menu_items WHERE id = ?').get(params.id);
    });
  });
  route('DELETE', '/api/menu/:id', ({ req, params }) => {
    requireAdmin(req);
    db.prepare('DELETE FROM menu_items WHERE id = ?').run(int(params.id, 'id'));
    return { ok: true };
  });
  route('POST', '/api/menu/import', ({ req, body }) => {
    requireAdmin(req);
    if (!Array.isArray(body.items)) throw new HttpError(400, 'items array required');
    const rows = body.items.map((b, i) => {
      try { return menuFields(b); } catch (e) { throw new HttpError(400, `Row ${i + 1}: ${e.message}`); }
    });
    const up = db.prepare(`INSERT INTO menu_items(code, name, category, price, is_veg, available) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET name=excluded.name, category=excluded.category, price=excluded.price, is_veg=excluded.is_veg, available=excluded.available`);
    tx(() => rows.forEach((m) => up.run(m.code, m.name, m.category, m.price, m.is_veg, m.available)));
    return { imported: rows.length };
  });

  // halls & layout
  route('GET', '/api/floor', () => floor());
  route('POST', '/api/halls', ({ req, body }) => {
    requireAdmin(req);
    const name = str(body.name, 'Hall name', { required: true });
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM halls').get().m;
    const id = db.prepare('INSERT INTO halls(name, sort_order) VALUES (?, ?)').run(name, max + 1).lastInsertRowid;
    return db.prepare('SELECT * FROM halls WHERE id = ?').get(id);
  });
  route('PUT', '/api/halls/:id', ({ req, body, params }) => {
    requireAdmin(req);
    const id = int(params.id, 'id');
    const h = db.prepare('SELECT * FROM halls WHERE id = ?').get(id);
    if (!h) throw new HttpError(404, 'Hall not found');
    const name = body.name !== undefined ? str(body.name, 'Hall name', { required: true }) : h.name;
    const sort = body.sort_order !== undefined ? int(body.sort_order, 'sort order') : h.sort_order;
    const width = body.width !== undefined ? num(body.width, 'width', { min: 300, max: 5000 }) : h.width;
    const height = body.height !== undefined ? num(body.height, 'height', { min: 200, max: 5000 }) : h.height;
    db.prepare('UPDATE halls SET name=?, sort_order=?, width=?, height=? WHERE id=?').run(name, sort, Math.round(width), Math.round(height), id);
    return db.prepare('SELECT * FROM halls WHERE id = ?').get(id);
  });
  route('DELETE', '/api/halls/:id', ({ req, params }) => {
    requireAdmin(req);
    const id = int(params.id, 'id');
    const busy = db.prepare("SELECT COUNT(*) AS c FROM tables t JOIN orders o ON o.table_id = t.id AND o.status = 'open' WHERE t.hall_id = ?").get(id).c;
    if (busy) throw new HttpError(409, 'This hall has tables with open orders. Settle them first.');
    db.prepare('DELETE FROM halls WHERE id = ?').run(id);
    return { ok: true };
  });
  route('PUT', '/api/halls/:id/layout', ({ req, body, params }) => {
    requireAdmin(req);
    const hallId = int(params.id, 'id');
    if (!db.prepare('SELECT 1 FROM halls WHERE id = ?').get(hallId)) throw new HttpError(404, 'Hall not found');
    if (!Array.isArray(body.tables)) throw new HttpError(400, 'tables array required');
    const incoming = body.tables.map((t) => ({
      id: t.id ? int(t.id, 'table id') : null,
      name: str(t.name, 'Table name', { required: true, max: 20 }),
      seats: Math.max(0, int(t.seats ?? 4, 'seats')),
      shape: ['square', 'round', 'rect'].includes(t.shape) ? t.shape : 'square',
      x: Math.round(num(t.x, 'x', { min: 0 })), y: Math.round(num(t.y, 'y', { min: 0 })),
      w: Math.round(num(t.w, 'w', { min: 30, max: 1000 })), h: Math.round(num(t.h, 'h', { min: 30, max: 1000 })),
    }));
    const names = incoming.map((t) => t.name.toLowerCase());
    if (new Set(names).size !== names.length) throw new HttpError(400, 'Table names must be unique within a hall');
    tx(() => {
      const existing = db.prepare('SELECT id FROM tables WHERE hall_id = ?').all(hallId).map((r) => r.id);
      const keep = new Set(incoming.filter((t) => t.id).map((t) => t.id));
      for (const id of existing) {
        if (keep.has(id)) continue;
        if (openOrderStmt.get(id)) throw new HttpError(409, 'Cannot delete a table that has an open order');
        db.prepare('DELETE FROM tables WHERE id = ?').run(id);
      }
      for (const t of incoming) {
        if (t.id && existing.includes(t.id)) {
          db.prepare('UPDATE tables SET name=?, seats=?, shape=?, x=?, y=?, w=?, h=? WHERE id=?').run(t.name, t.seats, t.shape, t.x, t.y, t.w, t.h, t.id);
        } else {
          db.prepare('INSERT INTO tables(hall_id, name, seats, shape, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(hallId, t.name, t.seats, t.shape, t.x, t.y, t.w, t.h);
        }
      }
    });
    return floor().find((h) => h.id === hallId);
  });

  // table operations (billing)
  route('GET', '/api/tables/:id/order', ({ params }) => {
    const table = getTable(int(params.id, 'id'));
    return { table, order: orderView(openOrderStmt.get(table.id)) };
  });
  route('POST', '/api/tables/:id/items', ({ params, body }) => tx(() => {
    const table = getTable(int(params.id, 'id'));
    const qty = num(body.qty ?? 1, 'quantity', { min: 0.01, max: 9999 });
    const item = body.itemId
      ? db.prepare('SELECT * FROM menu_items WHERE id = ?').get(int(body.itemId, 'item id'))
      : db.prepare('SELECT * FROM menu_items WHERE code = ?').get(str(body.code, 'Code', { required: true }));
    if (!item) throw new HttpError(404, 'Menu item not found');
    if (!item.available) throw new HttpError(400, `${item.name} is marked unavailable`);
    const order = ensureOpenOrder(table);
    const line = db.prepare('SELECT * FROM order_items WHERE order_id = ? AND item_id = ? AND price = ?').get(order.id, item.id, item.price);
    if (line) db.prepare('UPDATE order_items SET qty = qty + ? WHERE id = ?').run(qty, line.id);
    else db.prepare('INSERT INTO order_items(order_id, item_id, code, name, price, qty, category) VALUES (?, ?, ?, ?, ?, ?, ?)').run(order.id, item.id, item.code, item.name, item.price, qty, item.category || '');
    return orderView(openOrderStmt.get(table.id));
  }));
  route('PATCH', '/api/order-items/:id', ({ params, body }) => tx(() => {
    const line = db.prepare("SELECT oi.*, o.table_id FROM order_items oi JOIN orders o ON o.id = oi.order_id AND o.status = 'open' WHERE oi.id = ?").get(int(params.id, 'id'));
    if (!line) throw new HttpError(404, 'Order line not found');
    const qty = num(body.qty, 'quantity', { min: 0, max: 9999 });
    if (qty === 0) db.prepare('DELETE FROM order_items WHERE id = ?').run(line.id);
    else db.prepare('UPDATE order_items SET qty = ? WHERE id = ?').run(qty, line.id);
    return orderView(openOrderStmt.get(line.table_id));
  }));
  route('DELETE', '/api/order-items/:id', ({ params }) => tx(() => {
    const line = db.prepare("SELECT oi.*, o.table_id FROM order_items oi JOIN orders o ON o.id = oi.order_id AND o.status = 'open' WHERE oi.id = ?").get(int(params.id, 'id'));
    if (!line) throw new HttpError(404, 'Order line not found');
    db.prepare('DELETE FROM order_items WHERE id = ?').run(line.id);
    return orderView(openOrderStmt.get(line.table_id));
  }));
  route('PATCH', '/api/tables/:id/order', ({ params, body }) => {
    const table = getTable(int(params.id, 'id'));
    const order = openOrderStmt.get(table.id);
    if (!order) throw new HttpError(404, 'No open order');
    const pct = num(body.discountPct ?? 0, 'discount %', { min: 0, max: 100 });
    db.prepare('UPDATE orders SET discount_pct = ? WHERE id = ?').run(pct, order.id);
    return orderView(openOrderStmt.get(table.id));
  });
  route('POST', '/api/tables/:id/busy', ({ params, body }) => tx(() => {
    const table = getTable(int(params.id, 'id'));
    const order = openOrderStmt.get(table.id);
    if (body.busy) {
      db.prepare('UPDATE tables SET busy = 1 WHERE id = ?').run(table.id);
    } else {
      if (order && itemsStmt.all(order.id).length) throw new HttpError(409, 'Table has items. Settle the bill or cancel the order first.');
      if (order) db.prepare('DELETE FROM orders WHERE id = ?').run(order.id);
      db.prepare('UPDATE tables SET busy = 0 WHERE id = ?').run(table.id);
    }
    return { ok: true };
  }));
  route('POST', '/api/tables/:id/bill', ({ params }) => tx(() => {
    const table = getTable(int(params.id, 'id'));
    const order = openOrderStmt.get(table.id);
    if (!order) throw new HttpError(400, 'No open order on this table');
    snapshotTotals(order);
    return orderView(openOrderStmt.get(table.id));
  }));
  route('POST', '/api/tables/:id/settle', ({ params, body }) => tx(() => {
    const table = getTable(int(params.id, 'id'));
    const order = openOrderStmt.get(table.id);
    if (!order) throw new HttpError(400, 'No open order on this table');
    const mode = PAYMENT_MODES.includes(body.paymentMode) ? body.paymentMode : 'Cash';
    snapshotTotals(order, "status='paid', closed_at=datetime('now','localtime')");
    db.prepare('UPDATE orders SET payment_mode = ? WHERE id = ?').run(mode, order.id);
    db.prepare('UPDATE tables SET busy = 0 WHERE id = ?').run(table.id);
    return orderView(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id));
  }));
  route('POST', '/api/tables/:id/cancel', ({ params, body }) => tx(() => {
    if (!checkPin(body.pin)) throw new HttpError(401, 'Admin PIN required to cancel an order');
    const table = getTable(int(params.id, 'id'));
    const order = openOrderStmt.get(table.id);
    if (order) {
      const t = totalsFor(order, itemsStmt.all(order.id));
      db.prepare("UPDATE orders SET status='cancelled', closed_at=datetime('now','localtime'), subtotal=?, total=? WHERE id=?").run(t.subtotal, t.total, order.id);
    }
    db.prepare('UPDATE tables SET busy = 0 WHERE id = ?').run(table.id);
    return { ok: true };
  }));
  route('POST', '/api/tables/:id/move', ({ params, body }) => tx(() => {
    const from = getTable(int(params.id, 'id'));
    const to = getTable(int(body.toTableId, 'target table'));
    if (from.id === to.id) throw new HttpError(400, 'Choose a different table');
    const order = openOrderStmt.get(from.id);
    if (!order) throw new HttpError(400, 'No open order to move');
    if (openOrderStmt.get(to.id) || to.busy) throw new HttpError(409, `${to.name} is not free`);
    db.prepare('UPDATE orders SET table_id=?, table_name=?, hall_name=? WHERE id=?').run(to.id, to.name, to.hall_name, order.id);
    db.prepare('UPDATE tables SET busy = 0 WHERE id = ?').run(from.id);
    db.prepare('UPDATE tables SET busy = 1 WHERE id = ?').run(to.id);
    return { ok: true };
  }));

  // bills & reports
  route('GET', '/api/bills', ({ req, query }) => {
    requireAdmin(req);
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : today;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : from;
    const status = query.status === 'cancelled' ? 'cancelled' : 'paid';
    const bills = db.prepare(`SELECT o.*,
      (SELECT GROUP_CONCAT(oi.name || ' x' || (CASE WHEN oi.qty = CAST(oi.qty AS INTEGER) THEN CAST(oi.qty AS INTEGER) ELSE oi.qty END), ', ') FROM order_items oi WHERE oi.order_id = o.id) AS items_text,
      (SELECT GROUP_CONCAT(DISTINCT oi.category) FROM order_items oi WHERE oi.order_id = o.id) AS categories
      FROM orders o WHERE o.status = ? AND date(o.closed_at) BETWEEN ? AND ? ORDER BY o.closed_at DESC`).all(status, from, to);
    const summary = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(subtotal),0) AS subtotal, COALESCE(SUM(discount),0) AS discount,
      COALESCE(SUM(taxable),0) AS taxable, COALESCE(SUM(cgst),0) AS cgst, COALESCE(SUM(sgst),0) AS sgst, COALESCE(SUM(total),0) AS total
      FROM orders WHERE status = 'paid' AND date(closed_at) BETWEEN ? AND ?`).get(from, to);
    const byMode = db.prepare(`SELECT payment_mode AS mode, COUNT(*) AS count, SUM(total) AS total FROM orders
      WHERE status = 'paid' AND date(closed_at) BETWEEN ? AND ? GROUP BY payment_mode`).all(from, to);
    const topItems = db.prepare(`SELECT oi.code, oi.name, COALESCE(NULLIF(TRIM(oi.category), ''), 'Uncategorised') AS category,
      SUM(oi.qty) AS qty, SUM(oi.qty * oi.price) AS amount FROM order_items oi
      JOIN orders o ON o.id = oi.order_id WHERE o.status = 'paid' AND date(o.closed_at) BETWEEN ? AND ?
      GROUP BY oi.code, oi.name, 3 ORDER BY amount DESC`).all(from, to);
    return { from, to, bills, summary, byMode, topItems };
  });
  route('GET', '/api/analytics', ({ req, query }) => { requireAdmin(req); return analytics(db, query); });
  route('GET', '/api/bills/:id', ({ req, params }) => {
    requireAdmin(req);
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(int(params.id, 'id'));
    if (!o) throw new HttpError(404, 'Bill not found');
    return orderView(o);
  });

  // printing
  route('POST', '/api/print/order/:id', async ({ params, body }) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(int(params.id, 'id'));
    if (!o) throw new HttpError(404, 'Bill not found');
    const settings = getSettings();
    await serverPrint(buildReceipt({ ...orderView(o, settings), title: body.duplicate ? 'DUPLICATE' : '' }, settings));
    return { ok: true };
  });
  route('POST', '/api/print/test', async () => {
    await serverPrint(buildTestPage(getSettings()));
    return { ok: true };
  });
  route('GET', '/api/printers', async () => printer.listWindowsPrinters());

  // backups
  route('GET', '/api/backups', ({ req }) => {
    requireAdmin(req);
    if (!fs.existsSync(backupDir)) return { dir: backupDir, files: [] };
    const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.db')).map((f) => {
      const st = fs.statSync(path.join(backupDir, f));
      return { name: f, size: st.size, time: st.mtime };
    }).sort((a, b) => b.time - a.time);
    return { dir: backupDir, files };
  });
  route('POST', '/api/backups', ({ req }) => { requireAdmin(req); return backupNow(); });

  // ---------- http plumbing ----------
  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 5 * 1024 * 1024) throw new HttpError(413, 'Request too large');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
  }

  function send(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(body);
  }

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
        const result = await r.handler({ req, params, body, query: Object.fromEntries(url.searchParams) });
        return send(res, 200, result);
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      if (!e.status) console.error(e);
      send(res, e.status || 500, { error: e.message || 'Server error' });
    }
  });

  const backupTimer = setInterval(dailyAutoBackup, 60 * 60 * 1000);
  backupTimer.unref();
  server.on('close', () => { clearInterval(backupTimer); try { db.close(); } catch {} });

  return { server, db, dailyAutoBackup, backupNow };
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  const app = createApp();
  app.dailyAutoBackup();
  app.server.listen(PORT, HOST, () => {
    console.log(`Restaurant POS running at http://localhost:${PORT}`);
  });
  const shutdown = () => app.server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp };
