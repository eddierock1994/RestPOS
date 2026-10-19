// Dependency-free SVG charts (keeps everything offline and light on an old PC).
import { esc } from './api.js';

export const PALETTE = ['#2563eb', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#dc2626', '#ca8a04', '#db2777', '#4f46e5', '#65a30d', '#0d9488', '#78716c'];

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

const compact = (v) => {
  const a = Math.abs(v);
  if (a >= 1e7) return (v / 1e7).toFixed(a >= 1e8 ? 0 : 1) + 'Cr';
  if (a >= 1e5) return (v / 1e5).toFixed(a >= 1e6 ? 0 : 1) + 'L';
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
  return String(Math.round(v * 100) / 100);
};

/** Vertical bar chart. data: [{label, value, title?}] */
export function barChart(data, { height = 240, width = 800, color = PALETTE[0], fmt = compact, showValues } = {}) {
  if (!data.length || data.every((d) => !d.value)) return `<div class="chart-empty">No sales in this period</div>`;
  const ml = 48, mr = 8, mt = 18, mb = 28;
  const w = width - ml - mr, h = height - mt - mb;
  const max = niceMax(Math.max(...data.map((d) => d.value)));
  const slot = w / data.length;
  const bw = Math.max(2, Math.min(56, slot * 0.7));
  const every = Math.ceil(data.length / 16);
  const values = showValues ?? data.length <= 14;
  let s = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img">`;
  for (let i = 0; i <= 4; i++) {
    const y = mt + h - (h * i) / 4;
    s += `<line x1="${ml}" x2="${width - mr}" y1="${y}" y2="${y}" class="grid"/><text x="${ml - 6}" y="${y + 4}" class="axis" text-anchor="end">${esc(compact((max * i) / 4))}</text>`;
  }
  data.forEach((d, i) => {
    const bh = (h * d.value) / max;
    const x = ml + slot * i + (slot - bw) / 2;
    const y = mt + h - bh;
    s += `<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(bh, d.value ? 1 : 0)}" rx="2" fill="${d.color || color}"><title>${esc(d.title || `${d.label}: ${fmt(d.value)}`)}</title></rect>`;
    if (values && d.value) s += `<text x="${x + bw / 2}" y="${y - 4}" class="val" text-anchor="middle">${esc(fmt(d.value))}</text>`;
    if (i % every === 0) s += `<text x="${x + bw / 2}" y="${height - 8}" class="axis" text-anchor="middle">${esc(d.label)}</text>`;
  });
  return s + '</svg>';
}

/** Donut chart with legend. data: [{label, value}] */
export function donutChart(data, { fmt = compact, centerLabel = 'Total', centerValue } = {}) {
  const total = data.reduce((a, d) => a + d.value, 0);
  if (!total) return `<div class="chart-empty">No sales in this period</div>`;
  const r = 70, C = 2 * Math.PI * r;
  let off = 0;
  let svg = `<svg class="donut" viewBox="0 0 200 200"><g transform="rotate(-90 100 100)">`;
  data.forEach((d, i) => {
    const len = (d.value / total) * C;
    svg += `<circle cx="100" cy="100" r="${r}" fill="none" stroke="${d.color || PALETTE[i % PALETTE.length]}" stroke-width="34"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}"><title>${esc(d.label)}: ${esc(fmt(d.value))} (${((d.value / total) * 100).toFixed(1)}%)</title></circle>`;
    off += len;
  });
  svg += `</g><text x="100" y="95" text-anchor="middle" class="donut-k">${esc(centerLabel)}</text>
    <text x="100" y="118" text-anchor="middle" class="donut-v">${esc(centerValue ?? fmt(total))}</text></svg>`;
  const legend = `<div class="legend-list">${data.map((d, i) => `<div><i style="background:${d.color || PALETTE[i % PALETTE.length]}"></i>
    <span class="grow">${esc(d.label)}</span><b>${((d.value / total) * 100).toFixed(1)}%</b></div>`).join('')}</div>`;
  return `<div class="donut-wrap">${svg}${legend}</div>`;
}

/** Horizontal bars as HTML rows. data: [{label, value, sub?}] */
export function hBars(data, { fmt = compact, color = PALETTE[0] } = {}) {
  if (!data.length) return `<div class="chart-empty">No data</div>`;
  const max = Math.max(...data.map((d) => d.value)) || 1;
  return `<div class="hbars">${data.map((d, i) => `<div class="hbar"><span class="hb-l" title="${esc(d.label)}">${esc(d.label)}</span>
    <span class="hb-track"><span style="width:${(d.value / max) * 100}%;background:${d.color || color}"></span></span>
    <span class="hb-v">${esc(fmt(d.value))}${d.sub ? `<small> ${esc(d.sub)}</small>` : ''}</span></div>`).join('')}</div>`;
}
