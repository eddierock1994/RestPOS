// Analytics dashboard: KPIs, trend, category split (with item drill-down), payments, busy hours, halls, top items.
import { api, state, esc, money, cur, qtyFmt, toastErr, periodBar, downloadFile, toCsv } from './api.js';
import { barChart, donutChart, hBars, PALETTE } from './charts.js';
import { printHtml } from './print.js';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function mountDashboard(root) {
  let data = null, alive = true;
  const open = new Set(JSON.parse(sessionStorage.getItem('dashOpenCats') || '[]'));
  root.innerHTML = `<div class="dash">
    <div class="panel dash-period"></div>
    <div class="kpis"></div>
    <div class="dash-grid">
      <div class="panel span2"><div class="ph"><h3 class="trend-title">Sales trend</h3><span class="muted trend-note"></span></div><div class="trend"></div></div>
      <div class="panel"><div class="ph"><h3>Payment modes</h3></div><div class="pay"></div></div>
      <div class="panel span2">
        <div class="ph"><h3>Category split</h3><span class="muted">Click a category to see its items. Amounts after discount, before GST.</span>
          <span class="spacer"></span><button class="btn btn-sm" data-cat-print>Print</button><button class="btn btn-sm" data-cat-csv>Export CSV</button></div>
        <div class="cat-wrap"><div class="cat-donut"></div><div class="cat-table"></div></div>
      </div>
      <div class="panel"><div class="ph"><h3>Busy hours</h3><span class="muted">bills per hour</span></div><div class="hours"></div></div>
      <div class="panel"><div class="ph"><h3>Halls</h3></div><div class="halls"></div></div>
      <div class="panel"><div class="ph"><h3>Day of week</h3></div><div class="dow"></div></div>
      <div class="panel"><div class="ph"><h3>Top items</h3><span class="muted">by quantity</span></div><div class="top"></div></div>
    </div>
  </div>`;
  const $ = (s) => root.querySelector(s);

  periodBar($('.dash-period'), async (from, to) => {
    try {
      const d = await api('GET', `/api/analytics?from=${from}&to=${to}`);
      if (!alive) return;
      data = d; render();
    } catch (e) { if (alive) toastErr(e); }
  });

  function kpi(label, value, curV, prevV, { invert = false } = {}) {
    let delta = '';
    if (prevV !== undefined) {
      if (!prevV) delta = curV ? '<span class="delta muted">new</span>' : '<span class="delta muted">—</span>';
      else {
        const pct = ((curV - prevV) / prevV) * 100;
        const good = invert ? pct <= 0 : pct >= 0;
        delta = `<span class="delta ${good ? 'up' : 'down'}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%</span>`;
      }
    }
    return `<div class="card"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div>${delta}</div>`;
  }

  function render() {
    const s = data.summary, p = data.previous;
    const prevText = data.prevFrom === data.prevTo ? data.prevFrom : `${data.prevFrom} → ${data.prevTo}`;
    $('.kpis').innerHTML = [
      kpi('Net collected', cur(s.total), s.total, p.total),
      kpi('Bills', s.bills, s.bills, p.bills),
      kpi('Average bill', cur(s.avgBill), s.avgBill, p.avgBill),
      kpi('Items sold', qtyFmt(s.itemsSold)),
      kpi('Gross sales', cur(s.gross), s.gross, p.gross),
      kpi('Discounts', cur(s.discount), s.discount, p.discount, { invert: true }),
      kpi('GST (CGST + SGST)', cur(s.cgst + s.sgst)),
      kpi('Cancelled orders', `${data.cancelled.count} · ${cur(data.cancelled.total)}`),
    ].join('') + `<div class="kpi-note muted">▲▼ compared with the previous period (${esc(prevText)})</div>`;

    $('.trend-title').textContent = { hour: 'Sales by hour', day: 'Sales by day', month: 'Sales by month' }[data.granularity];
    $('.trend-note').textContent = `${data.from === data.to ? data.from : `${data.from} → ${data.to}`}`;
    $('.trend').innerHTML = barChart(data.trend.map((t) => ({ label: t.label, value: t.total, title: `${t.label}: ${cur(t.total)} · ${t.bills} bills` })));

    $('.pay').innerHTML = donutChart(data.payments.map((m) => ({ label: `${m.mode} (${m.bills})`, value: m.total })), { centerValue: cur(s.total) });

    renderCategories();

    const hrs = data.hours;
    if (hrs.length) {
      const lo = Math.min(...hrs.map((x) => x.h)), hi = Math.max(...hrs.map((x) => x.h));
      const series = [];
      for (let hr = lo; hr <= hi; hr++) {
        const r = hrs.find((x) => x.h === hr);
        series.push({ label: String(hr).padStart(2, '0'), value: r?.bills || 0, title: `${hr}:00–${hr + 1}:00 · ${r?.bills || 0} bills · ${cur(r?.total || 0)}` });
      }
      $('.hours').innerHTML = barChart(series, { height: 220, width: 420, color: PALETTE[2], fmt: (v) => String(v) });
    } else $('.hours').innerHTML = '<div class="chart-empty">No sales in this period</div>';

    $('.halls').innerHTML = hBars(data.halls.map((x, i) => ({ label: x.hall || '—', value: x.total, sub: `${x.bills} bills`, color: PALETTE[i % PALETTE.length] })), { fmt: (v) => cur(v) });

    const dows = [1, 2, 3, 4, 5, 6, 0].map((d) => {
      const r = data.weekdays.find((x) => x.dow === d);
      return { label: DOW[d], value: r?.total || 0, title: `${DOW[d]}: ${cur(r?.total || 0)} · ${r?.bills || 0} bills` };
    });
    $('.dow').innerHTML = data.days >= 7 ? barChart(dows, { height: 220, width: 420, color: PALETTE[3] }) : '<div class="chart-empty">Choose a week or longer</div>';

    $('.top').innerHTML = data.topItems.length ? `<table class="data"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead><tbody>
      ${data.topItems.map((i) => `<tr><td>${esc(i.name)}<div class="muted" style="font-size:12px">${esc(i.code)} · ${esc(i.category)}</div></td><td class="num">${qtyFmt(i.qty)}</td><td class="num">${money(i.gross)}</td></tr>`).join('')}
      </tbody></table>` : '<div class="chart-empty">No data</div>';
  }

  function renderCategories() {
    const cats = data.categories;
    const totalNet = cats.reduce((a, c) => a + c.net, 0);
    const color = (i) => PALETTE[i % PALETTE.length];
    $('.cat-donut').innerHTML = donutChart(cats.map((c, i) => ({ label: c.category, value: c.net, color: color(i) })), { centerValue: cur(totalNet), centerLabel: 'Items total' });
    $('.cat-table').innerHTML = cats.length ? `<table class="data cats"><thead><tr><th>Category</th><th class="num">Qty</th><th class="num">Bills</th><th class="num">Gross</th><th class="num">Net</th><th class="num">Share</th></tr></thead><tbody>
      ${cats.map((c, i) => `<tr class="cat-row" data-cat="${esc(c.category)}"><td><i class="dot" style="background:${color(i)}"></i><b>${open.has(c.category) ? '▾' : '▸'} ${esc(c.category)}</b></td>
        <td class="num">${qtyFmt(c.qty)}</td><td class="num">${c.bills}</td><td class="num">${money(c.gross)}</td><td class="num"><b>${money(c.net)}</b></td>
        <td class="num">${totalNet ? ((c.net / totalNet) * 100).toFixed(1) : '0.0'}%</td></tr>
        ${open.has(c.category) ? c.items.map((it) => `<tr class="cat-item"><td>${esc(it.code)} · ${esc(it.name)} <span class="muted">@ ${money(it.price)}</span></td><td class="num">${qtyFmt(it.qty)}</td><td></td>
          <td class="num">${money(it.gross)}</td><td class="num">${money(it.net)}</td><td></td></tr>`).join('') : ''}`).join('')}
      </tbody><tfoot><tr><th>Total</th><th class="num">${qtyFmt(cats.reduce((a, c) => a + c.qty, 0))}</th><th></th>
        <th class="num">${money(cats.reduce((a, c) => a + c.gross, 0))}</th><th class="num">${money(totalNet)}</th><th class="num">100%</th></tr></tfoot></table>` : '';
    root.querySelectorAll('.cat-row').forEach((tr) => (tr.onclick = () => {
      const c = tr.dataset.cat;
      if (open.has(c)) open.delete(c); else open.add(c);
      sessionStorage.setItem('dashOpenCats', JSON.stringify([...open]));
      renderCategories();
    }));
  }

  // Category report (e.g. to settle with the juice counter). Prints/exports the expanded categories, or all if none expanded.
  const reportCats = () => (open.size ? data.categories.filter((c) => open.has(c.category)) : data.categories);

  $('[data-cat-csv]').onclick = () => {
    if (!data) return;
    const rows = [['Category', 'Item code', 'Item', 'Rate', 'Qty', 'Gross', 'Net (after discount)']];
    for (const c of reportCats()) {
      for (const it of c.items) rows.push([c.category, it.code, it.name, it.price, it.qty, it.gross, it.net]);
      rows.push([`${c.category} total`, '', '', '', c.qty, c.gross, c.net]);
    }
    downloadFile(`category-report-${data.from}-to-${data.to}.csv`, toCsv(rows));
  };

  $('[data-cat-print]').onclick = () => {
    if (!data) return;
    const s = state.settings;
    const width = Number(s.paperWidth) === 58 ? 48 : 72;
    const period = data.from === data.to ? data.from : `${data.from} to ${data.to}`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { margin: 0; } body { width: ${width}mm; margin: 0 auto; padding: 2mm 0 6mm; font-family: "Courier New", monospace; font-size: 12px; color: #000; }
      h1 { font-size: 16px; text-align: center; margin: 0; } .c { text-align: center; } table { width: 100%; border-collapse: collapse; }
      td, th { padding: 1px 0; text-align: left; vertical-align: top; } .r { text-align: right; } hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }
      .t td { font-weight: bold; border-top: 1px dashed #000; }
    </style></head><body><h1>${esc(s.restaurantName)}</h1><div class="c"><b>Category sales report</b><br>${esc(period)}</div><hr>
    ${reportCats().map((c) => `<div><b>${esc(c.category)}</b></div><table><tr><th>Item</th><th class="r">Qty</th><th class="r">Amount</th></tr>
      ${c.items.map((it) => `<tr><td>${esc(it.name)}</td><td class="r">${qtyFmt(it.qty)}</td><td class="r">${money(it.net)}</td></tr>`).join('')}
      <tr class="t"><td>Total</td><td class="r">${qtyFmt(c.qty)}</td><td class="r">${money(c.net)}</td></tr></table><hr>`).join('')}
    <div class="c">Amounts after discount, before GST</div></body></html>`;
    printHtml(html);
  };

  return () => { alive = false; };
}
