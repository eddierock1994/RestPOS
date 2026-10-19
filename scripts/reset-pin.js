'use strict';
// Resets the admin PIN to 1234 (use if the PIN is forgotten). Run: reset-pin.bat
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPin } = require('../server/db');

const dbFile = path.join(process.env.POS_DATA_DIR || path.join(__dirname, '..', 'data'), 'pos.db');
const db = new DatabaseSync(dbFile);
db.exec('PRAGMA busy_timeout = 10000;');
db.prepare("INSERT INTO settings(key, value) VALUES ('adminPin', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
  .run(JSON.stringify(hashPin('1234')));
db.close();
console.log('Admin PIN reset to 1234. Log in and change it in Configuration > Security & backup.');
