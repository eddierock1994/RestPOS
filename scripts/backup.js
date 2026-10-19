'use strict';
// Manual backup: node scripts/backup.js [extraDestinationFolder]
// Safe to run while the POS is running. Example: backup.bat E:\POS-Backups (pen drive)
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const root = path.join(__dirname, '..');
const dbFile = path.join(process.env.POS_DATA_DIR || path.join(root, 'data'), 'pos.db');
const backupDir = process.env.POS_BACKUP_DIR || path.join(root, 'backups');

if (!fs.existsSync(dbFile)) {
  console.error(`Database not found: ${dbFile}`);
  process.exit(1);
}
fs.mkdirSync(backupDir, { recursive: true });
const d = new Date();
const z = (n) => String(n).padStart(2, '0');
const name = `pos-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}-manual.db`;
const out = path.join(backupDir, name);

const db = new DatabaseSync(dbFile);
db.exec('PRAGMA busy_timeout = 10000;');
db.prepare('VACUUM INTO ?').run(out);
db.close();
console.log(`Backup saved: ${out}`);

const extra = process.argv[2];
if (extra) {
  fs.mkdirSync(extra, { recursive: true });
  fs.copyFileSync(out, path.join(extra, name));
  console.log(`Copied to:    ${path.join(extra, name)}`);
}
