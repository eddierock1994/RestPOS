// Session closings: preview of the session to close next, close & print, and history of past closings.
import { api, esc, money, cur, qtyFmt, toast, toastErr, modal, confirmBox, periodBar } from './api.js';
import { printClosing } from './print.js';

const time = (ts) => String(ts || '').slice(11, 16);
const longDate = (d) => new Date(d + 'T00:00').toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
const label = (c) => `${c.session}${c.part > 1 ? ` (part ${c.part})` : ''}`;

/** The closing summary block, used for both the live preview and saved closings. */
export function closingSummaryHtml(s) {
  return `<div class="closing-sum">
    <div class="cs-main">
      <div class="cs-box"><div class="k">Income (excl. GST)</div><div class="v">${esc(cur(s.taxable))}</div>
        ${s.discount > 0 ? `<div class="muted cs-sub">Gross ${esc(cur(s.gross))} − discount ${esc(cur(s.discount))}</div>` : ''}</div>
      <div class="cs-op">+</div>
      <div class="cs-box"><div class="k">GST</div><div class="v">${esc(cur(s.gst))}</div>
        <div class="muted cs-sub">CGST ${esc(cur(s.cgst))} · SGST ${esc(cur(s.sgst))}</div></div>
      <div class="cs-op">=</div>
      <div class="cs-box total"><div class="k">Total collected</div><div class="v">${esc(cur(s.total))}</div>
        ${s.roundOff ? `<div class="muted cs-sub">incl. round off ${esc(money(s.roundOff))}</div>` : ''}</div>
    </div>
    <div class="cs-details">
      <div><h3>Bills</h3><p><b>${s.bills}</b> bills${s.bills ? ` · ${esc(s.firstBill)} to ${esc(s.lastBill)}` : ''}</p>
        ${s.cancelled?.count ? `<p class="muted">Cancelled orders: ${s.cancelled.count} (${esc(cur(s.cancelled.amount))})</p>` : ''}</div>
      <div><h3>Payment modes</h3>${s.payments?.length ? `<table class="data">${s.payments.map((m) =>
        `<tr><td>${esc(m.mode)} <span class="muted">(${m.bills})</span></td><td class="num">${money(m.total)}</td></tr>`).join('')}</table>` : '<p class="muted">—</p>'}</div>
      <div><h3>Categories <span class="muted" style="font-weight:400;font-size:12px">excl. GST</span></h3>${s.categories?.length ? `<table class="data">${s.categories.map((x) =>
        `<tr><td>${esc(x.category)} <span class="muted">×${qtyFmt(x.qty)}</span></td><td class="num">${money(x.net)}</td></tr>`).join('')}</table>` : '<p class="muted">—</p>'}</div>
    </div>
  </div>`;
}

