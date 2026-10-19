// Shared helpers: API client, state, formatting, toasts, modals.
export const state = {
  settings: {},
  menu: [],
  token: sessionStorage.getItem('adminToken') || '',
};

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': state.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && /Admin login/.test(data?.error || '')) setToken('');
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function setToken(t) {
  state.token = t || '';
  if (t) sessionStorage.setItem('adminToken', t); else sessionStorage.removeItem('adminToken');
  document.dispatchEvent(new CustomEvent('auth-changed'));
}

export async function loadSettings() {
  state.settings = await api('GET', '/api/settings');
  document.getElementById('brand').textContent = state.settings.restaurantName || 'Restaurant POS';
  document.title = `${state.settings.restaurantName} - POS`;
  return state.settings;
}

export async function loadMenu() {
  state.menu = await api('GET', '/api/menu');
  return state.menu;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (n) => Number(n || 0).toFixed(2);
export const cur = (n) => `${state.settings.currencySymbol || ''}${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const qtyFmt = (q) => (Number.isInteger(Number(q)) ? String(q) : Number(q).toFixed(2));

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function toast(msg, type = '') {
  const el = h(`<div class="toast ${type}">${esc(msg)}</div>`);
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 5000 : 2500);
}
export const toastErr = (e) => toast(e.message || String(e), 'error');

/** Opens a modal. `build(modalEl, close)` populates it. Returns a promise resolved by close(value). */
export function modal(title, build) {
  return new Promise((resolve) => {
    const back = h(`<div class="modal-back"><div class="modal"><h3>${esc(title)}</h3><div class="mbody"></div></div></div>`);
    const m = back.querySelector('.modal');
    const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(undefined); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(undefined); });
    document.getElementById('modalRoot').appendChild(back);
    build(m.querySelector('.mbody'), close);
  });
}

export function confirmBox(message, { okText = 'OK', danger = false } = {}) {
  return modal('Please confirm', (body, close) => {
    body.innerHTML = `<p>${esc(message)}</p><div class="actions"><button class="btn" data-x>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okText)}</button></div>`;
    body.querySelector('[data-x]').onclick = () => close(false);
    body.querySelector('[data-ok]').onclick = () => close(true);
    body.querySelector('[data-ok]').focus();
  });
}

export function askPin(title = 'Admin PIN') {
  return modal(title, (body, close) => {
    body.innerHTML = `<form><label class="field">Enter admin PIN<input type="password" inputmode="numeric" autocomplete="off" required></label>
      <div class="actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn btn-primary">OK</button></div></form>`;
    const input = body.querySelector('input');
    body.querySelector('[data-x]').onclick = () => close(undefined);
    body.querySelector('form').onsubmit = (e) => { e.preventDefault(); close(input.value); };
    input.focus();
  });
}

export async function adminLogin() {
  const pin = await askPin('Admin login');
  if (pin === undefined) return false;
  try {
    const { token } = await api('POST', '/api/login', { pin });
    setToken(token);
    toast('Logged in as admin', 'ok');
    return true;
  } catch (e) { toastErr(e); return false; }
}

export function todayStr(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

/** Common reporting periods: [key, label, from, to]. Week starts Monday; FY starts 1 April. */
export function periodPresets(now = new Date()) {
  const t = todayStr(now);
  const shift = (n) => { const x = new Date(now); x.setDate(x.getDate() + n); return todayStr(x); };
  const monday = shift(-((now.getDay() + 6) % 7));
  const y = now.getFullYear(), m = now.getMonth();
  const fyStart = m >= 3 ? new Date(y, 3, 1) : new Date(y - 1, 3, 1);
  return [
    ['today', 'Today', t, t],
    ['yesterday', 'Yesterday', shift(-1), shift(-1)],
    ['week', 'This week', monday, t],
    ['lastweek', 'Last week', shift(-((now.getDay() + 6) % 7) - 7), shift(-((now.getDay() + 6) % 7) - 1)],
    ['month', 'This month', todayStr(new Date(y, m, 1)), t],
    ['lastmonth', 'Last month', todayStr(new Date(y, m - 1, 1)), todayStr(new Date(y, m, 0))],
    ['fy', 'This FY', todayStr(fyStart), t],
  ];
}

/** Renders a period picker (presets + custom dates). Persists the choice for the session. */
export function periodBar(el, onChange) {
  const saved = JSON.parse(sessionStorage.getItem('period') || 'null');
  const presets = periodPresets();
  let from = saved?.from || presets[0][2], to = saved?.to || presets[0][3];
  if (saved?.preset) { const p = presets.find((x) => x[0] === saved.preset); if (p) { from = p[2]; to = p[3]; } }
  el.innerHTML = `<div class="period">
    ${presets.map(([k, l]) => `<button class="chip" data-p="${k}">${esc(l)}</button>`).join('')}
    <span class="period-dates"><input type="date" class="from"> <span class="muted">to</span> <input type="date" class="to"></span></div>`;
  const fromEl = el.querySelector('.from'), toEl = el.querySelector('.to');
  const apply = (preset) => {
    if (to < from) [from, to] = [to, from];
    fromEl.value = from; toEl.value = to;
    const matches = presets.filter((p) => p[2] === from && p[3] === to).map((p) => p[0]);
    const active = matches.includes(preset) ? preset : matches[0];
    el.querySelectorAll('[data-p]').forEach((b) => b.classList.toggle('active', b.dataset.p === active));
    sessionStorage.setItem('period', JSON.stringify({ from, to, preset: preset || null }));
    onChange(from, to);
  };
  el.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => {
    const p = presets.find((x) => x[0] === b.dataset.p);
    from = p[2]; to = p[3]; apply(p[0]);
  }));
  fromEl.onchange = () => { from = fromEl.value || from; apply(); };
  toEl.onchange = () => { to = toEl.value || to; apply(); };
  apply(saved?.preset);
}

export function downloadFile(name, content, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function toCsv(rows) {
  return rows.map((r) => r.map((v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
}

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}
