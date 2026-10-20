'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_SETTINGS = {
  restaurantName: 'My Restaurant',
  addressLine1: '',
  addressLine2: '',
  phone: '',
  gstin: '',
  fssai: '',
  currencySymbol: '₹',
  cgstPercent: 2.5,
  sgstPercent: 2.5,
  pricesIncludeTax: false,
  roundOff: true,
  billPrefix: 'B',
  nextBillNumber: 1,
  billFooter: 'Thank you! Visit again.',
  printerMode: 'browser', // browser | windows | network
  printerName: '',
  printerIp: '',
  printerPort: 9100,
  paperWidth: 80, // 58 | 80
  autoCut: true,
  printCopies: 1,
  autoBackupDays: 30,
  sessions: [
    { name: 'Morning', start: '06:00', end: '11:30' },
    { name: 'Afternoon', start: '11:30', end: '17:00' },
    { name: 'Night', start: '17:00', end: '23:30' },
  ],
  closingGraceMinutes: 30,
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS menu_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT '',
  price      REAL NOT NULL DEFAULT 0,
  is_veg     INTEGER NOT NULL DEFAULT 1,
  available  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS halls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  width      INTEGER NOT NULL DEFAULT 1000,
  height     INTEGER NOT NULL DEFAULT 600
);
CREATE TABLE IF NOT EXISTS tables (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  hall_id INTEGER NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  seats   INTEGER NOT NULL DEFAULT 4,
  shape   TEXT NOT NULL DEFAULT 'square',
  x       INTEGER NOT NULL DEFAULT 20,
  y       INTEGER NOT NULL DEFAULT 20,
  w       INTEGER NOT NULL DEFAULT 90,
  h       INTEGER NOT NULL DEFAULT 90,
  busy    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id      INTEGER,
  hall_name     TEXT NOT NULL DEFAULT '',
  table_name    TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open', -- open | paid | cancelled
  bill_no       TEXT UNIQUE,
  discount_pct  REAL NOT NULL DEFAULT 0,
  subtotal      REAL NOT NULL DEFAULT 0,
  discount      REAL NOT NULL DEFAULT 0,
  taxable       REAL NOT NULL DEFAULT 0,
  cgst_pct      REAL NOT NULL DEFAULT 0,
  sgst_pct      REAL NOT NULL DEFAULT 0,
  cgst          REAL NOT NULL DEFAULT 0,
  sgst          REAL NOT NULL DEFAULT 0,
  round_off     REAL NOT NULL DEFAULT 0,
  total         REAL NOT NULL DEFAULT 0,
  payment_mode  TEXT,
  waiter        TEXT NOT NULL DEFAULT '',
  opened_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  billed_at     TEXT,
  closed_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_table_status ON orders(table_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_closed ON orders(closed_at);
CREATE TABLE IF NOT EXISTS order_items (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id  INTEGER,
  code     TEXT NOT NULL,
  name     TEXT NOT NULL,
  price    REAL NOT NULL,
  qty      REAL NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE TABLE IF NOT EXISTS closings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT NOT NULL,
  session       TEXT NOT NULL,
  part          INTEGER NOT NULL DEFAULT 1,
  session_start TEXT NOT NULL,
  session_end   TEXT NOT NULL,
  period_to     TEXT NOT NULL,
  closed_at     TEXT NOT NULL,
  bills         INTEGER NOT NULL DEFAULT 0,
  taxable       REAL NOT NULL DEFAULT 0,
  cgst          REAL NOT NULL DEFAULT 0,
  sgst          REAL NOT NULL DEFAULT 0,
  total         REAL NOT NULL DEFAULT 0,
  details       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_closings_date ON closings(business_date);
`;

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPin(pin, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(String(pin), salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}

// Schema upgrades for databases created by earlier versions.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(order_items)').all().map((c) => c.name);
  if (!cols.includes('category')) {
    db.exec("ALTER TABLE order_items ADD COLUMN category TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE order_items SET category = COALESCE((SELECT m.category FROM menu_items m WHERE m.id = order_items.item_id), '')");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_status_closed ON orders(status, closed_at)');
  const orderCols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!orderCols.includes('closing_id')) {
    db.exec('ALTER TABLE orders ADD COLUMN closing_id INTEGER');
    // Bills from before session closings existed are treated as already closed (closing 0).
    db.exec("UPDATE orders SET closing_id = 0 WHERE status IN ('paid','cancelled')");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_closing ON orders(closing_id)');
  if (!orderCols.includes('waiter')) db.exec("ALTER TABLE orders ADD COLUMN waiter TEXT NOT NULL DEFAULT ''");
}

function open(dbFile, { seedDemo = true } = {}) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const isNew = !fs.existsSync(dbFile);
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = FULL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);

  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const putSetting = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (!getSetting.get(k)) putSetting.run(k, JSON.stringify(v));
  }
  if (!getSetting.get('adminPin')) putSetting.run('adminPin', JSON.stringify(hashPin('1234')));

  if (isNew && seedDemo) seed(db);
  return db;
}

function seed(db) {
  const hall = db.prepare('INSERT INTO halls(name, sort_order) VALUES (?, ?)');
  const table = db.prepare('INSERT INTO tables(hall_id, name, seats, shape, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const h1 = Number(hall.run('Main Hall', 1).lastInsertRowid);
  for (let i = 0; i < 8; i++) {
    table.run(h1, `T${i + 1}`, 4, i % 3 === 2 ? 'round' : 'square', 60 + (i % 4) * 230, 80 + Math.floor(i / 4) * 250, 110, 110);
  }
  const h2 = Number(hall.run('AC Hall', 2).lastInsertRowid);
  for (let i = 0; i < 4; i++) {
    table.run(h2, `A${i + 1}`, 6, 'rect', 80 + (i % 2) * 450, 100 + Math.floor(i / 2) * 250, 200, 110);
  }
  const item = db.prepare('INSERT INTO menu_items(code, name, category, price, is_veg) VALUES (?, ?, ?, ?, ?)');
  [
    ['101', 'Veg Soup', 'Starters', 90, 1],
    ['102', 'Paneer Tikka', 'Starters', 220, 1],
    ['103', 'Chicken 65', 'Starters', 240, 0],
    ['201', 'Veg Biryani', 'Main Course', 180, 1],
    ['202', 'Chicken Biryani', 'Main Course', 260, 0],
    ['203', 'Butter Naan', 'Breads', 45, 1],
    ['204', 'Paneer Butter Masala', 'Main Course', 210, 1],
    ['301', 'Fresh Lime Soda', 'Beverages', 60, 1],
    ['501', 'Orange Juice', 'Juices', 90, 1],
    ['502', 'Watermelon Juice', 'Juices', 80, 1],
    ['503', 'Mosambi Juice', 'Juices', 80, 1],
    ['302', 'Masala Chai', 'Beverages', 30, 1],
    ['401', 'Gulab Jamun', 'Desserts', 70, 1],
  ].forEach((r) => item.run(...r));
}

module.exports = { open, hashPin, verifyPin, DEFAULT_SETTINGS };
