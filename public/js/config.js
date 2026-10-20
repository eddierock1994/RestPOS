// Admin configuration: menu, halls & table layout, restaurant/tax settings, printer, security & backups.
import { api, state, esc, money, h, toast, toastErr, modal, confirmBox, loadSettings, loadMenu, downloadFile, toCsv, parseCsv } from './api.js';
import { renderFloor } from './floor.js';
import { printTest } from './print.js';

const TABS = [
  ['menu', 'Menu list'],
  ['halls', 'Halls & layout'],
  ['settings', 'Restaurant & tax'],
  ['sessions', 'Sessions & closing'],
  ['printer', 'Printer'],
  ['security', 'Security & backup'],
];

export function mountConfig(root) {
  let active = sessionStorage.getItem('cfgTab') || 'menu';
  let cleanup = null;
  root.innerHTML = `<div class="config"><div class="tabs">${TABS.map(([k, l]) => `<button data-t="${k}">${esc(l)}</button>`).join('')}</div><div class="tab-body"></div></div>`;
  const body = root.querySelector('.tab-body');
  const show = async (k) => {
    if (cleanup?.isDirty?.() && !(await confirmBox('You have unsaved layout changes. Discard them?', { okText: 'Discard', danger: true }))) return;
    cleanup?.();
    active = k;
    sessionStorage.setItem('cfgTab', k);
    root.querySelectorAll('[data-t]').forEach((b) => b.classList.toggle('active', b.dataset.t === k));
    body.innerHTML = '';
    cleanup = ({ menu: menuTab, halls: hallsTab, settings: settingsTab, sessions: sessionsTab, printer: printerTab, security: securityTab })[k](body) || null;
  };
  root.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => show(b.dataset.t)));
  show(active);
  const destroy = () => cleanup?.();
  destroy.isDirty = () => !!cleanup?.isDirty?.();
  return destroy;
}

