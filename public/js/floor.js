// Renders a hall's floor plan, scaled to fit its container. Optional edit mode
// supports dragging and resizing tables (coordinates are in hall units).
import { esc, cur } from './api.js';

const GRID = 10;
const snap = (v) => Math.round(v / GRID) * GRID;

export function renderFloor(wrap, hall, { tables = hall.tables, selectedId = null, onSelect, editable = false, onChange } = {}) {
  wrap.innerHTML = '';
  const floor = document.createElement('div');
  floor.className = 'floor' + (editable ? ' editing' : '');
  floor.style.width = hall.width + 'px';
  floor.style.height = hall.height + 'px';
  wrap.appendChild(floor);

  let scale = 1;
  const fit = () => {
    const w = wrap.clientWidth - 2, hgt = wrap.clientHeight - 2;
    scale = Math.max(0.2, Math.min(w / hall.width, hgt > 50 ? hgt / hall.height : Infinity, 2));
    floor.style.transform = `scale(${scale})`;
  };
  fit();

  for (const t of tables) {
    const el = document.createElement('div');
    const status = editable ? 'free' : t.status;
    el.className = `tbl ${t.shape === 'round' ? 'round' : ''} ${status} ${t === selectedId || t.id === selectedId ? 'selected' : ''}`;
    Object.assign(el.style, { left: t.x + 'px', top: t.y + 'px', width: t.w + 'px', height: t.h + 'px' });
    let info = `<div class="tname">${esc(t.name)}</div>`;
    if (!editable && t.item_count > 0) info += `<div class="tamt">${esc(cur(t.amount))}</div>`;
    if (!editable && t.opened_at && t.status !== 'free') info += `<div class="tinfo">${esc(elapsed(t.opened_at))}</div>`;
    if (editable || t.status === 'free') info += `<div class="tinfo">${t.seats} seats</div>`;
    el.innerHTML = info;
    floor.appendChild(el);

    if (!editable) {
      el.addEventListener('click', () => onSelect?.(t));
      continue;
    }
    const handle = document.createElement('div');
    handle.className = 'resize';
    el.appendChild(handle);
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      onSelect?.(t);
      floor.querySelectorAll('.tbl.selected').forEach((x) => x.classList.remove('selected'));
      el.classList.add('selected');
      const resizing = e.target === handle;
      const start = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y, tw: t.w, th: t.h };
      el.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = (ev.clientX - start.x) / scale, dy = (ev.clientY - start.y) / scale;
        if (resizing) {
          t.w = Math.max(40, Math.min(hall.width - t.x, snap(start.tw + dx)));
          t.h = Math.max(40, Math.min(hall.height - t.y, snap(start.th + dy)));
          if (t.shape === 'round' || t.shape === 'square') t.h = t.w = Math.min(t.w, hall.height - t.y);
        } else {
          t.x = Math.max(0, Math.min(hall.width - t.w, snap(start.tx + dx)));
          t.y = Math.max(0, Math.min(hall.height - t.h, snap(start.ty + dy)));
        }
        Object.assign(el.style, { left: t.x + 'px', top: t.y + 'px', width: t.w + 'px', height: t.h + 'px' });
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        onChange?.(t);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }
  return { fit };
}

export function elapsed(ts) {
  const d = new Date(String(ts).replace(' ', 'T'));
  const mins = Math.max(0, Math.floor((Date.now() - d) / 60000));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
