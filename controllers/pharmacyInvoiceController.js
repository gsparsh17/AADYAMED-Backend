const PharmacyInvoice = require('../models/pharmacyInvoiceModel');
const Medicine = require('../models/Medicine');
const PDFDocument = require('pdfkit');
const Prescription = require('../models/Prescription');
const { scopedFilter, scopedPayload } = require('../utils/tenantScope');
const { scopeFromRequest, consumeFefo, addToBatch } = require('../services/inventory.service');

const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const createInvoiceAndHandleStock = async (req, res) => {
  const { prescription_id, patient_id, doctor_id, items, payment_mode = 'Cash' } = req.body;
  if (!patient_id) return res.status(400).json({ success: false, message: 'patient_id is required.' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ success: false, message: 'Invoice must contain at least one item.' });
  const requested = items.map(item => ({ medicineId: item.medicine_id || item.medicineId, quantity: Number(item.quantity) }));
  if (requested.some(item => !item.medicineId || !Number.isFinite(item.quantity) || item.quantity <= 0)) return res.status(400).json({ success: false, message: 'One or more invoice items are invalid.' });

  const completed = [];
  let createdInvoice = null;
  try {
    let prescription = null;
    if (prescription_id) {
      prescription = await Prescription.findById(prescription_id);
      if (!prescription || !['issued', 'superseded'].includes(prescription.status)) return res.status(400).json({ success: false, message: 'An issued prescription is required.' });
      if (prescription.expiresAt && new Date(prescription.expiresAt) < new Date()) return res.status(400).json({ success: false, message: 'Prescription has expired.' });
      if (prescription.patientId && String(prescription.patientId) !== String(patient_id)) return res.status(400).json({ success: false, message: 'Prescription does not belong to this patient.' });
    }

    const medicineIds = requested.map(item => item.medicineId);
    const medicines = await Medicine.find(scopedFilter(req, { _id: { $in: medicineIds }, isActive: true }));
    const medicineMap = new Map(medicines.map(m => [String(m._id), m]));
    const serverItems = [];
    const norm = value => String(value || '').trim().toLowerCase();
    for (const item of requested) {
      const medicine = medicineMap.get(String(item.medicineId));
      if (!medicine) return res.status(400).json({ success: false, message: `Medicine ${item.medicineId} is not available in the selected store.` });
      if (medicine.prescriptionRequired) {
        if (!prescription) return res.status(400).json({ success: false, message: `Prescription required for ${medicine.medicineName}.` });
        const names = new Set([norm(medicine.medicineName), norm(medicine.genericName)].filter(Boolean));
        const prescribed = (prescription.medicines || []).some(rx => names.has(norm(rx.medicineName)) || names.has(norm(rx.genericName)));
        if (!prescribed) return res.status(400).json({ success: false, message: `${medicine.medicineName} is not on the selected prescription.` });
      }
      serverItems.push({ medicine, quantity: item.quantity, name: medicine.medicineName, price: Number(medicine.sellingPrice || 0) });
    }

    const scope = scopeFromRequest(req);
    for (const item of serverItems) {
      const stock = await consumeFefo({ scope, medicineId: item.medicine._id, quantity: item.quantity, actorId: req.user.id, reason: 'Legacy pharmacy invoice', referenceType: 'sale', referenceId: prescription_id || undefined });
      completed.push({ ...item, allocations: stock.allocations });
    }

    const invoiceItems = serverItems.map(item => ({ medicine_id: item.medicine._id, name: item.name, quantity: item.quantity, price: item.price }));
    const serverTotal = roundMoney(invoiceItems.reduce((sum, item) => sum + item.quantity * item.price, 0));
    createdInvoice = await PharmacyInvoice.create(scopedPayload(req, { prescription_id: prescription_id || undefined, patient_id, doctor_id: doctor_id || undefined, items: invoiceItems, total_amount: serverTotal, payment_mode, status: 'Paid', created_by: req.user.id }));

    if (prescription) {
      const dispensed = completed.map(item => ({ medicineId: item.medicine._id, medicineName: item.medicine.medicineName, genericName: item.medicine.genericName, batchId: item.allocations[0]?.batchId, quantity: item.quantity, unit: item.medicine.unit, dispensedAt: new Date(), dispensedBy: req.user.id }));
      prescription.dispensedItems = (prescription.dispensedItems || []).concat(dispensed);
      const fulfilled = (prescription.medicines || []).every(rx => {
        const wanted = Math.max(1, Number(rx.prescribedQuantity ?? rx.quantity ?? 1) || 1);
        const names = new Set([norm(rx.medicineName), norm(rx.genericName)].filter(Boolean));
        const supplied = (prescription.dispensedItems || []).reduce((sum, entry) => names.has(norm(entry.medicineName)) || names.has(norm(entry.genericName)) ? sum + Number(entry.quantity || 0) : sum, 0);
        return names.size > 0 && supplied >= wanted;
      });
      prescription.pharmacyStatus = fulfilled && (prescription.medicines || []).length ? 'fully_dispensed' : 'partially_dispensed';
      prescription.dispensedBy = req.user.id;
      prescription.dispensedAt = new Date();
      await prescription.save();
    }
    return res.status(201).json(createdInvoice);
  } catch (error) {
    const scope = req.tenant ? scopeFromRequest(req) : null;
    if (scope) {
      for (const item of completed.reverse()) {
        for (const allocation of item.allocations || []) {
          try { await addToBatch({ scope, medicineId: item.medicine._id, batchId: allocation.batchId, quantity: allocation.quantity, actorId: req.user.id, adjustmentType: 'addition', reason: 'Rollback legacy pharmacy invoice', referenceType: 'sale', referenceId: prescription_id || undefined }); }
          catch (rollbackError) { console.error('Legacy invoice stock rollback failed:', rollbackError); }
        }
      }
    }
    if (createdInvoice?._id) { try { await PharmacyInvoice.deleteOne({ _id: createdInvoice._id }); } catch (cleanupError) { console.error('Legacy invoice cleanup failed:', cleanupError); } }
    console.error('Pharmacy invoice error:', error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Could not process invoice.' });
  }
};

const downloadInvoicePDF = async (req, res) => {
  try {
    const invoice = await PharmacyInvoice.findOne(scopedFilter(req, { _id: req.params.id }))
      .populate('patient_id', 'name firstName lastName phone')
      .populate('doctor_id', 'name specialization');
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found in the selected store.' });

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=pharmacy-invoice-${invoice._id}.pdf`);
    doc.pipe(res);

    const patientName = invoice.patient_id?.name || [invoice.patient_id?.firstName, invoice.patient_id?.lastName].filter(Boolean).join(' ') || 'Patient';
    doc.fontSize(20).font('Helvetica-Bold').text('Pharmacy Invoice', { align: 'center' });
    doc.moveDown();
    doc.fontSize(11).font('Helvetica');
    doc.text(`Invoice ID: ${invoice._id}`);
    doc.text(`Patient: ${patientName}`);
    doc.text(`Date: ${new Date(invoice.createdAt).toLocaleDateString('en-IN')}`);
    doc.text(`Payment: ${invoice.payment_mode}`);
    doc.moveDown(2);
    doc.font('Helvetica-Bold');
    doc.text('Medicine', 50);
    doc.text('Qty', 300, doc.y - 14, { width: 60, align: 'right' });
    doc.text('Price', 380, doc.y - 14, { width: 80, align: 'right' });
    doc.text('Amount', 470, doc.y - 14, { width: 80, align: 'right' });
    doc.moveDown();
    doc.font('Helvetica');
    invoice.items.forEach(item => {
      const y = doc.y;
      doc.text(item.name, 50, y, { width: 230 });
      doc.text(String(item.quantity), 300, y, { width: 60, align: 'right' });
      doc.text(`INR ${item.price.toFixed(2)}`, 380, y, { width: 80, align: 'right' });
      doc.text(`INR ${(item.quantity * item.price).toFixed(2)}`, 470, y, { width: 80, align: 'right' });
      doc.moveDown();
    });
    doc.moveDown();
    doc.font('Helvetica-Bold').fontSize(13).text(`Total: INR ${invoice.total_amount.toFixed(2)}`, { align: 'right' });
    doc.end();
  } catch (error) {
    console.error('Invoice PDF error:', error);
    if (!res.headersSent) res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Could not generate PDF.' });
    else res.end();
  }
};

const getAllPharmacyInvoices = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const filter = scopedFilter(req, status ? { status } : {});
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const [invoices, total] = await Promise.all([
      PharmacyInvoice.find(filter).populate('patient_id', 'name firstName lastName phone').sort({ createdAt: -1 }).skip((safePage - 1) * safeLimit).limit(safeLimit),
      PharmacyInvoice.countDocuments(filter)
    ]);
    res.status(200).json({ success: true, invoices, pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) } });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Could not fetch invoices.' });
  }
};

const getPharmacyInvoiceById = async (req, res) => {
  try {
    const invoice = await PharmacyInvoice.findOne(scopedFilter(req, { _id: req.params.id }))
      .populate('patient_id')
      .populate('doctor_id', 'name specialization');
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found in the selected store.' });
    res.status(200).json({ success: true, invoice });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Could not fetch invoice details.' });
  }
};

const getMonthlyRevenue = async (req, res) => {
  try {
    const now = new Date();
    const year = Number(req.query.year) || now.getFullYear();
    const month = Number(req.query.month) || now.getMonth() + 1;
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 1);
    const result = await PharmacyInvoice.aggregate([
      { $match: scopedFilter(req, { status: 'Paid', createdAt: { $gte: startOfMonth, $lt: endOfMonth } }) },
      { $group: { _id: null, totalRevenue: { $sum: '$total_amount' }, invoiceCount: { $sum: 1 } } }
    ]);
    res.status(200).json({ success: true, totalRevenue: result[0]?.totalRevenue || 0, invoiceCount: result[0]?.invoiceCount || 0, year, month });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Could not calculate revenue.' });
  }
};

module.exports = { createInvoiceAndHandleStock, downloadInvoicePDF, getAllPharmacyInvoices, getPharmacyInvoiceById, getMonthlyRevenue };