// ---------------- Menu ----------------
function menuTab(el) {
  let filter = '', cat = '';
  el.innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:12px">
        <h2 style="margin:0">Menu items</h2><span class="muted count"></span><span class="spacer"></span>
        <input class="f-search" placeholder="Search code / name" style="width:200px">
        <select class="f-cat"><option value="">All categories</option></select>
        <button class="btn btn-primary" data-add>+ Add item</button>
        <button class="btn" data-import>Import CSV</button>
        <button class="btn" data-export>Export CSV</button>
        <input type="file" accept=".csv,text/csv" class="hidden">
      </div>
      <div class="menu-table-wrap"><table class="data"><thead><tr>
        <th>Code</th><th>Name</th><th>Category</th><th class="num">Price</th><th>Type</th><th>Available</th><th></th>
      </tr></thead><tbody></tbody></table></div>
      <p class="muted" style="margin-bottom:0">Codes must be unique (e.g. 101, 102 … or short codes like PBM). Staff type the code on the billing screen to add an item quickly.</p>
    </div>`;
  const tbody = el.querySelector('tbody');
  const catSel = el.querySelector('.f-cat');

  const draw = () => {
    const cats = [...new Set(state.menu.map((m) => m.category).filter(Boolean))].sort();
    catSel.innerHTML = `<option value="">All categories</option>${cats.map((c) => `<option ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}`;
    const f = filter.toLowerCase();
    const rows = state.menu.filter((m) => (!cat || m.category === cat) && (!f || m.code.toLowerCase().includes(f) || m.name.toLowerCase().includes(f)));
    el.querySelector('.count').textContent = `${rows.length} of ${state.menu.length}`;
    tbody.innerHTML = rows.map((m) => `<tr class="${m.available ? '' : 'inactive'}" data-id="${m.id}">
      <td><b>${esc(m.code)}</b></td><td>${esc(m.name)}</td><td>${esc(m.category)}</td><td class="num">${money(m.price)}</td>
      <td><span class="${m.is_veg ? 'veg' : 'nonveg'}"></span>${m.is_veg ? 'Veg' : 'Non-veg'}</td>
      <td><label class="check"><input type="checkbox" data-av ${m.available ? 'checked' : ''}> ${m.available ? 'Yes' : 'No'}</label></td>
      <td class="right"><button class="btn btn-sm" data-edit>Edit</button> <button class="btn btn-sm btn-danger" data-del>Delete</button></td></tr>`).join('')
      || '<tr><td colspan="7" class="muted">No items</td></tr>';
    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      const m = state.menu.find((x) => x.id === Number(tr.dataset.id));
      tr.querySelector('[data-edit]').onclick = () => editItem(m);
      tr.querySelector('[data-del]').onclick = async () => {
        if (!(await confirmBox(`Delete "${m.name}" (${m.code})? Past bills are not affected.`, { okText: 'Delete', danger: true }))) return;
        await api('DELETE', `/api/menu/${m.id}`).then(reload, toastErr);
      };
      tr.querySelector('[data-av]').onchange = (e) => api('PUT', `/api/menu/${m.id}`, { ...m, available: e.target.checked }).then(reload, toastErr);
    });
  };
  const reload = () => loadMenu().then(draw, toastErr);

  async function editItem(m = null) {
    const cats = [...new Set(state.menu.map((x) => x.category).filter(Boolean))];
    await modal(m ? `Edit ${m.name}` : 'Add menu item', (body, close) => {
      body.innerHTML = `<form class="form-grid" style="grid-template-columns:1fr 1fr;min-width:460px">
        <label class="field">Code *<input name="code" required maxlength="20" value="${esc(m?.code)}"></label>
        <label class="field">Price *<input name="price" type="number" min="0" step="0.01" required value="${m ? m.price : ''}"></label>
        <label class="field" style="grid-column:1/-1">Name *<input name="name" required value="${esc(m?.name)}"></label>
        <label class="field">Category<input name="category" list="catlist" value="${esc(m?.category)}"><datalist id="catlist">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
        <label class="field">Type<select name="is_veg"><option value="1">Veg</option><option value="0" ${m && !m.is_veg ? 'selected' : ''}>Non-veg</option></select></label>
        <label class="check"><input type="checkbox" name="available" ${!m || m.available ? 'checked' : ''}> Available</label>
        <div class="actions" style="grid-column:1/-1">${m ? '' : '<label class="check" style="margin-right:auto"><input type="checkbox" name="again" checked> Add another</label>'}
          <button type="button" class="btn" data-x>Cancel</button><button class="btn btn-primary">Save</button></div>
      </form>`;
      const f = body.querySelector('form');
      f.code.focus();
      body.querySelector('[data-x]').onclick = () => close();
      f.onsubmit = async (e) => {
        e.preventDefault();
        const data = { code: f.code.value, name: f.name.value, category: f.category.value, price: Number(f.price.value), is_veg: f.is_veg.value === '1', available: f.available.checked };
        try {
          if (m) await api('PUT', `/api/menu/${m.id}`, data); else await api('POST', '/api/menu', data);
          toast('Saved', 'ok');
          await reload();
          if (!m && f.again.checked) { f.code.value = ''; f.name.value = ''; f.price.value = ''; f.code.focus(); } else close();
        } catch (err) { toastErr(err); }
      };
    });
  }

  el.querySelector('.f-search').oninput = (e) => { filter = e.target.value; draw(); };
  catSel.onchange = (e) => { cat = e.target.value; draw(); };
  el.querySelector('[data-add]').onclick = () => editItem();
  el.querySelector('[data-export]').onclick = () => {
    const rows = [['code', 'name', 'category', 'price', 'veg', 'available'], ...state.menu.map((m) => [m.code, m.name, m.category, m.price, m.is_veg ? 1 : 0, m.available ? 1 : 0])];
    downloadFile('menu.csv', toCsv(rows));
  };
  const file = el.querySelector('input[type=file]');
  el.querySelector('[data-import]').onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files[0];
    file.value = '';
    if (!f) return;
    const rows = parseCsv(await f.text());
    const header = rows[0].map((x) => x.trim().toLowerCase());
    const idx = (n) => header.indexOf(n);
    if (idx('code') < 0 || idx('name') < 0 || idx('price') < 0) return toast('CSV needs a header row with at least: code,name,price (optional: category,veg,available)', 'error');
    const yes = (v, d) => (v === undefined || v.trim() === '' ? d : /^(1|y|yes|true|veg)$/i.test(v.trim()));
    const items = rows.slice(1).map((r) => ({
      code: r[idx('code')], name: r[idx('name')], price: Number(r[idx('price')]),
      category: idx('category') >= 0 ? r[idx('category')] : '',
      is_veg: idx('veg') >= 0 ? yes(r[idx('veg')], true) : true,
      available: idx('available') >= 0 ? yes(r[idx('available')], true) : true,
    }));
    if (!(await confirmBox(`Import ${items.length} items? Existing items with the same code will be updated.`, { okText: 'Import' }))) return;
    try { const r = await api('POST', '/api/menu/import', { items }); toast(`Imported ${r.imported} items`, 'ok'); reload(); } catch (e) { toastErr(e); }
  };
  reload();
}

