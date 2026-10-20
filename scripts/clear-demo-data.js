'use strict';
// Removes halls, tables, menu items and all orders/bills (e.g. the demo data created on first run).
// Keeps every setting: admin PIN, restaurant details, GST %, printer, etc. Bill numbering restarts at 1.
// A backup is saved to backups\ first. Usage: node scripts/clear-demo-data.js [--yes]
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');

const root = path.join(__dirname, '..');
const dbFile = path.join(process.env.POS_DATA_DIR || path.join(root, 'data'), 'pos.db');
const backupDir = process.env.POS_BACKUP_DIR || path.join(root, 'backups');

async function confirm() {
  if (process.argv.includes('--yes')) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question('This deletes ALL halls, tables, menu items and bills (settings and PIN are kept).\nType YES to continue: ', r));
  rl.close();
  return answer.trim() === 'YES';
}

(async () => {
  if (!fs.existsSync(dbFile)) { console.log(`No database at ${dbFile} - nothing to clear.`); return; }
  if (!(await confirm())) { console.log('Cancelled.'); return; }

  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;');

  fs.mkdirSync(backupDir, { recursive: true });
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  const backup = path.join(backupDir, `pos-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}-before-clear.db`);
  db.prepare('VACUUM INTO ?').run(backup);
  console.log(`Backup saved: ${backup}`);

  const count = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  const before = { halls: count('halls'), tables: count('tables'), menu: count('menu_items'), orders: count('orders') };
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`DELETE FROM order_items; DELETE FROM orders; DELETE FROM tables; DELETE FROM halls; DELETE FROM menu_items;
      DELETE FROM sqlite_sequence WHERE name IN ('order_items', 'orders', 'tables', 'halls', 'menu_items');`);
    db.prepare("UPDATE settings SET value = '1' WHERE key = 'nextBillNumber'").run();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec('VACUUM');
  db.close();
  console.log(`Removed ${before.halls} halls, ${before.tables} tables, ${before.menu} menu items, ${before.orders} orders/bills.`);
  console.log('Settings and admin PIN kept. Bill numbers restart at 1.');
  console.log('If the POS is open, refresh the page (F5).');
})().catch((e) => { console.error(e.message); process.exit(1); });
