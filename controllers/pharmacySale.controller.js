const PharmacySale = require('../models/PharmacySale');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const Prescription = require('../models/Prescription');
const PatientProfile = require('../models/PatientProfile');
const StockAdjustment = require('../models/StockAdjustment');
const { scopedFilter, scopedPayload } = require('../utils/tenantScope');

exports.createSale = async (req, res) => {
  try {
    const customerType = req.body.customerType || req.body.customer_type || 'walkin';
    const patientId = req.body.patientId || req.body.patient_id;
    const prescriptionId = req.body.prescriptionId || req.body.prescription_id;
    const paymentMethod = String(req.body.paymentMethod || req.body.payment_method || 'cash').toLowerCase();
    const notes = req.body.notes;
    const items = (req.body.items || []).map(item => ({
      ...item,
      medicineId: item.medicineId || item.medicine_id,
      batchId: item.batchId || item.batch_id,
      quantity: Number(item.quantity || 0),
    }));

    if (!items.length) return res.status(400).json({ message: 'At least one medicine is required' });

    let customerDetails = {};
    if (patientId) {
      const patient = await PatientProfile.findById(patientId);
      if (!patient) return res.status(404).json({ message: 'Patient not found' });
      customerDetails = {
        customerName: patient.name,
        customerPhone: patient.phone,
        customerEmail: patient.email,
        customerAddress: patient.address
      };
    } else {
      customerDetails = {
        customerName: req.body.customerName || req.body.customer_name,
        customerPhone: req.body.customerPhone || req.body.customer_phone,
        customerEmail: req.body.customerEmail || req.body.customer_email,
        customerAddress: req.body.customerAddress || req.body.customer_address
      };
    }

    let prescriptionDetails = {};
    if (prescriptionId) {
      const prescription = await Prescription.findById(prescriptionId);
      if (!prescription) return res.status(404).json({ message: 'Prescription not found' });
      prescriptionDetails = {
        prescriptionRequired: true,
        prescriptionNumber: prescription.prescriptionNumber,
        prescribingDoctor: prescription.doctorId?.name || prescription.physioId?.name
      };
      if (prescription.pharmacyStatus === 'fully_dispensed') {
        return res.status(400).json({ message: 'Prescription already fully dispensed' });
      }
    }

    let subtotal = 0;
    const validatedItems = [];
    for (const item of items) {
      if (!item.medicineId || !Number.isFinite(item.quantity) || item.quantity <= 0) {
        return res.status(400).json({ message: 'Each sale item needs a valid medicine and positive quantity' });
      }
      const medicine = await Medicine.findOne(scopedFilter(req, { _id: item.medicineId, isActive: true }));
      if (!medicine) return res.status(400).json({ message: `Medicine ${item.medicineId} is not available in the selected store` });
      if (medicine.quantity < item.quantity) {
        return res.status(400).json({ message: `Insufficient stock for ${medicine.medicineName}. Available: ${medicine.quantity}` });
      }
      if (medicine.prescriptionRequired && !prescriptionId) {
        return res.status(400).json({ message: `Prescription required for ${medicine.medicineName}` });
      }

      const itemTotal = item.quantity * medicine.sellingPrice;
      subtotal += itemTotal;
      validatedItems.push({
        medicineId: medicine._id,
        medicineName: medicine.medicineName,
        genericName: medicine.genericName,
        quantity: item.quantity,
        unit: medicine.unit,
        sellingPrice: medicine.sellingPrice,
        taxRate: medicine.taxRate,
        totalAmount: itemTotal
      });
    }

    const tax = validatedItems.reduce((sum, item) => sum + (item.totalAmount * item.taxRate / 100), 0);
    const totalAmount = subtotal + tax;
    const sale = await PharmacySale.create(scopedPayload(req, {
      customerType,
      patientId: patientId || undefined,
      prescriptionId: prescriptionId || undefined,
      ...customerDetails,
      ...prescriptionDetails,
      items: validatedItems,
      subtotal,
      tax,
      totalAmount,
      paidAmount: totalAmount,
      balanceAmount: 0,
      paymentMethod,
      paymentStatus: 'paid',
      status: 'draft',
      notes,
      createdBy: req.user.id
    }));

    res.status(201).json({ success: true, sale });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.dispenseSale = async (req, res) => {
  try {
    const sale = await PharmacySale.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!sale) return res.status(404).json({ message: 'Sale not found in the selected store' });
    if (sale.status !== 'draft') return res.status(400).json({ message: 'Only draft sales can be dispensed' });

    // Preflight stock validation avoids partially mutating one item before a later item fails.
    const medicinesById = new Map();
    for (const item of sale.items) {
      const medicine = await Medicine.findOne(scopedFilter(req, { _id: item.medicineId, isActive: true }));
      if (!medicine || medicine.quantity < item.quantity) {
        return res.status(400).json({ message: `Insufficient stock for ${item.medicineName}` });
      }
      const availableAcrossBatches = await MedicineBatch.aggregate([
        { $match: scopedFilter(req, { medicineId: medicine._id, isActive: true, isExpired: false }) },
        { $group: { _id: null, quantity: { $sum: '$availableQuantity' } } }
      ]);
      if ((availableAcrossBatches[0]?.quantity || 0) < item.quantity) {
        return res.status(400).json({ message: `Insufficient non-expired batch stock for ${medicine.medicineName}` });
      }
      medicinesById.set(String(medicine._id), medicine);
    }

    for (const item of sale.items) {
      const medicine = medicinesById.get(String(item.medicineId));
      const batches = await MedicineBatch.find(scopedFilter(req, {
        medicineId: medicine._id,
        isActive: true,
        isExpired: false,
        availableQuantity: { $gt: 0 }
      })).sort({ expiryDate: 1 });

      let remainingQty = item.quantity;
      for (const batch of batches) {
        if (remainingQty <= 0) break;
        const deductQty = Math.min(remainingQty, batch.availableQuantity);
        const previousBatchQuantity = batch.availableQuantity;
        batch.availableQuantity -= deductQty;
        batch.isActive = batch.availableQuantity > 0;
        await batch.save();

        if (!item.batchId) item.batchId = batch._id;
        await StockAdjustment.create(scopedPayload(req, {
          medicineId: medicine._id,
          batchId: batch._id,
          previousQuantity: previousBatchQuantity,
          adjustmentQuantity: -deductQty,
          newQuantity: batch.availableQuantity,
          adjustmentType: 'deduction',
          reason: 'Pharmacy sale',
          referenceType: 'sale',
          referenceId: sale._id,
          adjustedBy: req.user.id
        }));
        remainingQty -= deductQty;
      }

      medicine.quantity -= item.quantity;
      await medicine.save();
    }

    sale.status = 'dispensed';
    sale.dispensedBy = req.user.id;
    sale.dispensedAt = new Date();
    await sale.save();
    if (sale.prescriptionId) await updatePrescriptionDispense(sale);
    res.json({ success: true, sale });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.getAllSales = async (req, res) => {
  try {
    const { status, customerType, startDate, endDate, patientId, page = 1, limit = 20 } = req.query;
    const filter = scopedFilter(req);
    if (status) filter.status = status;
    if (customerType) filter.customerType = customerType;
    if (patientId) filter.patientId = patientId;
    if (startDate && endDate) filter.saleDate = { $gte: new Date(startDate), $lte: new Date(endDate) };

    const pageNumber = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(limit) || 20));
    const sales = await PharmacySale.find(filter)
      .populate('patientId', 'name phone')
      .populate('prescriptionId', 'prescriptionNumber')
      .populate('createdBy', 'name email')
      .sort({ saleDate: -1 })
      .skip((pageNumber - 1) * pageSize)
      .limit(pageSize);
    const total = await PharmacySale.countDocuments(filter);
    const totals = await PharmacySale.aggregate([
      { $match: filter },
      { $group: { _id: null, totalSales: { $sum: '$totalAmount' }, totalTax: { $sum: '$tax' }, count: { $sum: 1 } } }
    ]);

    res.json({
      success: true,
      sales,
      totals: totals[0] || { totalSales: 0, totalTax: 0, count: 0 },
      pagination: { page: pageNumber, limit: pageSize, total, pages: Math.ceil(total / pageSize) }
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.getSaleById = async (req, res) => {
  try {
    const sale = await PharmacySale.findOne(scopedFilter(req, { _id: req.params.id }))
      .populate('patientId')
      .populate('prescriptionId')
      .populate('createdBy', 'name email')
      .populate('dispensedBy', 'name email');
    if (!sale) return res.status(404).json({ message: 'Sale not found in the selected store' });

    const saleObject = sale.toObject();
    saleObject.items = await Promise.all(sale.items.map(async item => {
      const batch = item.batchId ? await MedicineBatch.findOne(scopedFilter(req, { _id: item.batchId })) : null;
      return { ...item.toObject(), batchDetails: batch };
    }));
    res.json({ success: true, sale: saleObject });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.getTodaySalesStats = async (req, res) => {
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const [result] = await PharmacySale.aggregate([
      { $match: scopedFilter(req, { saleDate: { $gte: start, $lt: end }, status: { $ne: 'cancelled' } }) },
      { $group: { _id: null, totalSales: { $sum: '$totalAmount' }, totalTransactions: { $sum: 1 }, totalItems: { $sum: { $sum: '$items.quantity' } } } }
    ]);
    res.json({ totalSales: result?.totalSales || 0, totalTransactions: result?.totalTransactions || 0, totalItems: result?.totalItems || 0 });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.getSalesReport = async (req, res) => {
  try {
    const { groupBy = 'day', startDate, endDate } = req.query;
    const matchStage = scopedFilter(req, { status: 'dispensed' });
    if (startDate && endDate) matchStage.saleDate = { $gte: new Date(startDate), $lte: new Date(endDate) };

    let groupStage;
    if (groupBy === 'month') {
      groupStage = {
        _id: { year: { $year: '$saleDate' }, month: { $month: '$saleDate' } },
        totalSales: { $sum: '$totalAmount' },
        totalItems: { $sum: '$items.quantity' },
        count: { $sum: 1 }
      };
    } else if (groupBy === 'medicine') {
      groupStage = {
        _id: '$items.medicineId',
        medicineName: { $first: '$items.medicineName' },
        totalQuantity: { $sum: '$items.quantity' },
        totalAmount: { $sum: { $multiply: ['$items.quantity', '$items.sellingPrice'] } },
        count: { $sum: 1 }
      };
    } else {
      groupStage = {
        _id: { year: { $year: '$saleDate' }, month: { $month: '$saleDate' }, day: { $dayOfMonth: '$saleDate' } },
        totalSales: { $sum: '$totalAmount' },
        totalItems: { $sum: '$items.quantity' },
        count: { $sum: 1 }
      };
    }

    const report = await PharmacySale.aggregate([
      { $match: matchStage },
      { $unwind: '$items' },
      { $group: groupStage },
      { $sort: { totalSales: -1, totalAmount: -1 } },
      { $limit: 50 }
    ]);
    const topCustomers = await PharmacySale.aggregate([
      { $match: matchStage },
      { $group: { _id: '$customerPhone', customerName: { $first: '$customerName' }, totalSpent: { $sum: '$totalAmount' }, totalVisits: { $sum: 1 } } },
      { $sort: { totalSpent: -1 } },
      { $limit: 10 }
    ]);
    res.json({ success: true, report, topCustomers });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

async function updatePrescriptionDispense(sale) {
  const prescription = await Prescription.findById(sale.prescriptionId);
  if (!prescription) return;

  const dispensedItems = sale.items.map(item => ({
    medicineId: item.medicineId,
    batchId: item.batchId,
    quantity: item.quantity,
    unit: item.unit,
    dispensedAt: sale.dispensedAt,
    dispensedBy: sale.dispensedBy,
    pharmacySaleId: sale._id
  }));
  prescription.dispensedItems = prescription.dispensedItems.concat(dispensedItems);
  const prescribedMedicines = prescription.medicines || [];
  const dispensedCount = prescription.dispensedItems.length;
  if (dispensedCount === 0) prescription.pharmacyStatus = 'not_dispensed';
  else if (dispensedCount < prescribedMedicines.length) prescription.pharmacyStatus = 'partially_dispensed';
  else prescription.pharmacyStatus = 'fully_dispensed';
  await prescription.save();
}