// ---------------- Halls & layout ----------------
function hallsTab(el) {
  let halls = [], hallId = null, tables = [], selected = null, dirty = false;
  el.style.height = '100%';
  el.innerHTML = `
    <div class="halls-layout">
      <div class="hall-list">
        <h3>Halls</h3>
        <div class="list"></div>
        <button class="btn btn-primary" data-addhall>+ Add hall</button>
        <p class="muted" style="font-size:12px">Each hall has its own table layout. Drag tables to arrange them; drag the blue corner to resize.</p>
      </div>
      <div class="editor">
        <div class="row toolbar"></div>
        <div class="floor-wrap"></div>
      </div>
      <div class="props panel"></div>
    </div>`;
  const listEl = el.querySelector('.list');
  const toolbar = el.querySelector('.toolbar');
  const wrap = el.querySelector('.floor-wrap');
  const props = el.querySelector('.props');
  const hall = () => halls.find((x) => x.id === hallId);

  async function load(keepId = hallId) {
    halls = await api('GET', '/api/floor');
    hallId = halls.some((x) => x.id === keepId) ? keepId : halls[0]?.id ?? null;
    tables = structuredClone(hall()?.tables || []);
    selected = null; dirty = false;
    drawList(); drawEditor();
  }

  function drawList() {
    listEl.innerHTML = '';
    halls.forEach((x, i) => {
      const it = h(`<div class="hall-item ${x.id === hallId ? 'active' : ''}"><span class="name">${esc(x.name)}</span>
        <button class="btn btn-sm btn-icon" data-up title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn btn-sm btn-icon" data-down title="Move down" ${i === halls.length - 1 ? 'disabled' : ''}>↓</button></div>`);
      it.onclick = async (e) => {
        if (e.target.closest('button') || x.id === hallId) return;
        if (dirty && !(await confirmBox('Discard unsaved layout changes?', { okText: 'Discard', danger: true }))) return;
        hallId = x.id; tables = structuredClone(x.tables); selected = null; dirty = false;
        drawList(); drawEditor();
      };
      const swap = async (j) => {
        const ids = halls.map((hh) => hh.id);
        [ids[i], ids[j]] = [ids[j], ids[i]];
        try {
          for (let k = 0; k < ids.length; k++) await api('PUT', `/api/halls/${ids[k]}`, { sort_order: k });
          await reloadKeep();
        } catch (err) { toastErr(err); }
      };
      it.querySelector('[data-up]').onclick = () => swap(i - 1);
      it.querySelector('[data-down]').onclick = () => swap(i + 1);
      listEl.appendChild(it);
    });
  }

  function drawEditor() {
    const x = hall();
    if (!x) { toolbar.innerHTML = ''; wrap.innerHTML = '<p class="muted">Add a hall to begin.</p>'; props.innerHTML = ''; return; }
    toolbar.innerHTML = `
      <b>${esc(x.name)}</b>
      <button class="btn btn-sm" data-rename>Rename</button>
      <button class="btn btn-sm btn-danger" data-delhall>Delete hall</button>
      <span class="spacer"></span>
      <button class="btn btn-sm" data-new="square">+ Square</button>
      <button class="btn btn-sm" data-new="round">+ Round</button>
      <button class="btn btn-sm" data-new="rect">+ Long</button>
      <span class="muted">Floor</span>
      <input type="number" class="fw" value="${x.width}" style="width:72px" min="300" step="50"> ×
      <input type="number" class="fh" value="${x.height}" style="width:72px" min="200" step="50">
      <button class="btn btn-sm" data-revert ${dirty ? '' : 'disabled'}>Revert</button>
      <button class="btn btn-sm btn-primary" data-save ${dirty ? '' : 'disabled'}>Save layout</button>`;
    toolbar.querySelector('[data-rename]').onclick = async () => {
      const name = await promptText('Rename hall', x.name);
      if (name) api('PUT', `/api/halls/${x.id}`, { name }).then(() => reloadKeep(), toastErr);
    };
    toolbar.querySelector('[data-delhall]').onclick = async () => {
      if (!(await confirmBox(`Delete hall "${x.name}" and all its tables?`, { okText: 'Delete', danger: true }))) return;
      api('DELETE', `/api/halls/${x.id}`).then(() => load(null), toastErr);
    };
    toolbar.querySelectorAll('[data-new]').forEach((b) => (b.onclick = () => addTable(b.dataset.new)));
    const resizeFloor = () => {
      const w = Math.max(300, Number(toolbar.querySelector('.fw').value) || x.width);
      const hh = Math.max(200, Number(toolbar.querySelector('.fh').value) || x.height);
      api('PUT', `/api/halls/${x.id}`, { width: w, height: hh }).then(() => reloadKeep(), toastErr);
    };
    toolbar.querySelector('.fw').onchange = resizeFloor;
    toolbar.querySelector('.fh').onchange = resizeFloor;
    toolbar.querySelector('[data-revert]').onclick = () => load(hallId);
    toolbar.querySelector('[data-save]').onclick = save;
    drawFloor();
    drawProps();
  }

  async function reloadKeep() {
    const keepTables = tables, keepDirty = dirty;
    await load(hallId);
    if (keepDirty) { tables = keepTables; dirty = true; drawEditor(); }
  }

  function markDirty() {
    dirty = true;
    toolbar.querySelector('[data-save]').disabled = false;
    toolbar.querySelector('[data-revert]').disabled = false;
  }

  function drawFloor() {
    renderFloor(wrap, hall(), {
      tables, editable: true, selectedId: selected,
      onSelect: (t) => { selected = t; drawProps(); },
      onChange: () => { markDirty(); drawProps(); },
    });
  }

  function drawProps() {
    const t = selected;
    if (!t) { props.innerHTML = `<h3>Table</h3><p class="muted">Select a table to edit its name, seats and shape.</p><p class="muted">${tables.length} tables in this hall.</p>`; return; }
    props.innerHTML = `<h3>Table ${esc(t.name)}</h3><div class="form-grid">
      <label class="field">Name / number<input name="name" maxlength="20" value="${esc(t.name)}"></label>
      <label class="field">Seats<input name="seats" type="number" min="0" value="${t.seats}"></label>
      <label class="field">Shape<select name="shape">${['square', 'round', 'rect'].map((s) => `<option value="${s}" ${t.shape === s ? 'selected' : ''}>${{ square: 'Square', round: 'Round', rect: 'Long / rectangle' }[s]}</option>`).join('')}</select></label>
      <div class="row"><label class="field grow">Width<input name="w" type="number" min="40" step="10" value="${t.w}"></label><label class="field grow">Height<input name="h" type="number" min="40" step="10" value="${t.h}"></label></div>
      <button class="btn" data-dup>Duplicate</button>
      <button class="btn btn-danger" data-del>Delete table</button></div>`;
    props.querySelectorAll('input, select').forEach((inp) => (inp.onchange = () => {
      const v = inp.name === 'name' || inp.name === 'shape' ? inp.value.trim() : Math.max(inp.name === 'seats' ? 0 : 40, Number(inp.value) || 0);
      if (inp.name === 'name' && !v) return;
      t[inp.name] = v;
      if (inp.name === 'shape' && v !== 'rect') t.h = t.w;
      markDirty(); drawFloor(); drawProps();
    }));
    props.querySelector('[data-del]').onclick = () => { tables = tables.filter((x) => x !== t); selected = null; markDirty(); drawFloor(); drawProps(); };
    props.querySelector('[data-dup]').onclick = () => addTable(t.shape, t);
  }

  function nextName() {
    const prefix = (tables[0]?.name.match(/^[A-Za-z]*/)?.[0]) || 'T';
    let n = tables.length + 1;
    const names = new Set(tables.map((t) => t.name.toLowerCase()));
    while (names.has(`${prefix}${n}`.toLowerCase())) n++;
    return `${prefix}${n}`;
  }

  function addTable(shape, from = null) {
    const x = hall();
    const w = from?.w ?? (shape === 'rect' ? 200 : 110), hh = from?.h ?? 110;
    // find a free spot scanning a grid
    let pos = { x: 20, y: 20 };
    outer: for (let yy = 20; yy + hh <= x.height; yy += 30) {
      for (let xx = 20; xx + w <= x.width; xx += 30) {
        if (!tables.some((t) => xx < t.x + t.w + 10 && xx + w + 10 > t.x && yy < t.y + t.h + 10 && yy + hh + 10 > t.y)) { pos = { x: xx, y: yy }; break outer; }
      }
    }
    const t = { id: null, name: nextName(), seats: from?.seats ?? (shape === 'rect' ? 6 : 4), shape, w, h: hh, ...pos };
    tables.push(t);
    selected = t;
    markDirty(); drawFloor(); drawProps();
  }

  async function save() {
    try {
      await api('PUT', `/api/halls/${hallId}/layout`, { tables });
      toast('Layout saved', 'ok');
      await load(hallId);
    } catch (e) { toastErr(e); }
  }

  el.querySelector('[data-addhall]').onclick = async () => {
    const name = await promptText('New hall name', '');
    if (!name) return;
    try { const hh = await api('POST', '/api/halls', { name }); await load(hh.id); } catch (e) { toastErr(e); }
  };

  const onResize = () => hall() && drawFloor();
  window.addEventListener('resize', onResize);
  load().catch(toastErr);
  const cleanup = () => window.removeEventListener('resize', onResize);
  cleanup.isDirty = () => dirty;
  return cleanup;
}

