'use strict';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Computes bill totals. When pricesIncludeTax is true, menu prices are treated as
 * GST-inclusive and taxes are back-calculated from the (discounted) amount.
 */
function computeTotals(items, { discountPct = 0, cgstPercent = 0, sgstPercent = 0, pricesIncludeTax = false, roundOff = true } = {}) {
  const subtotal = r2(items.reduce((s, it) => s + Number(it.price) * Number(it.qty), 0));
  const discPct = Math.min(Math.max(Number(discountPct) || 0, 0), 100);
  const discount = r2((subtotal * discPct) / 100);
  const afterDiscount = r2(subtotal - discount);
  const cg = Number(cgstPercent) || 0;
  const sg = Number(sgstPercent) || 0;

  let taxable, cgst, sgst;
  if (pricesIncludeTax) {
    taxable = r2(afterDiscount / (1 + (cg + sg) / 100));
    cgst = r2((taxable * cg) / 100);
    sgst = r2(afterDiscount - taxable - cgst);
  } else {
    taxable = afterDiscount;
    cgst = r2((taxable * cg) / 100);
    sgst = r2((taxable * sg) / 100);
  }
  const gross = r2(taxable + cgst + sgst);
  const total = roundOff ? Math.round(gross) : gross;
  return {
    subtotal,
    discountPct: discPct,
    discount,
    taxable,
    cgstPct: cg,
    sgstPct: sg,
    cgst,
    sgst,
    roundOff: r2(total - gross),
    total: r2(total),
  };
}

module.exports = { computeTotals, r2 };