export function mountClosings(root) {
  let alive = true, st = null, history = [], range = null;
  root.innerHTML = `<div class="reports">
    <div class="panel current"><p class="muted">Loading…</p></div>
    <div class="panel">
      <div class="ph"><h3>Past closings</h3><span class="spacer"></span></div>
      <div class="period-host" style="margin-bottom:10px"></div>
      <div class="menu-table-wrap" style="max-height:none"><table class="data history"></table></div>
    </div>
  </div>`;
  const cur$ = root.querySelector('.current');

  async function loadStatus() {
    try { const d = await api('GET', '/api/closings/status'); if (!alive) return; st = d; renderCurrent(); } catch (e) { if (alive) toastErr(e); }
  }
  async function loadHistory() {
    if (!range) return;
    try { const d = await api('GET', `/api/closings?from=${range[0]}&to=${range[1]}`); if (!alive) return; history = d; renderHistory(); } catch (e) { if (alive) toastErr(e); }
  }

  function renderCurrent() {
    const t = st.target, s = st.summary;
    const older = st.pending.length > 1 || t.cappedAt;
    const state = t.ended ? `<span class="badge busy">Ended at ${time(t.end)}</span>` : '<span class="badge free">Running</span>';
    cur$.innerHTML = `
      ${older && t.cappedAt ? `<div class="alert">This session was not closed. Close it first; it will include bills settled up to ${time(t.cappedAt)} on ${esc(longDate(t.cappedAt.slice(0, 10)))}, when ${esc(t.nextSession)} started.</div>` : ''}
      <div class="row" style="margin-bottom:12px">
        <h2 style="margin:0">${esc(label(t))}</h2><span class="muted">${esc(longDate(t.date))} · ${time(t.start)}–${time(t.end)}</span>${state}
        <span class="spacer"></span>
        <button class="btn" data-refresh>Refresh</button>
        <button class="btn btn-primary btn-lg" data-close>Close ${esc(t.session)} session</button>
      </div>
      ${closingSummaryHtml(s)}
      <p class="muted" style="margin:10px 0 0">Includes every bill not yet closed that was settled ${t.cappedAt ? `before ${time(t.cappedAt)}` : 'up to now'}${s.lastAt ? ` (last bill at ${time(s.lastAt)})` : ''}. Bills settled after you close go to the next closing.</p>
      ${st.openOrders.count ? `<div class="alert" style="margin-top:10px">${st.openOrders.count} table(s) still have open orders (${esc(cur(st.openOrders.amount))} before GST). They will be counted in the closing when they are settled.</div>` : ''}
      ${st.pending.length > 1 ? `<p class="muted" style="margin:8px 0 0">Also not closed yet: ${st.pending.slice(1).map((p) => `${esc(p.session)} ${esc(p.date)} (${p.bills} bills)`).join(', ')}</p>` : ''}`;
    cur$.querySelector('[data-refresh]').onclick = loadStatus;
    cur$.querySelector('[data-close]').onclick = closeNow;
  }

  async function closeNow() {
    const t = st.target, s = st.summary;
    const choice = await modal(`Close ${label(t)} — ${longDate(t.date)}`, (body, close) => {
      body.innerHTML = `<p>${s.bills} bills · Income <b>${esc(cur(s.taxable))}</b> + GST <b>${esc(cur(s.gst))}</b> = <b>${esc(cur(s.total))}</b></p>
        ${st.openOrders.count ? `<p class="muted">${st.openOrders.count} open table(s) will go into the next closing.</p>` : ''}
        <label class="check"><input type="checkbox" checked> Print closing report</label>
        <div class="actions"><button class="btn" data-x>Cancel</button><button class="btn btn-primary" data-ok>Close session</button></div>`;
      body.querySelector('[data-x]').onclick = () => close(null);
      body.querySelector('[data-ok]').onclick = () => close({ print: body.querySelector('input').checked });
      body.querySelector('[data-ok]').focus();
    });
    if (!choice) return;
    try {
      const c = await api('POST', '/api/closings', { date: t.date, session: t.session });
      toast(`${label(c)} closed · ${cur(c.total)}`, 'ok');
      document.dispatchEvent(new CustomEvent('closings-changed'));
      if (choice.print) await printClosing(c);
      await Promise.all([loadStatus(), loadHistory()]);
    } catch (e) { toastErr(e); loadStatus(); }
  }

  function renderHistory() {
    const t = root.querySelector('table.history');
    const latestId = Math.max(0, ...history.map((c) => c.id));
    const sum = (k) => history.reduce((a, c) => a + c[k], 0);
    t.innerHTML = `<thead><tr><th>Date</th><th>Session</th><th>Closed at</th><th class="num">Bills</th><th class="num">Income</th><th class="num">GST</th><th class="num">Total</th><th></th></tr></thead><tbody>
      ${history.map((c) => `<tr data-id="${c.id}"><td>${esc(c.date)}</td><td><b>${esc(label(c))}</b></td><td>${esc(c.closedAt)}</td><td class="num">${c.bills}</td>
        <td class="num">${money(c.taxable)}</td><td class="num">${money(c.gst)}</td><td class="num"><b>${money(c.total)}</b></td>
        <td class="right" style="white-space:nowrap"><button class="btn btn-sm" data-view>View</button> <button class="btn btn-sm" data-print>Print</button>
        ${c.id === latestId ? ' <button class="btn btn-sm btn-danger" data-undo title="Re-open this session">Undo</button>' : ''}</td></tr>`).join('')
      || '<tr><td colspan="8" class="muted">No closings in this period</td></tr>'}</tbody>
      ${history.length > 1 ? `<tfoot><tr><th colspan="3">Total (${history.length} closings)</th><th class="num">${sum('bills')}</th><th class="num">${money(sum('taxable'))}</th>
        <th class="num">${money(sum('gst'))}</th><th class="num">${money(sum('total'))}</th><th></th></tr></tfoot>` : ''}`;
    t.querySelectorAll('tr[data-id]').forEach((tr) => {
      const c = history.find((x) => x.id === Number(tr.dataset.id));
      tr.querySelector('[data-view]').onclick = () => view(c);
      tr.querySelector('[data-print]').onclick = () => printClosing(c);
      const u = tr.querySelector('[data-undo]');
      if (u) u.onclick = async () => {
        if (!(await confirmBox(`Undo the ${label(c)} closing of ${c.date}? Its ${c.bills} bills go back to "not closed" and will be included in the next closing.`, { okText: 'Undo closing', danger: true }))) return;
        try { await api('DELETE', `/api/closings/${c.id}`); toast('Closing undone'); document.dispatchEvent(new CustomEvent('closings-changed')); await Promise.all([loadStatus(), loadHistory()]); } catch (e) { toastErr(e); }
      };
    });
  }

  function view(c) {
    modal(`${label(c)} — ${longDate(c.date)}`, (body, close) => {
      body.innerHTML = `<p class="muted">Session ${time(c.sessionStart)}–${time(c.sessionEnd)} · closed ${esc(c.closedAt)}</p>
        <div style="width:880px;max-width:85vw">${closingSummaryHtml(c)}</div>
        <div class="actions"><button class="btn" data-p>Print</button><button class="btn btn-primary" data-x>Close</button></div>`;
      body.querySelector('[data-x]').onclick = () => close();
      body.querySelector('[data-p]').onclick = () => printClosing(c);
    });
  }

  periodBar(root.querySelector('.period-host'), (f, t) => { range = [f, t]; loadHistory(); });
  loadStatus();
  const timer = setInterval(() => { if (!document.hidden && !document.querySelector('.modal-back')) loadStatus(); }, 30000);
  return () => { alive = false; clearInterval(timer); };
}