function promptText(title, value) {
  return modal(title, (body, close) => {
    body.innerHTML = `<form><input style="width:100%" required maxlength="60" value="${esc(value)}"><div class="actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn btn-primary">OK</button></div></form>`;
    const inp = body.querySelector('input');
    inp.focus(); inp.select();
    body.querySelector('[data-x]').onclick = () => close(null);
    body.querySelector('form').onsubmit = (e) => { e.preventDefault(); close(inp.value.trim()); };
  });
}

// ---------------- Settings forms ----------------
function settingsForm(el, title, fields, { extra = '', after } = {}) {
  const s = state.settings;
  const input = (f) => {
    const v = s[f.key];
    if (f.type === 'check') return `<label class="check"><input type="checkbox" name="${f.key}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
    if (f.type === 'select') return `<label class="field">${esc(f.label)}<select name="${f.key}">${f.options.map(([ov, ol]) => `<option value="${esc(ov)}" ${String(v) === String(ov) ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select></label>`;
    return `<label class="field">${esc(f.label)}<input name="${f.key}" type="${f.type || 'text'}" ${f.type === 'number' ? `step="${f.step || 'any'}" min="${f.min ?? 0}"` : ''} value="${esc(v)}" ${f.required ? 'required' : ''}>${f.hint ? `<span style="font-size:12px">${esc(f.hint)}</span>` : ''}</label>`;
  };
  el.innerHTML = `<form class="panel" style="max-width:1000px"><h2>${esc(title)}</h2><div class="form-grid">${fields.map(input).join('')}</div>${extra}
    <div class="actions" style="margin-top:18px"><button class="btn btn-primary btn-lg">Save</button></div></form>`;
  const form = el.querySelector('form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = {};
    for (const f of fields) {
      const inp = form.elements[f.key];
      data[f.key] = f.type === 'check' ? inp.checked : f.type === 'number' ? Number(inp.value) : inp.value;
    }
    try { await api('PUT', '/api/settings', data); await loadSettings(); toast('Settings saved', 'ok'); } catch (err) { toastErr(err); }
  };
  after?.(form);
}

function settingsTab(el) {
  settingsForm(el, 'Restaurant & tax settings', [
    { key: 'restaurantName', label: 'Restaurant name', required: true },
    { key: 'phone', label: 'Phone' },
    { key: 'addressLine1', label: 'Address line 1' },
    { key: 'addressLine2', label: 'Address line 2' },
    { key: 'gstin', label: 'GSTIN' },
    { key: 'fssai', label: 'FSSAI licence no.' },
    { key: 'cgstPercent', label: 'CGST %', type: 'number', hint: 'Restaurants commonly 2.5' },
    { key: 'sgstPercent', label: 'SGST %', type: 'number', hint: 'Restaurants commonly 2.5' },
    { key: 'currencySymbol', label: 'Currency symbol' },
    { key: 'billPrefix', label: 'Bill number prefix', hint: 'e.g. B or 2026-27/' },
    { key: 'nextBillNumber', label: 'Next bill number', type: 'number', step: 1, min: 1, hint: 'Reset to 1 at the start of a financial year' },
    { key: 'billFooter', label: 'Bill footer message' },
    { key: 'pricesIncludeTax', label: 'Menu prices already include GST', type: 'check' },
    { key: 'roundOff', label: 'Round total to nearest rupee', type: 'check' },
  ]);
}

function printerTab(el) {
  const extra = `<div class="panel" style="margin-top:16px;background:#f9fafb">
    <h3>Which mode should I use?</h3>
    <ul style="margin:0;padding-left:18px;line-height:1.6">
      <li><b>Browser print</b> – works with any printer that has a Windows driver. Set the thermal printer as the Windows <i>default printer</i>. The launcher starts Edge with <code>--kiosk-printing</code>, so bills print instantly without a dialog.</li>
      <li><b>Windows printer (raw ESC/POS)</b> – USB printer installed in Windows. Sends printer commands directly: crisp text and automatic paper cut. Pick the printer from the list – receipt printers on a <code>USB001</code>-style port are shown first.</li>
      <li><b>Network printer (ESC/POS)</b> – LAN/Wi‑Fi thermal printer. Enter its IP address (print the printer's self-test page to see it); port is usually 9100.</li>
    </ul>
    <p style="margin:10px 0 0"><b>Can't tell which printer is yours?</b> Most Indian thermal printers (LS / Logon Systems, Xprinter, Rugtek, Everycom…) install as
      <b>POS-80C</b>, <b>POS-80</b> or <b>POS-58</b> on a <b>USB001</b> port – the brand name does not appear. Unplug the printer's USB cable, press
      <i>Refresh printer list</i>, and the one that shows <b>OFFLINE</b> or disappears is yours.</p>
    <div class="row" style="margin-top:12px"><button type="button" class="btn" data-test>Print test page</button><button type="button" class="btn" data-refresh>Refresh printer list</button><span class="muted">Save settings first, then test.</span></div>
  </div>`;
  settingsForm(el, 'Thermal printer', [
    { key: 'printerMode', label: 'Print mode', type: 'select', options: [['browser', 'Browser print (any driver)'], ['windows', 'Windows printer – raw ESC/POS (USB)'], ['network', 'Network printer – ESC/POS (IP)']] },
    { key: 'printerName', label: 'Windows printer name', type: 'select', options: [[state.settings.printerName, state.settings.printerName || '(loading…)']] },
    { key: 'printerIp', label: 'Network printer IP', hint: 'e.g. 192.168.1.87' },
    { key: 'printerPort', label: 'Network printer port', type: 'number', step: 1 },
    { key: 'paperWidth', label: 'Paper width', type: 'select', options: [['80', '80 mm (3 inch)'], ['58', '58 mm (2 inch)']] },
    { key: 'printCopies', label: 'Copies per bill', type: 'number', step: 1, min: 1 },
    { key: 'autoCut', label: 'Auto-cut paper after bill (ESC/POS modes)', type: 'check' },
  ], {
    extra,
    after: async (form) => {
      form.querySelector('[data-test]').onclick = () => printTest().catch(toastErr);
      const sel = form.elements.printerName;
      const sync = () => {
        const m = form.elements.printerMode.value;
        sel.closest('label').classList.toggle('hidden', m !== 'windows');
        form.elements.printerIp.closest('label').classList.toggle('hidden', m !== 'network');
        form.elements.printerPort.closest('label').classList.toggle('hidden', m !== 'network');
        form.elements.autoCut.closest('label').classList.toggle('hidden', m === 'browser');
      };
      form.elements.printerMode.onchange = sync;
      sync();
      const loadPrinters = async () => {
        const current = sel.value || state.settings.printerName;
        sel.innerHTML = '<option value="">(loading printers…)</option>';
        try {
          const printers = await api('GET', '/api/printers');
          const label = (p) => `${p.name}  —  ${(p.port || '?').length > 24 ? p.port.slice(0, 22) + '…' : p.port || '?'}${p.driver && p.driver !== p.name ? ` · ${p.driver}` : ''}${p.isDefault ? ' · default' : ''}${p.offline ? ' · OFFLINE' : ''}`;
          const opt = (p) => `<option value="${esc(p.name)}" ${p.name === current ? 'selected' : ''}>${esc(label(p))}</option>`;
          const receipt = printers.filter((p) => p.receipt), other = printers.filter((p) => !p.receipt && !p.virtual), virt = printers.filter((p) => p.virtual);
          const missing = current && !printers.some((p) => p.name === current) ? `<option selected value="${esc(current)}">${esc(current)} (not found)</option>` : '';
          sel.innerHTML = `<option value="">— select —</option>${missing}
            ${receipt.length ? `<optgroup label="Likely receipt printers (USB / POS)">${receipt.map(opt).join('')}</optgroup>`
              : '<option value="" disabled>No USB receipt printer found – check the cable, power and driver, then Refresh</option>'}
            ${other.length ? `<optgroup label="Other printers">${other.map(opt).join('')}</optgroup>` : ''}
            ${virt.length ? `<optgroup label="Not printers (PDF / XPS / OneNote / Fax)">${virt.map(opt).join('')}</optgroup>` : ''}`;
          if (!current && receipt.length === 1) sel.value = receipt[0].name;
        } catch (e) { toastErr(e); }
      };
      form.querySelector('[data-refresh]').onclick = loadPrinters;
      sel.closest('label').style.gridColumn = 'span 2';
      await loadPrinters();
    },
  });
}

function securityTab(el) {
  el.innerHTML = `
    <div style="display:grid;gap:16px;max-width:1000px">
      <form class="panel pin"><h2>Change admin PIN</h2>
        <p class="muted">The admin PIN protects Configuration, Bills &amp; Reports and cancelling orders. Default PIN is <b>1234</b> — change it now.</p>
        <div class="form-grid">
          <label class="field">Current PIN<input name="cur" type="password" inputmode="numeric" required></label>
          <label class="field">New PIN (4–8 digits)<input name="n1" type="password" inputmode="numeric" pattern="\\d{4,8}" required></label>
          <label class="field">Repeat new PIN<input name="n2" type="password" inputmode="numeric" required></label>
        </div>
        <div class="actions"><button class="btn btn-primary">Change PIN</button></div>
      </form>
      <div class="panel"><h2>Backups</h2>
        <p class="muted">A backup is taken automatically every day while the POS is running. You can also copy the backup folder to a pen drive regularly.</p>
        <div class="row"><button class="btn btn-primary" data-backup>Back up now</button>
          <label class="field" style="flex-direction:row;align-items:center;gap:6px">Keep automatic backups for <input type="number" class="days" min="1" style="width:70px" value="${state.settings.autoBackupDays}"> days</label>
          <button class="btn btn-sm" data-savedays>Save</button></div>
        <p class="muted dir"></p>
        <div class="menu-table-wrap" style="max-height:300px"><table class="data"><thead><tr><th>File</th><th class="num">Size</th><th>Time</th></tr></thead><tbody></tbody></table></div>
      </div>
    </div>`;
  const pin = el.querySelector('form.pin');
  pin.onsubmit = async (e) => {
    e.preventDefault();
    if (pin.n1.value !== pin.n2.value) return toast('New PINs do not match', 'error');
    try { await api('POST', '/api/settings/pin', { currentPin: pin.cur.value, newPin: pin.n1.value }); toast('PIN changed', 'ok'); pin.reset(); } catch (err) { toastErr(err); }
  };
  const loadBackups = async () => {
    try {
      const r = await api('GET', '/api/backups');
      el.querySelector('.dir').textContent = `Backup folder: ${r.dir}`;
      el.querySelector('tbody').innerHTML = r.files.map((f) => `<tr><td>${esc(f.name)}</td><td class="num">${(f.size / 1024).toFixed(0)} KB</td><td>${esc(new Date(f.time).toLocaleString())}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No backups yet</td></tr>';
    } catch (e) { toastErr(e); }
  };
  el.querySelector('[data-backup]').onclick = () => api('POST', '/api/backups').then((r) => { toast(`Backup saved: ${r.name}`, 'ok'); loadBackups(); }, toastErr);
  el.querySelector('[data-savedays]').onclick = () => api('PUT', '/api/settings', { autoBackupDays: Number(el.querySelector('.days').value) }).then(() => { loadSettings(); toast('Saved', 'ok'); }, toastErr);
  loadBackups();
}

// ---------------- Sessions & closing ----------------
function sessionsTab(el) {
  let rows = structuredClone(state.settings.sessions || []);
  el.innerHTML = `<form class="panel" style="max-width:820px">
    <h2>Sessions &amp; closing</h2>
    <p class="muted" style="margin-top:0">Split the day into sessions (e.g. Morning, Afternoon, Night). At the end of each session an admin closes it from the
      <b>Closings</b> page and prints a summary: income, GST and total. A bill belongs to the session that was running when it was settled; bills settled
      a little after the end time still count until the session is closed. A session may run past midnight (e.g. 18:00–01:00).</p>
    <table class="data sessions"><thead><tr><th>Session name</th><th>Start</th><th>End</th><th></th></tr></thead><tbody></tbody></table>
    <div class="row" style="margin-top:10px"><button type="button" class="btn" data-add>+ Add session</button></div>
    <div class="row" style="margin-top:16px">
      <label class="field" style="flex-direction:row;align-items:center;gap:8px">If a session was not closed, keep counting its late bills for
        <input type="number" name="grace" min="0" max="240" step="5" style="width:80px" value="${state.settings.closingGraceMinutes ?? 30}"> minutes after the next session starts</label>
    </div>
    <div class="actions" style="margin-top:18px"><button class="btn btn-primary btn-lg">Save</button></div>
  </form>`;
  const tbody = el.querySelector('tbody');
  const draw = () => {
    tbody.innerHTML = rows.map((r, i) => `<tr data-i="${i}">
      <td><input data-k="name" maxlength="30" value="${esc(r.name)}" style="width:100%"></td>
      <td><input data-k="start" type="time" value="${esc(r.start)}"></td>
      <td><input data-k="end" type="time" value="${esc(r.end)}"></td>
      <td class="right"><button type="button" class="btn btn-sm btn-danger" data-del ${rows.length < 2 ? 'disabled' : ''}>Remove</button></td></tr>`).join('');
    tbody.querySelectorAll('tr').forEach((tr) => {
      const r = rows[Number(tr.dataset.i)];
      tr.querySelectorAll('input').forEach((inp) => (inp.oninput = () => { r[inp.dataset.k] = inp.value; }));
      tr.querySelector('[data-del]').onclick = () => { rows = rows.filter((x) => x !== r); draw(); };
    });
  };
  el.querySelector('[data-add]').onclick = () => { rows.push({ name: '', start: '', end: '' }); draw(); tbody.querySelector('tr:last-child input').focus(); };
  el.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/settings', { sessions: rows, closingGraceMinutes: Number(el.querySelector('[name=grace]').value) || 0 });
      await loadSettings();
      rows = structuredClone(state.settings.sessions);
      draw();
      toast('Sessions saved', 'ok');
    } catch (err) { toastErr(err); }
  };
  draw();
}