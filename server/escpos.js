'use strict';
// Minimal ESC/POS receipt builder (works with most 58mm/80mm thermal printers:
// Epson, TVS, Xprinter, Rugtek, Everycom, etc.)

const ESC = 0x1b;
const GS = 0x1d;

class EscPos {
  constructor(width) {
    this.width = width; // characters per line
    this.chunks = [Buffer.from([ESC, 0x40])]; // initialise
  }
  raw(bytes) { this.chunks.push(Buffer.from(bytes)); return this; }
  text(str) { this.chunks.push(Buffer.from(toAscii(str), 'latin1')); return this; }
  line(str = '') { return this.text(str + '\n'); }
  align(a) { return this.raw([ESC, 0x61, { left: 0, center: 1, right: 2 }[a] ?? 0]); }
  bold(on) { return this.raw([ESC, 0x45, on ? 1 : 0]); }
  size(w, h) { return this.raw([GS, 0x21, ((w - 1) << 4) | (h - 1)]); }
  rule(ch = '-') { return this.line(ch.repeat(this.width)); }
  feed(n = 1) { return this.raw([ESC, 0x64, n]); }
  cut() { return this.raw([GS, 0x56, 0x42, 0x00]); }
  pair(left, right, width = this.width) {
    left = toAscii(left); right = toAscii(right);
    const space = Math.max(1, width - left.length - right.length);
    return this.line(left + ' '.repeat(space) + right);
  }
  build() { return Buffer.concat(this.chunks); }
}

function toAscii(s) {
  return String(s ?? '')
    .replace(/₹/g, 'Rs.')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e\n]/g, '');
}

function wrap(str, width) {
  const words = toAscii(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= width) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
    while (cur.length > width) { lines.push(cur.slice(0, width)); cur = cur.slice(width); }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

const money = (n) => Number(n).toFixed(2);
const qtyStr = (q) => (Number.isInteger(Number(q)) ? String(q) : Number(q).toFixed(2));
const padL = (s, n) => String(s).padStart(n).slice(-n);
const padR = (s, n) => String(s).padEnd(n).slice(0, n);

function buildReceipt(bill, settings) {
  const W = Number(settings.paperWidth) === 58 ? 32 : 48;
  const cols = W === 32 ? { name: 13, qty: 4, rate: 7, amt: 8 } : { name: 23, qty: 5, rate: 9, amt: 11 };
  const p = new EscPos(W);

  p.align('center').bold(true).size(2, 2);
  wrap(settings.restaurantName, Math.floor(W / 2)).forEach((l) => p.line(l));
  p.size(1, 1).bold(false);
  [settings.addressLine1, settings.addressLine2].filter(Boolean).forEach((l) => wrap(l, W).forEach((x) => p.line(x)));
  if (settings.phone) p.line(`Ph: ${settings.phone}`);
  if (settings.gstin) p.line(`GSTIN: ${settings.gstin}`);
  if (settings.fssai) p.line(`FSSAI: ${settings.fssai}`);
  if (bill.title) { p.bold(true).line(bill.title).bold(false); }
  p.align('left').rule();
  p.pair(`Bill: ${bill.bill_no || '-'}`, formatDate(bill.closed_at || bill.billed_at || new Date()));
  p.pair(`Table: ${bill.table_name}`, bill.hall_name || '');
  p.rule();
  p.bold(true).line(padR('Item', cols.name) + padL('Qty', cols.qty) + padL('Rate', cols.rate) + padL('Amount', cols.amt)).bold(false);
  p.rule();
  for (const it of bill.items) {
    const nameLines = wrap(it.name, cols.name);
    p.line(padR(nameLines[0], cols.name) + padL(qtyStr(it.qty), cols.qty) + padL(money(it.price), cols.rate) + padL(money(it.price * it.qty), cols.amt));
    nameLines.slice(1).forEach((l) => p.line(l));
  }
  p.rule();
  const t = bill.totals;
  p.pair('Subtotal', money(t.subtotal));
  if (t.discount > 0) p.pair(`Discount (${t.discountPct}%)`, '-' + money(t.discount));
  if (t.discount > 0 || settings.pricesIncludeTax) p.pair('Taxable value', money(t.taxable));
  if (t.cgstPct) p.pair(`CGST @ ${t.cgstPct}%`, money(t.cgst));
  if (t.sgstPct) p.pair(`SGST @ ${t.sgstPct}%`, money(t.sgst));
  if (t.roundOff) p.pair('Round off', money(t.roundOff));
  p.rule();
  p.bold(true).size(1, 2).pair('TOTAL', `${toAscii(settings.currencySymbol)} ${money(t.total)}`).size(1, 1).bold(false);
  p.rule();
  if (bill.payment_mode) p.line(`Paid by: ${bill.payment_mode}`);
  if (settings.billFooter) { p.align('center'); wrap(settings.billFooter, W).forEach((l) => p.line(l)); }
  p.align('left').feed(4);
  if (settings.autoCut) p.cut();
  return p.build();
}

function buildTestPage(settings) {
  const W = Number(settings.paperWidth) === 58 ? 32 : 48;
  const p = new EscPos(W);
  p.align('center').bold(true).size(2, 2).line('TEST PRINT').size(1, 1).bold(false);
  p.line(settings.restaurantName).line(formatDate(new Date())).rule();
  p.align('left').line('1234567890'.repeat(5).slice(0, W)).line(`Paper width: ${settings.paperWidth}mm (${W} chars)`);
  p.feed(4);
  if (settings.autoCut) p.cut();
  return p.build();
}

function formatDate(d) {
  const dt = d instanceof Date ? d : new Date(String(d).replace(' ', 'T'));
  if (isNaN(dt)) return String(d);
  const z = (n) => String(n).padStart(2, '0');
  return `${z(dt.getDate())}-${z(dt.getMonth() + 1)}-${dt.getFullYear()} ${z(dt.getHours())}:${z(dt.getMinutes())}`;
}

module.exports = { buildReceipt, buildTestPage, EscPos };
