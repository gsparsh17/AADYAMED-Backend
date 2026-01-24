const StockAdjustment = require('../models/StockAdjustment');
const Medicine = require('../models/Medicine');

exports.getAllAdjustments = async (req, res) => {
  try {
    const { 
      medicineId, 
      adjustmentType,
      startDate,
      endDate,
      page = 1, 
      limit = 20 
    } = req.query;
    
    const filter = {};
    if (medicineId) filter.medicineId = medicineId;
    if (adjustmentType) filter.adjustmentType = adjustmentType;
    if (startDate && endDate) {
      filter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const adjustments = await StockAdjustment.find(filter)
      .populate('medicineId', 'medicineName genericName')
      .populate('batchId', 'batchNumber')
      .populate('adjustedBy', 'name email')
      .populate('approvedBy', 'name email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await StockAdjustment.countDocuments(filter);
    
    // Calculate summary
    const summary = await StockAdjustment.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$adjustmentType',
          totalQuantity: { $sum: '$adjustmentQuantity' },
          count: { $sum: 1 }
        }
      }
    ]);
    
    res.json({
      success: true,
      adjustments,
      summary,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.createAdjustment = async (req, res) => {
  try {
    const { 
      medicineId, 
      batchId, 
      adjustmentQuantity, 
      adjustmentType, 
      reason, 
      notes 
    } = req.body;
    
    const medicine = await Medicine.findById(medicineId);
    if (!medicine) {
      return res.status(404).json({ message: 'Medicine not found' });
    }
    
    const previousQuantity = medicine.quantity;
    const newQuantity = previousQuantity + adjustmentQuantity;
    
    if (newQuantity < 0) {
      return res.status(400).json({ message: 'Insufficient stock' });
    }
    
    // Update medicine quantity
    medicine.quantity = newQuantity;
    await medicine.save();
    
    // Update batch if provided
    if (batchId) {
      const batch = await MedicineBatch.findById(batchId);
      if (batch) {
        batch.availableQuantity += adjustmentQuantity;
        if (batch.availableQuantity <= 0) {
          batch.isActive = false;
        }
        await batch.save();
      }
    }
    
    // Create adjustment record
    const adjustment = await StockAdjustment.create({
      medicineId,
      batchId,
      previousQuantity,
      adjustmentQuantity,
      newQuantity,
      adjustmentType,
      reason,
      notes,
      adjustedBy: req.user.id
    });
    
    res.status(201).json({ success: true, adjustment, medicine });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getAdjustmentStats = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const matchStage = {};
    if (startDate && endDate) {
      matchStage.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const stats = await StockAdjustment.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: {
            month: { $month: '$createdAt' },
            year: { $year: '$createdAt' }
          },
          totalAdjustments: { $sum: 1 },
          netQuantityChange: { $sum: '$adjustmentQuantity' },
          additions: {
            $sum: { $cond: [{ $gt: ['$adjustmentQuantity', 0] }, '$adjustmentQuantity', 0] }
          },
          deductions: {
            $sum: { $cond: [{ $lt: ['$adjustmentQuantity', 0] }, -'$adjustmentQuantity', 0] }
          }
        }
      },
      { $sort: { '_id.year': -1, '_id.month': -1 } }
    ]);
    
    // Get top reasons for adjustments
    const topReasons = await StockAdjustment.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$reason',
          count: { $sum: 1 },
          totalQuantity: { $sum: { $abs: '$adjustmentQuantity' } }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);
    
    res.json({ success: true, stats, topReasons });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};