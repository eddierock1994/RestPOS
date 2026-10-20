// App shell: hash router, admin session, clock.
import { state, api, loadSettings, setToken, adminLogin, toastErr } from './api.js';
import { mountBilling } from './billing.js';
import { mountConfig } from './config.js';
import { mountBills } from './bills.js';
import { mountDashboard } from './dashboard.js';
import { mountClosings } from './closings.js';

const VIEWS = {
  billing: { mount: mountBilling, admin: false },
  dashboard: { mount: mountDashboard, admin: true },
  bills: { mount: mountBills, admin: true },
  closings: { mount: mountClosings, admin: true },
  config: { mount: mountConfig, admin: true },
};

const viewEl = document.getElementById('view');
const adminBtn = document.getElementById('adminBtn');
let unmount = null;
let currentView = null;

async function route() {
  const name = (location.hash.replace(/^#\/?/, '') || 'billing').split('/')[0];
  const view = VIEWS[name] ? name : 'billing';
  if (view === currentView && unmount) return;
  if (unmount?.isDirty?.() && !confirm('You have unsaved layout changes. Leave anyway?')) {
    history.replaceState(null, '', `#/${currentView}`);
    return;
  }
  if (VIEWS[view].admin && !state.token) {
    const ok = await adminLogin();
    if (!ok) { location.hash = '#/billing'; return; }
  }
  unmount?.();
  unmount = null;
  currentView = view;
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  viewEl.innerHTML = '';
  unmount = VIEWS[view].mount(viewEl) || null;
}

function renderAuth() {
  adminBtn.textContent = state.token ? 'Admin logout' : 'Admin login';
}

adminBtn.onclick = async () => {
  if (state.token) {
    await api('POST', '/api/logout').catch(() => {});
    setToken('');
  } else {
    await adminLogin();
  }
};

document.addEventListener('auth-changed', () => {
  renderAuth();
  if (!state.token && currentView && VIEWS[currentView].admin) location.hash = '#/billing';
});

function tick() {
  const d = new Date();
  document.getElementById('clock').textContent = d.toLocaleString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// Reminds staff (on every screen) when a session has ended but hasn't been closed yet.
async function checkClosing() {
  const el = document.getElementById('closeReminder');
  try {
    const r = await api('GET', '/api/closings/reminder');
    el.textContent = r.ended ? `Close ${r.session} session` : '';
    el.title = r.ended ? `The ${r.session} session (${r.date}) has ended. Click to close it and print the summary.` : '';
    el.classList.toggle('hidden', !r.ended);
  } catch { el.classList.add('hidden'); }
}

document.addEventListener('closings-changed', checkClosing);
window.addEventListener('hashchange', route);
(async () => {
  try { await loadSettings(); } catch (e) { toastErr(e); }
  if (state.token) {
    const s = await api('GET', '/api/session').catch(() => ({ admin: false }));
    if (!s.admin) setToken('');
  }
  renderAuth();
  tick();
  setInterval(tick, 30000);
  checkClosing();
  setInterval(checkClosing, 60000);
  route();
})();
