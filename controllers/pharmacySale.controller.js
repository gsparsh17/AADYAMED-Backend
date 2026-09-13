const PDFDocument = require('pdfkit');
const PharmacySale = require('../models/PharmacySale');
const PharmacyReturn = require('../models/PharmacyReturn');
const Medicine = require('../models/Medicine');
const Prescription = require('../models/Prescription');
const PatientProfile = require('../models/PatientProfile');
const { scopedFilter, scopedPayload } = require('../utils/tenantScope');
const { scopeFromRequest, consumeFefo, addToBatch } = require('../services/inventory.service');

const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

exports.createSale = async (req, res) => {
  try {
    const customerType = req.body.customerType || req.body.customer_type || 'walkin';
    const patientId = req.body.patientId || req.body.patient_id;
    const prescriptionId = req.body.prescriptionId || req.body.prescription_id;
    const paymentMethod = String(req.body.paymentMethod || req.body.payment_method || 'cash').toLowerCase();
    const taxMode = req.body.taxMode === 'interstate' ? 'interstate' : 'intrastate';
    const requestedItems = (req.body.items || []).map(item => ({
      medicineId: item.medicineId || item.medicine_id,
      quantity: Number(item.quantity || 0),
    }));
    if (!requestedItems.length) return res.status(400).json({ success: false, message: 'At least one medicine is required' });

    let customerDetails = {};
    if (patientId) {
      const patient = await PatientProfile.findById(patientId);
      if (!patient) return res.status(404).json({ success: false, message: 'Patient not found' });
      customerDetails = {
        customerName: patient.name || [patient.firstName, patient.lastName].filter(Boolean).join(' '),
        customerPhone: patient.phone,
        customerEmail: patient.email,
        customerAddress: typeof patient.address === 'string' ? patient.address : patient.address?.street,
      };
    } else {
      customerDetails = {
        customerName: req.body.customerName || req.body.customer_name || 'Walk-in Customer',
        customerPhone: req.body.customerPhone || req.body.customer_phone,
        customerEmail: req.body.customerEmail || req.body.customer_email,
        customerAddress: req.body.customerAddress || req.body.customer_address,
      };
    }

    let prescriptionDetails = {};
    let prescription = null;
    if (prescriptionId) {
      prescription = await Prescription.findById(prescriptionId);
      if (!prescription || !['issued', 'superseded'].includes(prescription.status)) {
        return res.status(400).json({ success: false, message: 'An issued prescription is required' });
      }
      if (prescription.expiresAt && new Date(prescription.expiresAt) < new Date()) {
        return res.status(400).json({ success: false, message: 'Prescription has expired' });
      }
      if (prescription.pharmacyStatus === 'fully_dispensed') {
        return res.status(400).json({ success: false, message: 'Prescription already fully dispensed' });
      }
      if (patientId && prescription.patientId && String(prescription.patientId) !== String(patientId)) {
        return res.status(400).json({ success: false, message: 'Prescription does not belong to the selected patient' });
      }
      prescriptionDetails = {
        prescriptionRequired: true,
        prescriptionNumber: prescription.prescriptionNumber,
      };
    }

    let subtotal = 0;
    let tax = 0;
    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    const validatedItems = [];
    for (const item of requestedItems) {
      if (!item.medicineId || !Number.isFinite(item.quantity) || item.quantity <= 0) {
        return res.status(400).json({ success: false, message: 'Each sale item needs a valid medicine and positive quantity' });
      }
      const medicine = await Medicine.findOne(scopedFilter(req, { _id: item.medicineId, isActive: true }));
      if (!medicine) return res.status(400).json({ success: false, message: `Medicine ${item.medicineId} is not available in the selected store` });
      if (medicine.quantity < item.quantity) return res.status(409).json({ success: false, message: `Insufficient stock for ${medicine.medicineName}` });
      if (medicine.prescriptionRequired && !prescriptionId) {
        return res.status(400).json({ success: false, message: `Prescription required for ${medicine.medicineName}` });
      }
      if (medicine.prescriptionRequired && prescription) {
        const norm = value => String(value || '').trim().toLowerCase();
        const candidates = new Set([norm(medicine.medicineName), norm(medicine.genericName)].filter(Boolean));
        const prescribed = (prescription.medicines || []).some(rx => candidates.has(norm(rx.medicineName)) || candidates.has(norm(rx.genericName)));
        if (!prescribed) {
          return res.status(400).json({ success: false, message: `${medicine.medicineName} is not present on the selected prescription` });
        }
      }

      const listedGross = money(item.quantity * Number(medicine.sellingPrice || 0));
      const itemDiscount = money(listedGross * Math.min(Math.max(Number(medicine.discount || 0), 0), 100) / 100);
      const discountedPrice = money(listedGross - itemDiscount);
      const rate = Math.max(0, Number(medicine.taxRate || 0));
      const priceIncludesTax = medicine.priceIncludesTax !== false;
      const taxableAmount = rate > 0 && priceIncludesTax
        ? money(discountedPrice / (1 + rate / 100))
        : discountedPrice;
      const itemTax = rate > 0
        ? (priceIncludesTax ? money(discountedPrice - taxableAmount) : money(taxableAmount * rate / 100))
        : 0;
      const itemCgst = taxMode === 'intrastate' ? money(itemTax / 2) : 0;
      const itemSgst = taxMode === 'intrastate' ? money(itemTax - itemCgst) : 0;
      const itemIgst = taxMode === 'interstate' ? itemTax : 0;
      subtotal = money(subtotal + taxableAmount);
      tax = money(tax + itemTax);
      cgst = money(cgst + itemCgst);
      sgst = money(sgst + itemSgst);
      igst = money(igst + itemIgst);
      validatedItems.push({
        medicineId: medicine._id,
        medicineName: medicine.medicineName,
        genericName: medicine.genericName,
        quantity: item.quantity,
        unit: medicine.unit,
        sellingPrice: medicine.sellingPrice,
        discount: itemDiscount,
        taxRate: rate,
        priceIncludesTax,
        hsnCode: medicine.hsnCode,
        taxableAmount,
        taxAmount: itemTax,
        cgst: itemCgst,
        sgst: itemSgst,
        igst: itemIgst,
        totalAmount: money(taxableAmount + itemTax),
      });
    }

    const totalAmount = money(subtotal + tax);
    const paidAmount = req.body.paidAmount === undefined ? totalAmount : Math.min(totalAmount, Math.max(0, Number(req.body.paidAmount) || 0));
    const sale = await PharmacySale.create(scopedPayload(req, {
      customerType,
      patientId: patientId || undefined,
      prescriptionId: prescriptionId || undefined,
      ...customerDetails,
      ...prescriptionDetails,
      items: validatedItems,
      subtotal,
      tax,
      cgst,
      sgst,
      igst,
      taxMode,
      totalAmount,
      paidAmount,
      balanceAmount: money(totalAmount - paidAmount),
      paymentMethod,
      paymentReference: req.body.paymentReference || req.body.payment_reference,
      paymentStatus: paidAmount >= totalAmount ? 'paid' : paidAmount > 0 ? 'partial' : 'pending',
      status: 'draft',
      notes: req.body.notes,
      createdBy: req.user.id,
    }));
    res.status(201).json({ success: true, sale });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.dispenseSale = async (req, res) => {
  try {
    const sale = await PharmacySale.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found in the selected store' });
    if (sale.status !== 'draft') return res.status(400).json({ success: false, message: 'Only draft sales can be dispensed' });

    const scope = scopeFromRequest(req);
    const completed = [];
    let costOfGoods = 0;
    try {
      for (const item of sale.items) {
        const result = await consumeFefo({
          scope,
          medicineId: item.medicineId,
          quantity: item.quantity,
          actorId: req.user.id,
          reason: `Dispensed on sale ${sale.saleNumber}`,
          referenceType: 'sale',
          referenceId: sale._id,
        });
        item.batchAllocations = result.allocations.map(a => ({ batchId: a.batchId, quantity: a.quantity, purchasePrice: a.purchasePrice }));
        item.batchId = result.allocations[0]?.batchId;
        item.costAmount = money(result.allocations.reduce((sum, a) => sum + a.quantity * Number(a.purchasePrice || 0), 0));
        costOfGoods = money(costOfGoods + item.costAmount);
        completed.push({ item, allocations: result.allocations });
      }
    } catch (error) {
      // If a later medicine fails due to concurrent stock movement, restore earlier
      // FEFO allocations and record the rollback in the stock ledger.
      for (const done of completed.reverse()) {
        for (const allocation of done.allocations) {
          try {
            await addToBatch({
              scope,
              medicineId: done.item.medicineId,
              batchId: allocation.batchId,
              quantity: allocation.quantity,
              actorId: req.user.id,
              adjustmentType: 'addition',
              reason: `Rollback failed sale ${sale.saleNumber}`,
              referenceType: 'sale',
              referenceId: sale._id,
            });
          } catch (rollbackError) {
            console.error('Sale stock rollback failed:', rollbackError);
          }
        }
      }
      throw error;
    }

    sale.costOfGoods = costOfGoods;
    sale.grossProfit = money(sale.subtotal - costOfGoods);
    sale.status = 'dispensed';
    sale.invoiceNumber = sale.invoiceNumber || `INV-${sale.saleNumber}`;
    sale.dispensedBy = req.user.id;
    sale.dispensedAt = new Date();
    await sale.save();
    if (sale.prescriptionId) await updatePrescriptionDispense(sale);
    res.json({ success: true, sale });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.getAllSales = async (req, res) => {
  try {
    const { status, customerType, startDate, endDate, patientId, page = 1, limit = 20 } = req.query;
    const filter = scopedFilter(req);
    if (status) filter.status = status;
    if (customerType) filter.customerType = customerType;
    if (patientId) filter.patientId = patientId;
    if (startDate || endDate) {
      filter.saleDate = {};
      if (startDate) filter.saleDate.$gte = new Date(startDate);
      if (endDate) filter.saleDate.$lte = new Date(endDate);
    }
    const pageNumber = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(limit) || 20));
    const [sales, total] = await Promise.all([
      PharmacySale.find(filter).populate('patientId', 'name firstName lastName phone').populate('prescriptionId', 'prescriptionNumber').populate('createdBy', 'name email').sort({ saleDate: -1 }).skip((pageNumber - 1) * pageSize).limit(pageSize),
      PharmacySale.countDocuments(filter),
    ]);
    const [totals] = await PharmacySale.aggregate([
      { $match: filter },
      { $group: {
        _id: null,
        grossSales: { $sum: '$totalAmount' },
        returns: { $sum: { $ifNull: ['$returnedAmount', 0] } },
        totalTax: { $sum: { $subtract: ['$tax', { $ifNull: ['$returnedTax', 0] }] } },
        grossProfit: { $sum: '$grossProfit' },
        count: { $sum: 1 },
      } },
      { $addFields: { totalSales: { $subtract: ['$grossSales', '$returns'] } } },
    ]);
    res.json({ success: true, sales, totals: totals || { grossSales: 0, returns: 0, totalSales: 0, totalTax: 0, grossProfit: 0, count: 0 }, pagination: { page: pageNumber, limit: pageSize, total, pages: Math.ceil(total / pageSize) } });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.getSaleById = async (req, res) => {
  try {
    const sale = await PharmacySale.findOne(scopedFilter(req, { _id: req.params.id })).populate('patientId').populate('prescriptionId').populate('createdBy', 'name email').populate('dispensedBy', 'name email').populate('items.batchAllocations.batchId');
    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found in the selected store' });
    const returns = await PharmacyReturn.find(scopedFilter(req, { saleId: sale._id, status: 'completed' })).sort({ createdAt: -1 });
    res.json({ success: true, sale, returns });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.getTodaySalesStats = async (req, res) => {
  try {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    const [result] = await PharmacySale.aggregate([
      { $match: scopedFilter(req, { saleDate: { $gte: start, $lt: end }, status: { $in: ['dispensed', 'partially_returned', 'returned'] } }) },
      { $group: { _id: null, totalSales: { $sum: { $subtract: ['$totalAmount', { $ifNull: ['$returnedAmount', 0] }] } }, totalTransactions: { $sum: 1 }, totalItems: { $sum: { $sum: '$items.quantity' } }, grossProfit: { $sum: '$grossProfit' } } },
    ]);
    res.json({ totalSales: result?.totalSales || 0, totalTransactions: result?.totalTransactions || 0, totalItems: result?.totalItems || 0, grossProfit: result?.grossProfit || 0 });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.getSalesReport = async (req, res) => {
  try {
    const { groupBy = 'day', startDate, endDate } = req.query;
    const match = scopedFilter(req, { status: { $in: ['dispensed', 'partially_returned', 'returned'] } });
    if (startDate || endDate) {
      match.saleDate = {};
      if (startDate) match.saleDate.$gte = new Date(startDate);
      if (endDate) match.saleDate.$lte = new Date(endDate);
    }
    if (groupBy === 'medicine') {
      const report = await PharmacySale.aggregate([
        { $match: match }, { $unwind: '$items' },
        { $addFields: {
          'items.netQuantity': { $subtract: ['$items.quantity', { $ifNull: ['$items.returnedQuantity', 0] }] },
          'items.netAmount': { $cond: [{ $gt: ['$items.quantity', 0] }, { $multiply: ['$items.totalAmount', { $divide: [{ $subtract: ['$items.quantity', { $ifNull: ['$items.returnedQuantity', 0] }] }, '$items.quantity'] }] }, 0] },
          'items.netCost': { $cond: [{ $gt: ['$items.quantity', 0] }, { $multiply: ['$items.costAmount', { $divide: [{ $subtract: ['$items.quantity', { $ifNull: ['$items.returnedQuantity', 0] }] }, '$items.quantity'] }] }, 0] },
        } },
        { $group: { _id: '$items.medicineId', medicineName: { $first: '$items.medicineName' }, totalQuantity: { $sum: '$items.netQuantity' }, totalAmount: { $sum: '$items.netAmount' }, costAmount: { $sum: '$items.netCost' } } },
        { $addFields: { grossProfit: { $subtract: ['$totalAmount', '$costAmount'] } } },
        { $sort: { totalAmount: -1 } }, { $limit: 100 },
      ]);
      return res.json({ success: true, report });
    }
    const format = groupBy === 'month' ? '%Y-%m' : '%Y-%m-%d';
    const report = await PharmacySale.aggregate([
      { $match: match },
      { $group: { _id: { $dateToString: { format, date: '$saleDate' } }, grossSales: { $sum: '$totalAmount' }, returns: { $sum: { $ifNull: ['$returnedAmount', 0] } }, tax: { $sum: { $subtract: ['$tax', { $ifNull: ['$returnedTax', 0] }] } }, costOfGoods: { $sum: '$costOfGoods' }, grossProfit: { $sum: '$grossProfit' }, transactions: { $sum: 1 } } },
      { $addFields: { netSales: { $subtract: ['$grossSales', '$returns'] } } },
      { $sort: { _id: 1 } },
    ]);
    res.json({ success: true, report });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.downloadSaleInvoice = async (req, res) => {
  try {
    const sale = await PharmacySale.findOne(scopedFilter(req, { _id: req.params.id })).populate('patientId', 'name firstName lastName phone');
    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });
    if (!['dispensed', 'partially_returned', 'returned'].includes(sale.status)) return res.status(400).json({ success: false, message: 'Invoice is available after dispensing' });
    const store = req.tenant.store;
    const doc = new PDFDocument({ margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${sale.invoiceNumber || sale.saleNumber}.pdf`);
    doc.pipe(res);
    doc.fontSize(18).font('Helvetica-Bold').text(store?.name || 'Pharmacy', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text([store?.address?.street, store?.address?.city, store?.address?.state, store?.address?.pincode].filter(Boolean).join(', '), { align: 'center' });
    if (store?.gstin) doc.text(`GSTIN: ${store.gstin}`, { align: 'center' });
    if (store?.drugLicenseNumber || store?.licenseNumber) doc.text(`Drug License: ${store.drugLicenseNumber || store.licenseNumber}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).font('Helvetica-Bold').text('TAX INVOICE');
    doc.fontSize(10).font('Helvetica');
    doc.text(`Invoice: ${sale.invoiceNumber || sale.saleNumber}`);
    doc.text(`Date: ${new Date(sale.dispensedAt || sale.saleDate).toLocaleString('en-IN')}`);
    doc.text(`Customer: ${sale.customerName || 'Walk-in Customer'}${sale.customerPhone ? ` | ${sale.customerPhone}` : ''}`);
    doc.moveDown();
    sale.items.forEach(item => {
      doc.font('Helvetica-Bold').text(item.medicineName);
      doc.font('Helvetica').text(`${item.quantity} x INR ${money(item.sellingPrice).toFixed(2)} | HSN ${item.hsnCode || '-'} | GST ${item.taxRate || 0}% | INR ${money(item.totalAmount).toFixed(2)}`);
    });
    doc.moveDown();
    doc.text(`Taxable: INR ${money(sale.subtotal).toFixed(2)}`, { align: 'right' });
    if (sale.taxMode === 'interstate') doc.text(`IGST: INR ${money(sale.igst).toFixed(2)}`, { align: 'right' });
    else {
      doc.text(`CGST: INR ${money(sale.cgst).toFixed(2)}`, { align: 'right' });
      doc.text(`SGST: INR ${money(sale.sgst).toFixed(2)}`, { align: 'right' });
    }
    doc.font('Helvetica-Bold').fontSize(12).text(`Total: INR ${money(sale.totalAmount).toFixed(2)}`, { align: 'right' });
    if (sale.returnedAmount) doc.font('Helvetica').fontSize(10).text(`Returns/Refunds: INR ${money(sale.returnedAmount).toFixed(2)}`, { align: 'right' });
    doc.end();
  } catch (error) {
    if (!res.headersSent) res.status(error.statusCode || 500).json({ success: false, message: error.message });
    else res.end();
  }
};

async function updatePrescriptionDispense(sale) {
  const prescription = await Prescription.findById(sale.prescriptionId);
  if (!prescription) return;
  const dispensedItems = sale.items.map(item => ({
    medicineId: item.medicineId,
    medicineName: item.medicineName,
    genericName: item.genericName,
    batchId: item.batchId,
    quantity: item.quantity,
    unit: item.unit,
    dispensedAt: sale.dispensedAt,
    dispensedBy: sale.dispensedBy,
    pharmacySaleId: sale._id,
  }));
  prescription.dispensedItems = (prescription.dispensedItems || []).concat(dispensedItems);

  const norm = value => String(value || '').trim().toLowerCase();
  const fulfilled = (prescription.medicines || []).every(rx => {
    const wanted = Math.max(1, Number(rx.prescribedQuantity ?? rx.quantity ?? 1) || 1);
    const names = new Set([norm(rx.medicineName), norm(rx.genericName)].filter(Boolean));
    if (!names.size) return false;
    const supplied = (prescription.dispensedItems || []).reduce((sum, item) => {
      const itemNames = [norm(item.medicineName), norm(item.genericName)];
      return itemNames.some(name => name && names.has(name)) ? sum + Number(item.quantity || 0) : sum;
    }, 0);
    return supplied >= wanted;
  });
  prescription.pharmacyStatus = fulfilled && (prescription.medicines || []).length > 0 ? 'fully_dispensed' : 'partially_dispensed';
  prescription.dispensedBy = sale.dispensedBy;
  prescription.dispensedAt = sale.dispensedAt;
  await prescription.save();
}
