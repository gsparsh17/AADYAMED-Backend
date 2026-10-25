/**
 * Builds a lab report PDF from the results entered in the app, so a lab
 * without its own LIS can still release a proper report: lab letterhead,
 * patient block, one table per test with flags, and a sign-off line.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');

const PLUM = '#9B2FAE';
const INK = '#0F172A';
const MUTED = '#64748B';
const LINE = '#E2E8F0';
const FLAG_COLOUR = { high: '#C2410C', low: '#1D4ED8', critical: '#DC2626' };
const FLAG_LABEL = { high: 'H', low: 'L', critical: 'Critical' };

const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-IN', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—');

function ageText(patient) {
  if (patient?.age) return `${patient.age} y`;
  if (!patient?.dateOfBirth) return '';
  const dob = new Date(patient.dateOfBirth);
  const years = Math.floor((Date.now() - dob.getTime()) / (365.25 * 86400000));
  return years > 0 ? `${years} y` : '';
}

/**
 * Writes the report for [order] (populated patientId) from [lab] and
 * resolves to { path, size, originalName }.
 */
function generateLabReportPdf({ order, lab, patient, releasedBy }) {
  const dir = path.join(process.cwd(), 'uploads', 'lab-reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.pdf`);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const out = fs.createWriteStream(file);
    doc.pipe(out);
    const W = doc.page.width - 80;

    // ── Letterhead
    doc.rect(0, 0, doc.page.width, 6).fill(PLUM);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text(lab.labName || 'Diagnostic laboratory', 40, 26);
    const addr = [lab.address?.street, lab.address?.city, lab.address?.state, lab.address?.pincode].filter(Boolean).join(', ');
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
      .text([addr, lab.phone && `Phone ${lab.phone}`, lab.email].filter(Boolean).join('  ·  '), 40, 50, { width: W });
    const accreditation = (lab.accreditation || []).filter(Boolean).join(', ');
    if (accreditation || lab.registrationNumber) {
      doc.text([accreditation && `Accreditation: ${accreditation}`, lab.registrationNumber && `Reg. no. ${lab.registrationNumber}`].filter(Boolean).join('  ·  '), { width: W });
    }
    let y = doc.y + 10;
    doc.moveTo(40, y).lineTo(40 + W, y).strokeColor(LINE).lineWidth(1).stroke();

    // ── Patient block
    y += 10;
    const col = (label, value, x, yy) => {
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(label.toUpperCase(), x, yy);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(value || '—', x, yy + 10, { width: W / 3 - 8 });
    };
    const gender = patient?.gender ? String(patient.gender).replace(/^./, (c) => c.toUpperCase()) : '';
    col('Patient', patient?.name, 40, y);
    col('Age / sex', [ageText(patient), gender].filter(Boolean).join(' / '), 40 + W / 3, y);
    col('Report no.', order.labTestNumber, 40 + (2 * W) / 3, y);
    y += 32;
    col('Collected', fmtDate(order.collectedAt || order.sample?.collectionTime), 40, y);
    col('Reported', fmtDate(new Date()), 40 + W / 3, y);
    col('Sample', order.sample?.barcode ? `Barcode ${order.sample.barcode}` : (order.tests?.[0]?.sampleType || ''), 40 + (2 * W) / 3, y);
    y += 36;
    doc.moveTo(40, y).lineTo(40 + W, y).strokeColor(LINE).stroke();
    y += 14;

    // ── Tests
    const cols = { name: 40, value: 40 + W * 0.42, unit: 40 + W * 0.6, range: 40 + W * 0.74 };
    const ensure = (h) => {
      if (y + h > doc.page.height - 70) { doc.addPage(); y = 40; }
    };
    for (const test of (order.tests || []).filter((t) => t.status !== 'cancelled')) {
      const rows = (test.results || []).filter((r) => String(r.value || '').trim());
      if (!rows.length) continue;
      ensure(50);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(PLUM).text(test.testName || test.testCode, 40, y);
      y = doc.y + 4;
      doc.font('Helvetica').fontSize(8).fillColor(MUTED);
      doc.text('TEST', cols.name, y); doc.text('RESULT', cols.value, y); doc.text('UNIT', cols.unit, y); doc.text('REFERENCE RANGE', cols.range, y);
      y += 12;
      for (const r of rows) {
        ensure(18);
        const flag = r.flag && r.flag !== 'normal' ? r.flag : null;
        doc.font('Helvetica').fontSize(10).fillColor(INK).text(r.parameter, cols.name, y, { width: W * 0.4 });
        const rowH = Math.max(14, doc.heightOfString(r.parameter, { width: W * 0.4 }));
        doc.font(flag ? 'Helvetica-Bold' : 'Helvetica').fillColor(flag ? FLAG_COLOUR[flag] : INK)
          .text(`${r.value}${flag ? `  ${FLAG_LABEL[flag]}` : ''}`, cols.value, y, { width: W * 0.17 });
        doc.font('Helvetica').fillColor(MUTED).text(r.unit || '', cols.unit, y, { width: W * 0.13 });
        doc.text(r.normalRange || '', cols.range, y, { width: W * 0.26 });
        y += rowH + 4;
        doc.moveTo(40, y - 2).lineTo(40 + W, y - 2).strokeColor('#F1F5F9').stroke();
      }
      y += 12;
    }

    if (order.resultNotes) {
      ensure(40);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('Remarks', 40, y);
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(order.resultNotes, 40, doc.y + 2, { width: W });
      y = doc.y + 12;
    }

    // ── Footer on every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      // Writing below the bottom margin makes PDFKit add a page; lift it.
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const fy = doc.page.height - 50;
      doc.moveTo(40, fy).lineTo(40 + W, fy).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(8).fillColor(MUTED)
        .text(`Electronically verified${releasedBy ? ` by ${releasedBy}` : ''}. H = above range, L = below range. Results should be read with clinical findings.`, 40, fy + 6, { width: W - 70, height: 24 });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, 40 + W - 60, fy + 6, { width: 60, align: 'right', lineBreak: false });
      doc.page.margins.bottom = bottom;
    }

    doc.end();
    out.on('finish', () => resolve({ path: file, size: fs.statSync(file).size, originalName: `${order.labTestNumber || 'lab-report'}.pdf` }));
    out.on('error', reject);
  });
}

module.exports = { generateLabReportPdf };
