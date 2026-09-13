const PharmacyInvoice = require('../models/pharmacyInvoiceModel');
const Medicine = require('../models/Medicine');
const PDFDocument = require('pdfkit');
const Prescription = require('../models/Prescription');

const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const createInvoiceAndHandleStock = async (req, res) => {
  const {
    prescription_id,
    patient_id,
    doctor_id,
    items,
    payment_mode = 'Cash'
  } = req.body;

  if (!patient_id) {
    return res.status(400).json({ success: false, message: 'patient_id is required.' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Invoice must contain at least one item.' });
  }

  const normalizedItems = items.map(item => ({
    medicine_id: item.medicine_id,
    name: item.name,
    quantity: Number(item.quantity),
    price: Number(item.price)
  }));

  if (normalizedItems.some(item => !item.medicine_id || !item.name || !Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.price) || item.price < 0)) {
    return res.status(400).json({ success: false, message: 'One or more invoice items are invalid.' });
  }

  try {
    const medicineIds = normalizedItems.map(item => item.medicine_id);
    const medicines = await Medicine.find({ _id: { $in: medicineIds }, isActive: true });
    const medicineMap = new Map(medicines.map(m => [String(m._id), m]));

    for (const item of normalizedItems) {
      const medicine = medicineMap.get(String(item.medicine_id));
      if (!medicine) {
        return res.status(400).json({ success: false, message: `Medicine ${item.name} is not available.` });
      }
      if (medicine.quantity < item.quantity) {
        return res.status(409).json({
          success: false,
          message: `Insufficient stock for ${medicine.medicineName}. Available: ${medicine.quantity}`
        });
      }
    }

    const serverTotal = roundMoney(normalizedItems.reduce((sum, item) => sum + item.quantity * item.price, 0));
    const decremented = [];

    try {
      for (const item of normalizedItems) {
        const result = await Medicine.updateOne(
          { _id: item.medicine_id, isActive: true, quantity: { $gte: item.quantity } },
          { $inc: { quantity: -item.quantity } }
        );
        if (result.modifiedCount !== 1) {
          throw new Error(`Stock changed while processing ${item.name}. Please retry.`);
        }
        decremented.push(item);
      }

      const createdInvoice = await PharmacyInvoice.create({
        prescription_id: prescription_id || undefined,
        patient_id,
        doctor_id: doctor_id || undefined,
        items: normalizedItems,
        total_amount: serverTotal,
        payment_mode,
        status: 'Paid',
        created_by: req.user.id
      });

      if (prescription_id) {
        await Prescription.findByIdAndUpdate(prescription_id, {
          pharmacyStatus: 'fully_dispensed',
          status: 'dispensed',
          dispensedBy: req.user.id,
          dispensedAt: new Date()
        });
      }

      return res.status(201).json(createdInvoice);
    } catch (writeError) {
      // Best-effort rollback for stock decrements when a later write fails.
      await Promise.allSettled(
        decremented.map(item => Medicine.updateOne(
          { _id: item.medicine_id },
          { $inc: { quantity: item.quantity } }
        ))
      );
      throw writeError;
    }
  } catch (error) {
    console.error('Pharmacy invoice error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Could not process invoice.' });
  }
};

const downloadInvoicePDF = async (req, res) => {
  try {
    const invoice = await PharmacyInvoice.findById(req.params.id)
      .populate('patient_id', 'name firstName lastName phone')
      .populate('doctor_id', 'name specialization');

    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }

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
    doc.font('Helvetica-Bold').fontSize(13)
      .text(`Total: INR ${invoice.total_amount.toFixed(2)}`, { align: 'right' });
    doc.end();
  } catch (error) {
    console.error('Invoice PDF error:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Could not generate PDF.' });
    } else {
      res.end();
    }
  }
};

const getAllPharmacyInvoices = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const filter = status ? { status } : {};
    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    const [invoices, total] = await Promise.all([
      PharmacyInvoice.find(filter)
        .populate('patient_id', 'name firstName lastName phone')
        .sort({ createdAt: -1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit),
      PharmacyInvoice.countDocuments(filter)
    ]);

    res.status(200).json({
      success: true,
      invoices,
      pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not fetch invoices.' });
  }
};

const getPharmacyInvoiceById = async (req, res) => {
  try {
    const invoice = await PharmacyInvoice.findById(req.params.id)
      .populate('patient_id')
      .populate('doctor_id', 'name specialization');

    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }
    res.status(200).json({ success: true, invoice });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not fetch invoice details.' });
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
      { $match: { status: 'Paid', createdAt: { $gte: startOfMonth, $lt: endOfMonth } } },
      { $group: { _id: null, totalRevenue: { $sum: '$total_amount' }, invoiceCount: { $sum: 1 } } }
    ]);

    res.status(200).json({
      success: true,
      totalRevenue: result[0]?.totalRevenue || 0,
      invoiceCount: result[0]?.invoiceCount || 0,
      year,
      month
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not calculate revenue.' });
  }
};

module.exports = {
  createInvoiceAndHandleStock,
  downloadInvoicePDF,
  getAllPharmacyInvoices,
  getPharmacyInvoiceById,
  getMonthlyRevenue
};
