const StockAdjustment = require('../models/StockAdjustment');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const { scopedFilter } = require('../utils/tenantScope');
const { scopeFromRequest, addToBatch, deductFromSpecificBatch, consumeFefo } = require('../services/inventory.service');

exports.getAllAdjustments = async (req, res) => {
  try {
    const { medicineId, adjustmentType, startDate, endDate, page = 1, limit = 20 } = req.query;
    const filter = scopedFilter(req);
    if (medicineId) filter.medicineId = medicineId;
    if (adjustmentType) filter.adjustmentType = adjustmentType;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }
    const pageNumber = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(limit) || 20));
    const [adjustments, total] = await Promise.all([
      StockAdjustment.find(filter).populate('medicineId', 'medicineName genericName').populate('batchId', 'batchNumber expiryDate').populate('adjustedBy', 'name email').sort({ createdAt: -1 }).skip((pageNumber - 1) * pageSize).limit(pageSize),
      StockAdjustment.countDocuments(filter),
    ]);
    const summary = await StockAdjustment.aggregate([{ $match: filter }, { $group: { _id: '$adjustmentType', totalQuantity: { $sum: '$adjustmentQuantity' }, count: { $sum: 1 } } }]);
    res.json({ success: true, adjustments, summary, pagination: { page: pageNumber, limit: pageSize, total, pages: Math.ceil(total / pageSize) } });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
};

exports.createAdjustment = async (req, res) => {
  try {
    const medicineId = req.body.medicineId || req.body.medicine_id;
    const batchId = req.body.batchId || req.body.batch_id;
    let quantity = Number(req.body.adjustmentQuantity ?? req.body.adjustment_quantity ?? req.body.quantity);
    let type = String(req.body.adjustmentType || req.body.adjustment_type || 'correction').toLowerCase();
    const reason = req.body.reason || 'Manual stock adjustment';
    const scope = scopeFromRequest(req);
    if (!medicineId || !Number.isFinite(quantity) || quantity === 0) return res.status(400).json({ success: false, message: 'medicineId and a non-zero quantity are required' });
    const medicine = await Medicine.findOne(scopedFilter(req, { _id: medicineId }));
    if (!medicine) return res.status(404).json({ success: false, message: 'Medicine not found in selected store' });
    const negativeTypes = new Set(['expiry', 'damage', 'theft', 'deduction']);
    if (negativeTypes.has(type) && quantity > 0) quantity *= -1;
    if (!['addition','deduction','damage','expiry','theft','correction','transfer'].includes(type)) type = 'correction';

    if (quantity > 0) {
      if (!batchId) return res.status(400).json({ success: false, message: 'A batch is required when adding physical stock' });
      const batch = await MedicineBatch.findOne(scopedFilter(req, { _id: batchId, medicineId }));
      if (!batch) return res.status(404).json({ success: false, message: 'Batch not found for selected medicine' });
      const result = await addToBatch({ scope, medicineId, batchId, quantity, actorId: req.user.id, adjustmentType: type === 'correction' ? 'addition' : type, reason, referenceType: 'manual' });
      return res.status(201).json({ success: true, medicine: result.medicine, batch: result.batch });
    }

    const deduction = Math.abs(quantity);
    if (batchId) {
      const result = await deductFromSpecificBatch({ scope, medicineId, batchId, quantity: deduction, actorId: req.user.id, adjustmentType: type === 'correction' ? 'deduction' : type, reason, referenceType: 'manual' });
      return res.status(201).json({ success: true, medicine: result.medicine, batch: result.batch });
    }
    const result = await consumeFefo({ scope, medicineId, quantity: deduction, actorId: req.user.id, reason, referenceType: 'manual' });
    res.status(201).json({ success: true, medicine: result.medicine, allocations: result.allocations });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
};

exports.getAdjustmentStats = async (req, res) => {
  try {
    const matchStage = scopedFilter(req);
    if (req.query.startDate || req.query.endDate) {
      matchStage.createdAt = {};
      if (req.query.startDate) matchStage.createdAt.$gte = new Date(req.query.startDate);
      if (req.query.endDate) matchStage.createdAt.$lte = new Date(req.query.endDate);
    }
    const [stats, topReasons] = await Promise.all([
      StockAdjustment.aggregate([{ $match: matchStage }, { $group: { _id: { month: { $month: '$createdAt' }, year: { $year: '$createdAt' } }, totalAdjustments: { $sum: 1 }, netQuantityChange: { $sum: '$adjustmentQuantity' }, additions: { $sum: { $cond: [{ $gt: ['$adjustmentQuantity', 0] }, '$adjustmentQuantity', 0] } }, deductions: { $sum: { $cond: [{ $lt: ['$adjustmentQuantity', 0] }, { $abs: '$adjustmentQuantity' }, 0] } } } }, { $sort: { '_id.year': -1, '_id.month': -1 } }]),
      StockAdjustment.aggregate([{ $match: matchStage }, { $group: { _id: '$reason', count: { $sum: 1 }, totalQuantity: { $sum: { $abs: '$adjustmentQuantity' } } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
    ]);
    res.json({ success: true, stats, topReasons });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
};
