// Billing screen: hall tabs + floor plan on the left, selected table's order on the right.
import { api, state, esc, cur, money, qtyFmt, h, toast, toastErr, modal, confirmBox, askPin, loadMenu } from './api.js';
import { renderFloor } from './floor.js';
import { printOrder } from './print.js';

const PAY_MODES = ['Cash', 'UPI', 'Card', 'Other'];

export function mountBilling(root) {
  const v = {
    halls: [],
    hallId: Number(sessionStorage.getItem('hallId')) || null,
    tableId: null,
    order: null,
    category: '',
    timer: null,
  };

  root.innerHTML = `
    <div class="billing">
      <section class="floor-pane">
        <div class="hall-tabs"></div>
        <div class="floor-wrap"></div>
      </section>
      <aside class="order-pane"></aside>
    </div>`;
  const tabsEl = root.querySelector('.hall-tabs');
  const wrapEl = root.querySelector('.floor-wrap');
  const pane = root.querySelector('.order-pane');

  const hall = () => v.halls.find((x) => x.id === v.hallId) || v.halls[0];
  const allTables = () => v.halls.flatMap((x) => x.tables.map((t) => ({ ...t, hall_name: x.name })));
  const currentTable = () => allTables().find((t) => t.id === v.tableId);

  async function refreshFloor() {
    try {
      v.halls = await api('GET', '/api/floor');
      if (!hall()) v.hallId = null;
      renderTabs();
      renderHall();
      syncSelected();
    } catch (e) { /* server may be restarting; keep last view */ }
  }

  // Reload the open order if another terminal changed the selected table.
  function syncSelected() {
    const t = currentTable();
    if (!t) return;
    const o = v.order;
    const floorSig = `${t.item_count || 0}|${Number(t.amount || 0).toFixed(2)}|${t.bill_no || ''}`;
    const orderSig = `${o?.items.length || 0}|${Number(o?.totals.subtotal || 0).toFixed(2)}|${o?.bill_no || ''}`;
    const typing = pane.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && document.activeElement.value;
    if (floorSig !== orderSig && !typing) loadOrder();
  }

  function renderTabs() {
    tabsEl.innerHTML = '';
    const cur = hall();
    for (const x of v.halls) {
      const busy = x.tables.filter((t) => t.status !== 'free').length;
      const b = h(`<button class="hall-tab ${cur && x.id === cur.id ? 'active' : ''}">${esc(x.name)}<span class="cnt">${busy}/${x.tables.length}</span></button>`);
      b.onclick = () => { v.hallId = x.id; sessionStorage.setItem('hallId', x.id); renderTabs(); renderHall(); };
      tabsEl.appendChild(b);
    }
    tabsEl.appendChild(h(`<div class="legend"><span><i style="background:var(--free)"></i>Free</span><span><i style="background:var(--busy)"></i>Occupied</span><span><i style="background:var(--billed)"></i>Bill printed</span></div>`));
  }

  function renderHall() {
    const x = hall();
    if (!x) { wrapEl.innerHTML = '<p class="muted" style="padding:20px">No halls configured. Go to Configuration → Halls &amp; Layout.</p>'; return; }
    renderFloor(wrapEl, x, { selectedId: v.tableId, onSelect: (t) => selectTable(t.id) });
  }

  async function selectTable(id) {
    v.tableId = id;
    renderHall();
    await loadOrder();
    pane.querySelector('input.search')?.focus();
  }

  async function loadOrder() {
    if (!v.tableId) return renderPane();
    try {
      const r = await api('GET', `/api/tables/${v.tableId}/order`);
      v.order = r.order;
    } catch (e) { toastErr(e); v.tableId = null; v.order = null; }
    renderPane();
  }

  function afterChange(order) {
    v.order = order;
    renderPane();
    refreshFloor();
  }

  // ---------- order pane ----------
  function renderPane() {
    const t = currentTable();
    if (!t) {
      pane.innerHTML = `<div class="op-empty"><h2>Select a table</h2><p>Click a table on the floor plan to take an order, print the bill or clear it.</p></div>`;
      return;
    }
    const o = v.order;
    const items = o?.items || [];
    const status = o?.bill_no ? 'billed' : (t.busy || items.length ? 'busy' : 'free');
    const statusText = { free: 'Free', busy: 'Occupied', billed: `Bill ${o?.bill_no} printed` }[status];

    pane.innerHTML = `
      <div class="op-head">
        <div class="row"><span class="op-title">${esc(t.name)}</span><span class="muted">${esc(t.hall_name)} · ${t.seats} seats</span>
          <span class="spacer"></span><span class="badge ${status}">${esc(statusText)}</span></div>
        <div class="row" style="margin-top:8px">
          ${status === 'free' ? '<button class="btn btn-sm btn-warn" data-a="busy">Mark as occupied</button>' : ''}
          ${status !== 'free' && !items.length ? '<button class="btn btn-sm" data-a="free">Clear table (free)</button>' : ''}
          ${items.length ? '<button class="btn btn-sm" data-a="move">Move to table…</button>' : ''}
          ${items.length ? '<button class="btn btn-sm btn-danger" data-a="cancel">Cancel order</button>' : ''}
        </div>
      </div>
      <div class="op-add">
        <div class="row">
          <input class="search" placeholder="Item code or name  (e.g. 101 or 101*2)" autocomplete="off">
          <input class="qty" type="number" min="0.01" step="any" value="1" title="Quantity">
          <button class="btn btn-primary" data-a="add">Add</button>
        </div>
        <div class="suggest hidden"></div>
      </div>
      <div class="quick">
        <div class="quick-cats"></div>
        <div class="quick-items"></div>
      </div>
      <div class="op-lines">
        ${items.length ? `<table class="data"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Amount</th><th></th></tr></thead><tbody>
          ${items.map((it) => `<tr data-line="${it.id}">
            <td><div>${esc(it.name)}</div><div class="muted" style="font-size:12px">${esc(it.code)} · ${esc(cur(it.price))}</div></td>
            <td class="num"><span class="qty-ctl"><button class="btn btn-sm btn-icon" data-q="-1">−</button><input type="number" step="any" min="0" value="${qtyFmt(it.qty)}"><button class="btn btn-sm btn-icon" data-q="1">+</button></span></td>
            <td class="num">${money(it.price * it.qty)}</td>
            <td><button class="btn btn-sm btn-icon btn-danger" data-del title="Remove">×</button></td>
          </tr>`).join('')}
        </tbody></table>` : '<p class="muted" style="padding:14px">No items yet. Search by code/name above or tap an item below.</p>'}
      </div>
      ${items.length ? totalsHtml(o.totals) : ''}
      <div class="op-actions">
        <button class="btn btn-lg btn-primary" data-a="print" ${items.length ? '' : 'disabled'}>${o?.bill_no ? 'Reprint bill' : 'Print bill'}</button>
        <button class="btn btn-lg btn-success" data-a="settle" ${items.length ? '' : 'disabled'}>Settle &amp; clear</button>
      </div>`;

    pane.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => actions[b.dataset.a]()));
    pane.querySelectorAll('tr[data-line]').forEach((tr) => {
      const id = tr.dataset.line;
      const input = tr.querySelector('input');
      const setQty = (q) => api('PATCH', `/api/order-items/${id}`, { qty: Math.max(0, q) }).then(afterChange, toastErr);
      tr.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => setQty(Number(input.value) + Number(b.dataset.q))));
      input.onchange = () => setQty(Number(input.value));
      tr.querySelector('[data-del]').onclick = () => api('DELETE', `/api/order-items/${id}`).then(afterChange, toastErr);
    });
    const disc = pane.querySelector('input.disc');
    if (disc) disc.onchange = () => api('PATCH', `/api/tables/${t.id}/order`, { discountPct: Number(disc.value) || 0 }).then(afterChange, toastErr);
    setupSearch();
    renderQuick();
  }

  function totalsHtml(tt) {
    const s = state.settings;
    return `<div class="op-totals">
      <div class="line"><span>Subtotal</span><span>${money(tt.subtotal)}</span></div>
      <div class="line"><span>Discount <input class="disc" type="number" min="0" max="100" step="any" value="${tt.discountPct}"> %</span><span>${tt.discount ? '-' + money(tt.discount) : '0.00'}</span></div>
      ${tt.discount || s.pricesIncludeTax ? `<div class="line"><span>Taxable value</span><span>${money(tt.taxable)}</span></div>` : ''}
      <div class="line"><span>CGST @ ${tt.cgstPct}%</span><span>${money(tt.cgst)}</span></div>
      <div class="line"><span>SGST @ ${tt.sgstPct}%</span><span>${money(tt.sgst)}</span></div>
      ${tt.roundOff ? `<div class="line"><span>Round off</span><span>${money(tt.roundOff)}</span></div>` : ''}
      <div class="line grand"><span>Total</span><span>${esc(cur(tt.total))}</span></div>
    </div>`;
  }

  // ---------- item search ----------
  function matches(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const avail = state.menu.filter((m) => m.available);
    const exact = avail.filter((m) => m.code.toLowerCase() === q);
    const codeStart = avail.filter((m) => m.code.toLowerCase().startsWith(q) && !exact.includes(m));
    const nameHit = avail.filter((m) => !exact.includes(m) && !codeStart.includes(m) && m.name.toLowerCase().includes(q));
    return [...exact, ...codeStart, ...nameHit].slice(0, 10);
  }

  function setupSearch() {
    const input = pane.querySelector('input.search');
    const qty = pane.querySelector('input.qty');
    const box = pane.querySelector('.suggest');
    let list = [], active = 0, picked = null;

    const draw = () => {
      if (!list.length) { box.classList.add('hidden'); return; }
      box.classList.remove('hidden');
      box.innerHTML = list.map((m, i) => `<div class="${i === active ? 'active' : ''}" data-i="${i}"><span class="code">${esc(m.code)}</span><span><span class="${m.is_veg ? 'veg' : 'nonveg'}"></span>${esc(m.name)}</span><span class="price">${esc(cur(m.price))}</span></div>`).join('');
      box.querySelectorAll('[data-i]').forEach((d) => (d.onmousedown = (e) => { e.preventDefault(); pick(list[Number(d.dataset.i)]); }));
    };
    const pick = (m) => {
      picked = m;
      input.value = `${m.code} - ${m.name}`;
      list = []; draw();
      qty.focus(); qty.select();
    };
    input.oninput = () => {
      picked = null;
      const q = input.value.split('*')[0];
      list = matches(q); active = 0; draw();
    };
    input.onblur = () => setTimeout(() => { list = []; draw(); }, 150);
    input.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { active = Math.min(list.length - 1, active + 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
      else if (e.key === 'Escape') { list = []; draw(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const [code, q] = input.value.split('*');
        if (q !== undefined && code.trim()) {
          const m = state.menu.find((x) => x.code.toLowerCase() === code.trim().toLowerCase());
          if (!m) return toast(`No item with code ${code.trim()}`, 'error');
          return addItem(m, Number(q) || 1);
        }
        if (picked) return addItem(picked, Number(qty.value) || 1);
        if (list[active]) pick(list[active]);
      }
    };
    qty.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); actions.add(); } };
    actions.add = () => {
      if (picked) return addItem(picked, Number(qty.value) || 1);
      const m = matches(input.value.split('*')[0])[0];
      if (!m) return toast('Select an item first', 'error');
      addItem(m, Number(input.value.split('*')[1]) || Number(qty.value) || 1);
    };
  }

  async function addItem(m, qty) {
    try {
      const order = await api('POST', `/api/tables/${v.tableId}/items`, { itemId: m.id, qty });
      afterChange(order);
      toast(`Added ${qtyFmt(qty)} × ${m.name}`);
      pane.querySelector('input.search')?.focus();
    } catch (e) { toastErr(e); }
  }

  function renderQuick() {
    const cats = [...new Set(state.menu.filter((m) => m.available).map((m) => m.category || 'Other'))];
    if (v.category && !cats.includes(v.category)) v.category = '';
    const catEl = pane.querySelector('.quick-cats');
    const itemsEl = pane.querySelector('.quick-items');
    const collapsed = localStorage.getItem('quickCollapsed') === '1';
    pane.querySelector('.quick').classList.toggle('collapsed', collapsed);
    catEl.innerHTML = `<button class="chip" data-toggle title="Show/hide quick menu">${collapsed ? '▸ Menu' : '▾ Menu'}</button>` +
      ['', ...cats].map((c) => `<button class="chip ${c === v.category ? 'active' : ''}" data-c="${esc(c)}">${esc(c || 'All')}</button>`).join('');
    catEl.querySelector('[data-toggle]').onclick = () => { localStorage.setItem('quickCollapsed', collapsed ? '0' : '1'); renderQuick(); };
    catEl.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => {
      v.category = b.dataset.c;
      localStorage.setItem('quickCollapsed', '0');
      renderQuick();
    }));
    const items = state.menu.filter((m) => m.available && (!v.category || (m.category || 'Other') === v.category));
    itemsEl.innerHTML = items.map((m) => `<button data-id="${m.id}" title="${esc(m.name)} - ${esc(cur(m.price))}"><b>${esc(m.code)}</b> ${esc(m.name)}</button>`).join('');
    itemsEl.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => addItem(state.menu.find((m) => m.id === Number(b.dataset.id)), 1)));
  }

  // ---------- actions ----------
  const actions = {
    add() {},
    async busy() {
      await api('POST', `/api/tables/${v.tableId}/busy`, { busy: true }).catch(toastErr);
      await refreshFloor(); await loadOrder();
    },
    async free() {
      await api('POST', `/api/tables/${v.tableId}/busy`, { busy: false }).catch(toastErr);
      await refreshFloor(); await loadOrder();
    },
    async print() {
      try {
        const order = await api('POST', `/api/tables/${v.tableId}/bill`);
        afterChange(order);
        await printOrder(order);
      } catch (e) { toastErr(e); }
    },
    async settle() {
      const o = v.order;
      const choice = await modal(`Settle ${currentTable().name} — ${cur(o.totals.total)}`, (body, close) => {
        let mode = 'Cash';
        body.innerHTML = `
          <p class="muted">Select payment mode. The table will be cleared.</p>
          <div class="pay-modes">${PAY_MODES.map((m) => `<button class="btn ${m === mode ? 'active' : ''}" data-m="${m}">${m}</button>`).join('')}</div>
          <label class="check" style="margin-top:14px"><input type="checkbox" ${o.bill_no ? '' : 'checked'}> Print bill</label>
          <div class="actions"><button class="btn" data-x>Cancel</button><button class="btn btn-success btn-lg" data-ok>Settle &amp; clear</button></div>`;
        body.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => {
          mode = b.dataset.m;
          body.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('active', x === b));
        }));
        body.querySelector('[data-x]').onclick = () => close(null);
        body.querySelector('[data-ok]').onclick = () => close({ mode, print: body.querySelector('input').checked });
        body.querySelector('[data-ok]').focus();
      });
      if (!choice) return;
      try {
        const bill = await api('POST', `/api/tables/${v.tableId}/settle`, { paymentMode: choice.mode });
        toast(`Bill ${bill.bill_no} settled (${choice.mode})`, 'ok');
        if (choice.print) await printOrder(bill);
        v.order = null;
        await refreshFloor();
        renderPane();
      } catch (e) { toastErr(e); }
    },
    async cancel() {
      if (!(await confirmBox('Cancel this order? Items will be discarded (kept in the cancelled-orders log).', { okText: 'Cancel order', danger: true }))) return;
      const pin = await askPin('Admin PIN required');
      if (pin === undefined) return;
      try {
        await api('POST', `/api/tables/${v.tableId}/cancel`, { pin });
        toast('Order cancelled');
        await refreshFloor(); await loadOrder();
      } catch (e) { toastErr(e); }
    },
    async move() {
      const free = allTables().filter((t) => t.status === 'free');
      if (!free.length) return toast('No free tables', 'error');
      const to = await modal('Move order to…', (body, close) => {
        body.innerHTML = `<select size="10" style="width:100%">${free.map((t) => `<option value="${t.id}">${esc(t.hall_name)} — ${esc(t.name)}</option>`).join('')}</select>
          <div class="actions"><button class="btn" data-x>Cancel</button><button class="btn btn-primary" data-ok>Move</button></div>`;
        const sel = body.querySelector('select');
        sel.selectedIndex = 0;
        body.querySelector('[data-x]').onclick = () => close(null);
        body.querySelector('[data-ok]').onclick = () => close(Number(sel.value));
        sel.ondblclick = () => close(Number(sel.value));
      });
      if (!to) return;
      try {
        await api('POST', `/api/tables/${v.tableId}/move`, { toTableId: to });
        await refreshFloor();
        const target = allTables().find((t) => t.id === to);
        if (target) { v.hallId = target.hall_id; renderTabs(); }
        await selectTable(to);
      } catch (e) { toastErr(e); }
    },
  };

  // ---------- lifecycle ----------
  const onResize = () => renderHall();
  window.addEventListener('resize', onResize);
  (async () => {
    await loadMenu().catch(toastErr);
    await refreshFloor();
    renderPane();
  })();
  v.timer = setInterval(() => {
    if (document.hidden || document.querySelector('.modal-back')) return;
    refreshFloor();
  }, 5000);

  return () => { clearInterval(v.timer); window.removeEventListener('resize', onResize); };
}
