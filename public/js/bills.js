// Past orders: bills for any day/week/month, GST totals, payment modes, search & category filter, reprint.
import { api, esc, money, cur, qtyFmt, toastErr, modal, downloadFile, toCsv, periodBar } from './api.js';
import { printOrder } from './print.js';

export function mountBills(root) {
  let from, to, status = 'paid', search = '', category = '';
  let data = null, alive = true;

  root.innerHTML = `<div class="reports">
    <div class="panel period-host"></div>
    <div class="cards"></div>
    <div class="row" style="align-items:flex-start;gap:14px">
      <div class="panel grow" style="min-width:0">
        <div class="row" style="margin-bottom:10px">
          <h3 class="list-title" style="margin:0">Bills</h3><span class="spacer"></span>
          <input class="search" placeholder="Search bill no, table or item" style="width:230px">
          <select class="cat"><option value="">All categories</option></select>
          <select class="status"><option value="paid">Paid bills</option><option value="cancelled">Cancelled orders</option></select>
          <button class="btn" data-export>Export CSV</button>
        </div>
        <div class="menu-table-wrap" style="max-height:calc(100vh - 360px)"><table class="data bills"></table></div></div>
      <div class="panel" style="width:340px"><h3>Top items</h3><div class="menu-table-wrap" style="max-height:calc(100vh - 360px)"><table class="data top"></table></div></div>
    </div>
  </div>`;

  const visible = () => data.bills.filter((b) => {
    if (category && !(b.categories || '').split(',').includes(category)) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return [b.bill_no, b.table_name, b.hall_name, b.items_text, b.payment_mode].some((v) => String(v || '').toLowerCase().includes(q));
  });

  async function load() {
    let d;
    try { d = await api('GET', `/api/bills?from=${from}&to=${to}&status=${status}`); } catch (e) { return alive && toastErr(e); }
    if (!alive) return;
    data = d;
    const s = data.summary;
    const card = (k, v) => `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;
    root.querySelector('.cards').innerHTML = [
      card('Bills', s.count), card('Gross sales', cur(s.subtotal)), card('Discounts', cur(s.discount)),
      card('Taxable value', cur(s.taxable)), card('CGST', cur(s.cgst)), card('SGST', cur(s.sgst)), card('Net collected', cur(s.total)),
      ...data.byMode.map((m) => card(`${m.mode || 'Unknown'} (${m.count})`, cur(m.total))),
    ].join('');
    const cats = [...new Set(data.bills.flatMap((b) => (b.categories || '').split(',')).filter(Boolean))].sort();
    if (category && !cats.includes(category)) category = '';
    root.querySelector('.cat').innerHTML = `<option value="">All categories</option>${cats.map((c) => `<option ${c === category ? 'selected' : ''}>${esc(c)}</option>`).join('')}`;
    root.querySelector('table.top').innerHTML = `<thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead><tbody>${
      data.topItems.map((i) => `<tr><td>${esc(i.code)} ${esc(i.name)}</td><td class="num">${qtyFmt(i.qty)}</td><td class="num">${money(i.amount)}</td></tr>`).join('')
      || '<tr><td colspan="3" class="muted">—</td></tr>'}</tbody>`;
    drawList();
  }

  function drawList() {
    const rows = visible();
    const title = status === 'paid' ? 'Bills' : 'Cancelled orders';
    root.querySelector('.list-title').textContent = rows.length === data.bills.length ? `${title} (${rows.length})` : `${title} (${rows.length} of ${data.bills.length} · ${cur(rows.reduce((a, b) => a + b.total, 0))})`;
    const t = root.querySelector('table.bills');
    t.innerHTML = `<thead><tr><th>Bill</th><th>Closed</th><th>Table</th><th>Items</th><th class="num">GST</th><th class="num">Total</th><th>Mode</th><th></th></tr></thead><tbody>${
      rows.map((b) => `<tr data-id="${b.id}"><td><b>${esc(b.bill_no || '-')}</b></td><td style="white-space:nowrap">${esc(b.closed_at)}</td><td style="white-space:nowrap">${esc(b.hall_name)} / ${esc(b.table_name)}</td>
        <td class="items-cell" title="${esc(b.items_text)}">${esc(b.items_text || '')}</td>
        <td class="num">${money(b.cgst + b.sgst)}</td><td class="num"><b>${money(b.total)}</b></td><td>${esc(b.payment_mode || '')}</td>
        <td class="right" style="white-space:nowrap"><button class="btn btn-sm" data-view>View</button>${status === 'paid' ? ' <button class="btn btn-sm" data-print>Reprint</button>' : ''}</td></tr>`).join('')
      || '<tr><td colspan="8" class="muted">Nothing found in this period</td></tr>'}</tbody>`;
    t.querySelectorAll('tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id;
      tr.querySelector('[data-view]').onclick = () => view(id);
      const p = tr.querySelector('[data-print]');
      if (p) p.onclick = async () => printOrder(await api('GET', `/api/bills/${id}`), { duplicate: true });
    });
  }

  async function view(id) {
    let b;
    try { b = await api('GET', `/api/bills/${id}`); } catch (e) { return toastErr(e); }
    await modal(`Bill ${b.bill_no || '(none)'} — ${b.hall_name} / ${b.table_name}`, (body, close) => {
      body.innerHTML = `<p class="muted">Opened ${esc(b.opened_at)} · Closed ${esc(b.closed_at || '')} · ${esc(b.status)}${b.payment_mode ? ' · ' + esc(b.payment_mode) : ''}</p>
        <table class="data"><thead><tr><th>Code</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>
        ${b.items.map((i) => `<tr><td>${esc(i.code)}</td><td>${esc(i.name)}</td><td class="num">${qtyFmt(i.qty)}</td><td class="num">${money(i.price)}</td><td class="num">${money(i.price * i.qty)}</td></tr>`).join('')}
        </tbody></table>
        <div class="op-totals" style="padding:8px 0">
          <div class="line"><span>Subtotal</span><span>${money(b.totals.subtotal)}</span></div>
          ${b.totals.discount ? `<div class="line"><span>Discount (${b.totals.discountPct}%)</span><span>-${money(b.totals.discount)}</span></div>` : ''}
          <div class="line"><span>CGST @ ${b.totals.cgstPct}%</span><span>${money(b.totals.cgst)}</span></div>
          <div class="line"><span>SGST @ ${b.totals.sgstPct}%</span><span>${money(b.totals.sgst)}</span></div>
          ${b.totals.roundOff ? `<div class="line"><span>Round off</span><span>${money(b.totals.roundOff)}</span></div>` : ''}
          <div class="line grand"><span>Total</span><span>${esc(cur(b.totals.total))}</span></div>
        </div>
        <div class="actions">${b.status === 'paid' ? '<button class="btn" data-p>Reprint</button>' : ''}<button class="btn btn-primary" data-x>Close</button></div>`;
      body.querySelector('[data-x]').onclick = () => close();
      const p = body.querySelector('[data-p]');
      if (p) p.onclick = () => printOrder(b, { duplicate: true });
    });
  }

  root.querySelector('.status').onchange = (e) => { status = e.target.value; load(); };
  root.querySelector('.search').oninput = (e) => { search = e.target.value.trim(); if (data) drawList(); };
  root.querySelector('.cat').onchange = (e) => { category = e.target.value; if (data) drawList(); };
  root.querySelector('[data-export]').onclick = () => {
    if (!data) return;
    const rows = [['Bill no', 'Closed at', 'Hall', 'Table', 'Items', 'Subtotal', 'Discount', 'Taxable', 'CGST %', 'CGST', 'SGST %', 'SGST', 'Round off', 'Total', 'Payment', 'Status'],
      ...visible().map((b) => [b.bill_no, b.closed_at, b.hall_name, b.table_name, b.items_text, b.subtotal, b.discount, b.taxable, b.cgst_pct, b.cgst, b.sgst_pct, b.sgst, b.round_off, b.total, b.payment_mode, b.status])];
    downloadFile(`bills-${from}-to-${to}.csv`, toCsv(rows));
  };
  periodBar(root.querySelector('.period-host'), (f, t) => { from = f; to = t; load(); });
  return () => { alive = false; };
}
