/**
 * Printable documents for an e-pharmacy order: the customer's tax invoice
 * (goes in the bag) and the packing slip (what the packer works from).
 *
 * pdfkit's built-in fonts have no ₹ glyph, so amounts are written "Rs." —
 * a blank box on a printed bill is worse than the abbreviation.
 */
const PDFDocument = require('pdfkit');

const money = (n) => `Rs. ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateText = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '-');

function render(build, title) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: title } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    build(doc);
    doc.end();
  });
}

function storeLines(store = {}) {
  const a = store.address || {};
  return [
    [a.street, a.city, a.state, a.pincode].filter(Boolean).join(', '),
    store.phone ? `Phone: ${store.phone}` : null,
    store.gstin ? `GSTIN: ${store.gstin}` : null,
    store.drugLicenseNumber || store.licenseNumber
      ? `Drug licence: ${store.drugLicenseNumber || store.licenseNumber}`
      : null,
  ].filter(Boolean);
}

function addressLines(order) {
  const d = order.deliveryAddress || {};
  return [
    d.contactName || order.patientId?.name,
    d.line1,
    d.line2,
    d.landmark ? `Near ${d.landmark}` : null,
    [d.city, d.state, d.pincode].filter(Boolean).join(', '),
    d.phone || order.patientId?.phone ? `Phone: ${d.phone || order.patientId?.phone}` : null,
  ].filter(Boolean);
}

/** Draws one table row; returns the y below it. */
function row(doc, y, cols, values, { bold = false, size = 9 } = {}) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
  let height = 0;
  cols.forEach((c, i) => {
    const h = doc.heightOfString(String(values[i] ?? ''), { width: c.w - 4 });
    height = Math.max(height, h);
  });
  cols.forEach((c, i) => {
    doc.text(String(values[i] ?? ''), c.x + 2, y, { width: c.w - 4, align: c.align || 'left' });
  });
  return y + height + 6;
}

function rule(doc, y, color = '#CCCCCC') {
  doc.save().moveTo(40, y).lineTo(555, y).strokeColor(color).lineWidth(0.7).stroke().restore();
}

/** Tax invoice for the customer. */
function generateOrderInvoicePdf(order, store) {
  return render((doc) => {
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#000').text(store?.name || 'Pharmacy');
    doc.font('Helvetica').fontSize(9).fillColor('#444');
    storeLines(store).forEach((l) => doc.text(l));

    doc.font('Helvetica-Bold').fontSize(13).fillColor('#000').text('TAX INVOICE', 40, 40, { align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor('#444')
      .text(`Invoice no: ${order.orderNumber}`, { align: 'right' })
      .text(`Date: ${dateText(order.createdAt)}`, { align: 'right' })
      .text(`Payment: ${order.paymentMethod === 'cod' ? 'Cash on delivery' : 'Online'} (${order.paymentStatus})`, { align: 'right' });

    doc.moveDown(2);
    let y = Math.max(doc.y, 130);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text('Bill to', 40, y);
    doc.font('Helvetica').fontSize(9).fillColor('#222');
    addressLines(order).forEach((l) => doc.text(l, 40));
    y = doc.y + 14;

    const cols = [
      { x: 40, w: 22 },
      { x: 62, w: 170 },
      { x: 232, w: 50 },
      { x: 282, w: 34, align: 'right' },
      { x: 316, w: 56, align: 'right' },
      { x: 372, w: 50, align: 'right' },
      { x: 422, w: 60, align: 'right' },
      { x: 482, w: 30, align: 'right' },
      { x: 512, w: 43, align: 'right' },
    ];
    rule(doc, y - 4, '#000');
    y = row(doc, y, cols, ['#', 'Item', 'HSN', 'Qty', 'Rate', 'Disc.', 'Taxable', 'GST%', 'Amount'], { bold: true, size: 8.5 });
    rule(doc, y - 3);

    const items = (order.items || []).filter((i) => Number(i.quantity) > 0);
    items.forEach((item, i) => {
      if (y > 740) { doc.addPage(); y = 50; }
      const name = [item.medicineName, item.genericName ? `(${item.genericName})` : null].filter(Boolean).join(' ');
      y = row(doc, y, cols, [
        i + 1,
        name,
        item.hsnCode || '-',
        item.quantity,
        Number(item.unitPrice || 0).toFixed(2),
        Number(item.medicineDiscount || 0).toFixed(2),
        Number(item.taxableAmount ?? item.totalAmount ?? 0).toFixed(2),
        item.taxRate != null ? `${item.taxRate}` : '-',
        Number(item.totalAmount || 0).toFixed(2),
      ]);
    });
    rule(doc, y - 2, '#000');

    const totals = [
      ['Subtotal', money(order.subtotal)],
      ...(order.medicineDiscount ? [['Medicine discount', `- ${money(order.medicineDiscount)}`]] : []),
      ...(order.couponDiscount ? [[`Coupon${order.couponCode ? ` (${order.couponCode})` : ''}`, `- ${money(order.couponDiscount)}`]] : []),
      ...(order.tax ? [['GST', money(order.tax)]] : []),
      ['Delivery', order.deliveryFee ? money(order.deliveryFee) : 'Free'],
    ];
    y += 6;
    doc.font('Helvetica').fontSize(9.5).fillColor('#222');
    totals.forEach(([k, v]) => {
      doc.text(k, 340, y, { width: 120 });
      doc.text(v, 460, y, { width: 95, align: 'right' });
      y += 15;
    });
    rule(doc, y);
    y += 6;
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#000');
    doc.text('Total', 340, y, { width: 120 });
    doc.text(money(order.totalAmount), 430, y, { width: 125, align: 'right' });
    y += 24;
    if (order.refundAmount) {
      doc.font('Helvetica').fontSize(9).fillColor('#444').text(`Refunded: ${money(order.refundAmount)}`, 340, y, { width: 215, align: 'right' });
      y += 14;
    }

    doc.font('Helvetica').fontSize(8).fillColor('#666').text(
      'Medicines once sold are returnable only as per the store policy and applicable law. '
        + 'Prescription medicines were dispensed against a valid prescription. '
        + 'This is a computer-generated invoice and needs no signature.',
      40, Math.max(y + 20, 700), { width: 515 },
    );
  }, `Invoice ${order.orderNumber}`);
}

/** What the packer works from: big order number, address, tick boxes. */
function generatePackingSlipPdf(order, store) {
  return render((doc) => {
    doc.font('Helvetica').fontSize(9).fillColor('#444').text(store?.name || 'Pharmacy');
    doc.font('Helvetica-Bold').fontSize(26).fillColor('#000').text(order.orderNumber);
    doc.font('Helvetica').fontSize(10).fillColor('#444').text(`Placed ${dateText(order.createdAt)}`);

    const cod = order.paymentMethod === 'cod' && order.paymentStatus !== 'paid';
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(14).fillColor(cod ? '#B45309' : '#047857')
      .text(cod ? `COLLECT ${money(order.totalAmount)} ON DELIVERY` : 'PAID — DO NOT COLLECT');

    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text('Deliver to');
    doc.font('Helvetica').fontSize(12).fillColor('#111');
    addressLines(order).forEach((l) => doc.text(l));
    if (order.deliveryInstructions) {
      doc.moveDown(0.4).font('Helvetica-Oblique').fontSize(10).fillColor('#444').text(`Note: ${order.deliveryInstructions}`);
    }

    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text('Items to pack');
    let y = doc.y + 6;
    rule(doc, y - 2, '#000');
    const items = (order.items || []).filter((i) => Number(i.quantity) > 0);
    items.forEach((item) => {
      if (y > 760) { doc.addPage(); y = 50; }
      doc.save().rect(42, y + 1, 11, 11).strokeColor('#000').lineWidth(1).stroke().restore();
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#000')
        .text(`${item.quantity} x  ${item.medicineName || 'Item'}`, 62, y, { width: 400 });
      const meta = [item.genericName, item.unit, item.prescriptionRequired ? 'Rx — check prescription' : null].filter(Boolean).join('  ·  ');
      let h = doc.heightOfString(`${item.quantity} x  ${item.medicineName || 'Item'}`, { width: 400 });
      if (meta) {
        doc.font('Helvetica').fontSize(9).fillColor(item.prescriptionRequired ? '#B45309' : '#555').text(meta, 62, y + h + 1, { width: 400 });
        h += 12;
      }
      if (item.orderedQuantity && item.orderedQuantity > item.quantity) {
        doc.font('Helvetica').fontSize(9).fillColor('#B45309').text(`Short supplied: ${item.quantity} of ${item.orderedQuantity}`, 62, y + h + 1);
        h += 12;
      }
      y += h + 10;
      rule(doc, y - 4);
    });

    doc.font('Helvetica').fontSize(10).fillColor('#000')
      .text(`${items.length} line${items.length === 1 ? '' : 's'} · ${items.reduce((s, i) => s + Number(i.quantity || 0), 0)} units`, 40, y + 6);
    doc.moveDown(2).fontSize(10).text('Packed by: ____________________        Checked by: ____________________');
  }, `Packing slip ${order.orderNumber}`);
}

module.exports = { generateOrderInvoicePdf, generatePackingSlipPdf };
