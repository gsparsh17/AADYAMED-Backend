const StockAdjustment = require('../models/StockAdjustment');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const { scopedFilter, scopedPayload } = require('../utils/tenantScope');

exports.getAllAdjustments = async (req, res) => {
  try {
    const { medicineId, adjustmentType, startDate, endDate, page = 1, limit = 20 } = req.query;
    const filter = scopedFilter(req);
    if (medicineId) filter.medicineId = medicineId;
    if (adjustmentType) filter.adjustmentType = adjustmentType;
    if (startDate && endDate) filter.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };

    const adjustments = await StockAdjustment.find(filter)
      .populate('medicineId', 'medicineName genericName')
      .populate('batchId', 'batchNumber')
      .populate('adjustedBy', 'name email')
      .populate('approvedBy', 'name email')
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit));
    const total = await StockAdjustment.countDocuments(filter);
    const summary = await StockAdjustment.aggregate([
      { $match: filter },
      { $group: { _id: '$adjustmentType', totalQuantity: { $sum: '$adjustmentQuantity' }, count: { $sum: 1 } } }
    ]);

    res.json({ success: true, adjustments, summary, pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit)) } });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.createAdjustment = async (req, res) => {
  try {
    const medicineId = req.body.medicineId || req.body.medicine_id;
    const batchId = req.body.batchId || req.body.batch_id;
    let adjustmentQuantity = Number(req.body.adjustmentQuantity ?? req.body.adjustment_quantity ?? req.body.quantity);
    let adjustmentType = String(req.body.adjustmentType || req.body.adjustment_type || 'correction').toLowerCase();
    const { reason, notes } = req.body;

    const typeAliases = { expiry: 'expiry', expired: 'expiry', damage: 'damage', damaged: 'damage', theft: 'theft', deduction: 'deduction', addition: 'addition', correction: 'correction', transfer: 'transfer' };
    adjustmentType = typeAliases[adjustmentType] || 'correction';
    if (['expiry', 'damage', 'theft', 'deduction'].includes(adjustmentType) && adjustmentQuantity > 0) adjustmentQuantity *= -1;
    if (!medicineId || !Number.isFinite(adjustmentQuantity) || adjustmentQuantity === 0) {
      return res.status(400).json({ message: 'medicineId and a non-zero adjustment quantity are required' });
    }

    const medicine = await Medicine.findOne(scopedFilter(req, { _id: medicineId }));
    if (!medicine) return res.status(404).json({ message: 'Medicine not found in the selected store' });

    let batch = null;
    if (batchId) {
      batch = await MedicineBatch.findOne(scopedFilter(req, { _id: batchId, medicineId }));
      if (!batch) return res.status(404).json({ message: 'Batch not found for this medicine in the selected store' });
      if (batch.availableQuantity + adjustmentQuantity < 0) return res.status(400).json({ message: 'Insufficient batch stock' });
    }

    const previousQuantity = medicine.quantity;
    const newQuantity = previousQuantity + adjustmentQuantity;
    if (newQuantity < 0) return res.status(400).json({ message: 'Insufficient stock' });

    medicine.quantity = newQuantity;
    await medicine.save();
    if (batch) {
      batch.availableQuantity += adjustmentQuantity;
      batch.isActive = batch.availableQuantity > 0;
      await batch.save();
    }

    const adjustment = await StockAdjustment.create(scopedPayload(req, {
      medicineId,
      batchId,
      previousQuantity,
      adjustmentQuantity,
      newQuantity,
      adjustmentType,
      reason,
      notes,
      adjustedBy: req.user.id
    }));
    res.status(201).json({ success: true, adjustment, medicine });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.getAdjustmentStats = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const matchStage = scopedFilter(req);
    if (startDate && endDate) matchStage.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };

    const stats = await StockAdjustment.aggregate([
      { $match: matchStage },
      { $group: {
        _id: { month: { $month: '$createdAt' }, year: { $year: '$createdAt' } },
        totalAdjustments: { $sum: 1 },
        netQuantityChange: { $sum: '$adjustmentQuantity' },
        additions: { $sum: { $cond: [{ $gt: ['$adjustmentQuantity', 0] }, '$adjustmentQuantity', 0] } },
        deductions: { $sum: { $cond: [{ $lt: ['$adjustmentQuantity', 0] }, { $abs: '$adjustmentQuantity' }, 0] } }
      } },
      { $sort: { '_id.year': -1, '_id.month': -1 } }
    ]);
    const topReasons = await StockAdjustment.aggregate([
      { $match: matchStage },
      { $group: { _id: '$reason', count: { $sum: 1 }, totalQuantity: { $sum: { $abs: '$adjustmentQuantity' } } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);
    res.json({ success: true, stats, topReasons });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};
