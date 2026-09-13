const PDFDocument = require('pdfkit');

function listText(value) {
  if (!Array.isArray(value)) return '';
  return value.filter(Boolean).join(', ');
}

function writeSection(doc, title, body) {
  if (!body) return;
  doc.moveDown(0.5).font('Helvetica-Bold').fontSize(11).text(title);
  doc.font('Helvetica').fontSize(10).text(body, { lineGap: 2 });
}

function generatePrescriptionPdf(prescription) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Prescription ${prescription.prescriptionNumber}` } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const professional = prescription.doctorId || prescription.physioId || {};
    const patient = prescription.patientId || {};

    doc.font('Helvetica-Bold').fontSize(20).text('AADYAMED', { align: 'center' });
    doc.fontSize(12).text('Electronic Prescription', { align: 'center' });
    doc.moveDown();
    doc.font('Helvetica').fontSize(10);
    doc.text(`Prescription: ${prescription.prescriptionNumber || '-'}`);
    doc.text(`Issued: ${prescription.issuedAt ? new Date(prescription.issuedAt).toLocaleString('en-IN') : '-'}`);
    doc.text(`Valid until: ${prescription.expiresAt ? new Date(prescription.expiresAt).toLocaleDateString('en-IN') : '-'}`);
    doc.moveDown();

    doc.font('Helvetica-Bold').text(`${prescription.professionalType === 'doctor' ? 'Doctor' : 'Physiotherapist'}: ${professional.name || '-'}`);
    if (professional.specialization) doc.font('Helvetica').text(`Specialization: ${listText(professional.specialization) || professional.specialization}`);
    doc.font('Helvetica-Bold').text(`Patient: ${patient.name || '-'}`);
    doc.font('Helvetica').text(`Age/Gender: ${patient.age || '-'} / ${patient.gender || '-'}`);

    writeSection(doc, 'Symptoms', listText(prescription.symptoms));
    writeSection(doc, 'Diagnosis', listText(prescription.diagnosis));

    if (prescription.medicines?.length) {
      doc.moveDown(0.5).font('Helvetica-Bold').fontSize(11).text('Medicines');
      prescription.medicines.forEach((medicine, index) => {
        const line = `${index + 1}. ${medicine.medicineName || '-'}${medicine.dosage ? ` — ${medicine.dosage}` : ''}${medicine.frequency ? `, ${medicine.frequency}` : ''}${medicine.duration ? ` for ${medicine.duration}` : ''}`;
        doc.font('Helvetica-Bold').fontSize(10).text(line);
        if (medicine.instructions) doc.font('Helvetica').fontSize(9).text(`   Instructions: ${medicine.instructions}`);
      });
    }

    if (prescription.labTests?.length) {
      writeSection(doc, 'Investigations / Lab Tests', prescription.labTests.map((test) => test.testName).filter(Boolean).join(', '));
    }
    if (prescription.advice?.length) {
      writeSection(doc, 'Advice', prescription.advice.map((item) => item.advice).filter(Boolean).join('\n'));
    }
    writeSection(doc, 'Patient Instructions', prescription.patientInstructions);
    if (prescription.followUpDate) {
      writeSection(doc, 'Follow-up', `${new Date(prescription.followUpDate).toLocaleDateString('en-IN')}${prescription.followUpInstructions ? ` — ${prescription.followUpInstructions}` : ''}`);
    }
    writeSection(doc, 'Clinical Notes', prescription.notes);

    doc.moveDown(1.5).font('Helvetica').fontSize(9).fillColor('#555555')
      .text('This electronic prescription was generated through AADYAMED. Dispensing is subject to applicable pharmacy and prescription regulations.');
    doc.moveDown().fillColor('#000000').font('Helvetica-Bold').text(professional.name || 'Authorized clinician', { align: 'right' });
    doc.font('Helvetica').fontSize(9).text('Electronically issued', { align: 'right' });

    doc.end();
  });
}

module.exports = { generatePrescriptionPdf };
