// Receipt rendering for browser printing + routing to server-side ESC/POS printing.
import { api, esc, money, qtyFmt, state, toast, toastErr } from './api.js';

function fmtDate(ts) {
  const d = ts ? new Date(String(ts).replace(' ', 'T')) : new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${z(d.getDate())}-${z(d.getMonth() + 1)}-${d.getFullYear()} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

export function receiptHtml(order, s, { duplicate = false } = {}) {
  const t = order.totals;
  const width = Number(s.paperWidth) === 58 ? 48 : 72; // printable mm
  const row = (k, v, cls = '') => `<tr class="${cls}"><td colspan="3">${esc(k)}</td><td class="r">${esc(v)}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 0; }
    * { box-sizing: border-box; }
    body { width: ${width}mm; margin: 0 auto; padding: 2mm 0 6mm; font-family: "Courier New", monospace; font-size: ${width < 60 ? 11 : 12}px; color: #000; }
    .c { text-align: center; } .r { text-align: right; } .b { font-weight: bold; }
    h1 { font-size: ${width < 60 ? 16 : 19}px; margin: 0 0 2px; text-align: center; }
    hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }
    table { width: 100%; border-collapse: collapse; } td, th { padding: 1px 0; vertical-align: top; }
    th { text-align: left; border-bottom: 1px dashed #000; } th.r { text-align: right; }
    .grand td { font-size: ${width < 60 ? 14 : 16}px; font-weight: bold; border-top: 1px dashed #000; border-bottom: 1px dashed #000; padding: 3px 0; }
  </style></head><body>
    <h1>${esc(s.restaurantName)}</h1>
    <div class="c">${[s.addressLine1, s.addressLine2].filter(Boolean).map(esc).join('<br>')}</div>
    ${s.phone ? `<div class="c">Ph: ${esc(s.phone)}</div>` : ''}
    ${s.gstin ? `<div class="c">GSTIN: ${esc(s.gstin)}</div>` : ''}
    ${s.fssai ? `<div class="c">FSSAI: ${esc(s.fssai)}</div>` : ''}
    ${duplicate ? '<div class="c b">DUPLICATE</div>' : ''}
    <hr>
    <table><tr><td>Bill: <b>${esc(order.bill_no || '-')}</b></td><td class="r">${fmtDate(order.closed_at || order.billed_at)}</td></tr>
    <tr><td>Table: <b>${esc(order.table_name)}</b></td><td class="r">${esc(order.hall_name)}</td></tr></table>
    <hr>
    <table>
      <tr><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amt</th></tr>
      ${order.items.map((it) => `<tr><td>${esc(it.name)}</td><td class="r">${qtyFmt(it.qty)}</td><td class="r">${money(it.price)}</td><td class="r">${money(it.price * it.qty)}</td></tr>`).join('')}
    </table>
    <hr>
    <table>
      ${row('Subtotal', money(t.subtotal))}
      ${t.discount > 0 ? row(`Discount (${t.discountPct}%)`, '-' + money(t.discount)) : ''}
      ${t.discount > 0 || s.pricesIncludeTax ? row('Taxable value', money(t.taxable)) : ''}
      ${t.cgstPct ? row(`CGST @ ${t.cgstPct}%`, money(t.cgst)) : ''}
      ${t.sgstPct ? row(`SGST @ ${t.sgstPct}%`, money(t.sgst)) : ''}
      ${t.roundOff ? row('Round off', money(t.roundOff)) : ''}
      ${row('TOTAL', `${s.currencySymbol || ''} ${money(t.total)}`, 'grand')}
    </table>
    ${order.payment_mode ? `<div>Paid by: ${esc(order.payment_mode)}</div>` : ''}
    ${s.billFooter ? `<p class="c">${esc(s.billFooter)}</p>` : ''}
  </body></html>`;
}

function browserPrint(html) {
  return new Promise((resolve) => {
    const frame = document.getElementById('printFrame');
    frame.onload = () => {
      setTimeout(() => { frame.contentWindow.focus(); frame.contentWindow.print(); resolve(); }, 50);
    };
    frame.srcdoc = html;
  });
}

/** Prints arbitrary HTML through the browser (silent with --kiosk-printing). */
export const printHtml = browserPrint;

/** Prints an order/bill using the configured printer mode. Returns true on success. */
export async function printOrder(order, opts = {}) {
  const s = state.settings;
  try {
    if (s.printerMode === 'browser') {
      const copies = Math.max(1, Number(s.printCopies) || 1);
      for (let i = 0; i < copies; i++) await browserPrint(receiptHtml(order, s, opts));
    } else {
      await api('POST', `/api/print/order/${order.id}`, { duplicate: !!opts.duplicate });
      toast('Sent to printer', 'ok');
    }
    return true;
  } catch (e) {
    toastErr(e);
    return false;
  }
}

export async function printTest() {
  const s = state.settings;
  if (s.printerMode === 'browser') {
    const fake = {
      bill_no: 'TEST', table_name: 'T0', hall_name: 'Test', billed_at: null,
      items: [{ name: 'Sample item', qty: 2, price: 100 }],
      totals: { subtotal: 200, discount: 0, discountPct: 0, taxable: 200, cgstPct: s.cgstPercent, sgstPct: s.sgstPercent,
        cgst: (200 * s.cgstPercent) / 100, sgst: (200 * s.sgstPercent) / 100, roundOff: 0, total: 200 * (1 + (s.cgstPercent + s.sgstPercent) / 100) },
    };
    await browserPrint(receiptHtml(fake, s));
  } else {
    await api('POST', '/api/print/test');
    toast('Test page sent', 'ok');
  }
}
