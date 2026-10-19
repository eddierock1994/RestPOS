'use strict';
// Sales analytics computed from the local SQLite database (paid bills only unless noted).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const z = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function range(query) {
  const today = ymd(new Date());
  let from = DATE_RE.test(query.from || '') ? query.from : today;
  let to = DATE_RE.test(query.to || '') ? query.to : from;
  if (to < from) [from, to] = [to, from];
  const days = Math.round((parse(to) - parse(from)) / 86400000) + 1;
  return { from, to, days };
}

function analytics(db, query) {
  const { from, to, days } = range(query);
  const prevTo = ymd(addDays(parse(from), -1));
  const prevFrom = ymd(addDays(parse(from), -days));
  const PAID = "o.status = 'paid' AND date(o.closed_at) BETWEEN ? AND ?";

  const summarySql = `SELECT COUNT(*) AS bills, COALESCE(SUM(subtotal),0) AS gross, COALESCE(SUM(discount),0) AS discount,
      COALESCE(SUM(taxable),0) AS taxable, COALESCE(SUM(cgst),0) AS cgst, COALESCE(SUM(sgst),0) AS sgst,
      COALESCE(SUM(round_off),0) AS roundOff, COALESCE(SUM(total),0) AS total
    FROM orders o WHERE ${PAID}`;
  const summary = db.prepare(summarySql).get(from, to);
  const previous = db.prepare(summarySql).get(prevFrom, prevTo);
  summary.itemsSold = db.prepare(`SELECT COALESCE(SUM(oi.qty),0) AS q FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${PAID}`).get(from, to).q;
  summary.avgBill = summary.bills ? r2(summary.total / summary.bills) : 0;
  previous.avgBill = previous.bills ? r2(previous.total / previous.bills) : 0;
  const cancelled = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM orders o
    WHERE o.status = 'cancelled' AND date(o.closed_at) BETWEEN ? AND ?`).get(from, to);

  // Trend: hourly for a single day, daily up to ~2 months, monthly beyond.
  let granularity, trend;
  if (days === 1) {
    granularity = 'hour';
    const rows = db.prepare(`SELECT CAST(strftime('%H', o.closed_at) AS INTEGER) AS k, COUNT(*) AS bills, SUM(o.total) AS total
      FROM orders o WHERE ${PAID} GROUP BY k`).all(from, to);
    const map = new Map(rows.map((r) => [r.k, r]));
    const hours = rows.map((r) => r.k);
    const lo = Math.min(10, ...hours), hi = Math.max(22, ...hours);
    trend = [];
    for (let hr = lo; hr <= hi; hr++) trend.push({ key: String(hr), label: `${z(hr)}:00`, bills: map.get(hr)?.bills || 0, total: r2(map.get(hr)?.total || 0) });
  } else if (days <= 62) {
    granularity = 'day';
    const rows = db.prepare(`SELECT date(o.closed_at) AS k, COUNT(*) AS bills, SUM(o.total) AS total FROM orders o WHERE ${PAID} GROUP BY k`).all(from, to);
    const map = new Map(rows.map((r) => [r.k, r]));
    trend = [];
    for (let d = parse(from); ymd(d) <= to; d = addDays(d, 1)) {
      const k = ymd(d);
      trend.push({ key: k, label: `${z(d.getDate())}/${z(d.getMonth() + 1)}`, bills: map.get(k)?.bills || 0, total: r2(map.get(k)?.total || 0) });
    }
  } else {
    granularity = 'month';
    const rows = db.prepare(`SELECT strftime('%Y-%m', o.closed_at) AS k, COUNT(*) AS bills, SUM(o.total) AS total FROM orders o WHERE ${PAID} GROUP BY k`).all(from, to);
    const map = new Map(rows.map((r) => [r.k, r]));
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    trend = [];
    for (let d = parse(from.slice(0, 8) + '01'); ymd(d) <= to; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const k = `${d.getFullYear()}-${z(d.getMonth() + 1)}`;
      trend.push({ key: k, label: `${MON[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`, bills: map.get(k)?.bills || 0, total: r2(map.get(k)?.total || 0) });
    }
  }

  // Busy hours (bills by hour of day across the whole range).
  const hourRows = db.prepare(`SELECT CAST(strftime('%H', o.closed_at) AS INTEGER) AS h, COUNT(*) AS bills, SUM(o.total) AS total
    FROM orders o WHERE ${PAID} GROUP BY h ORDER BY h`).all(from, to);

  // Category split. "net" = after the bill's discount % (before GST), "gross" = menu price x qty.
  const LINE_NET = 'oi.price * oi.qty * (1 - o.discount_pct / 100.0)';
  const CAT = "COALESCE(NULLIF(TRIM(oi.category), ''), 'Uncategorised')";
  const categories = db.prepare(`SELECT ${CAT} AS category, SUM(oi.qty) AS qty, SUM(oi.price * oi.qty) AS gross, SUM(${LINE_NET}) AS net,
      COUNT(DISTINCT o.id) AS bills
    FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${PAID} GROUP BY 1 ORDER BY net DESC`).all(from, to);
  const categoryItems = db.prepare(`SELECT ${CAT} AS category, oi.code, oi.name, oi.price, SUM(oi.qty) AS qty, SUM(oi.price * oi.qty) AS gross, SUM(${LINE_NET}) AS net
    FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${PAID} GROUP BY 1, oi.code, oi.name, oi.price ORDER BY 1, net DESC`).all(from, to);
  for (const c of categories) {
    c.gross = r2(c.gross); c.net = r2(c.net);
    c.items = categoryItems.filter((i) => i.category === c.category).map((i) => ({ ...i, gross: r2(i.gross), net: r2(i.net) }));
  }

  const payments = db.prepare(`SELECT COALESCE(o.payment_mode, 'Unknown') AS mode, COUNT(*) AS bills, SUM(o.total) AS total
    FROM orders o WHERE ${PAID} GROUP BY 1 ORDER BY total DESC`).all(from, to);
  const halls = db.prepare(`SELECT o.hall_name AS hall, COUNT(*) AS bills, SUM(o.total) AS total
    FROM orders o WHERE ${PAID} GROUP BY 1 ORDER BY total DESC`).all(from, to);
  const topItems = db.prepare(`SELECT oi.code, oi.name, ${CAT} AS category, SUM(oi.qty) AS qty, SUM(oi.price * oi.qty) AS gross
    FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${PAID} GROUP BY oi.code, oi.name ORDER BY qty DESC, gross DESC LIMIT 15`).all(from, to);
  const weekdays = db.prepare(`SELECT CAST(strftime('%w', o.closed_at) AS INTEGER) AS dow, COUNT(*) AS bills, SUM(o.total) AS total
    FROM orders o WHERE ${PAID} GROUP BY 1`).all(from, to);

  return {
    from, to, days, prevFrom, prevTo, granularity,
    summary, previous, cancelled, trend, hours: hourRows, categories, payments, halls, topItems, weekdays,
  };
}

module.exports = { analytics };
