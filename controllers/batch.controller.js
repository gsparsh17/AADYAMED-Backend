const MedicineBatch = require('../models/MedicineBatch');
const Medicine = require('../models/Medicine');
const StockAdjustment = require('../models/StockAdjustment');

exports.getAllBatches = async (req, res) => {
  try {
    const { 
      medicineId, 
      isExpired, 
      isActive,
      page = 1, 
      limit = 20 
    } = req.query;
    
    const filter = {};
    if (medicineId) filter.medicineId = medicineId;
    if (isExpired !== undefined) filter.isExpired = isExpired === 'true';
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    
    const batches = await MedicineBatch.find(filter)
      .populate('medicineId', 'medicineName genericName')
      .populate('supplierId', 'name companyName')
      .sort({ expiryDate: 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await MedicineBatch.countDocuments(filter);
    
    res.json({
      success: true,
      batches,
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

exports.updateBatch = async (req, res) => {
  try {
    const batch = await MedicineBatch.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!batch) {
      return res.status(404).json({ message: 'Batch not found' });
    }
    
    res.json({ success: true, batch });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.adjustBatchQuantity = async (req, res) => {
  try {
    const { quantity, reason, adjustmentType } = req.body;
    
    const batch = await MedicineBatch.findById(req.params.id);
    if (!batch) {
      return res.status(404).json({ message: 'Batch not found' });
    }
    
    const previousQuantity = batch.availableQuantity;
    batch.availableQuantity += quantity;
    
    if (batch.availableQuantity < 0) {
      return res.status(400).json({ message: 'Insufficient stock' });
    }
    
    await batch.save();
    
    // Update medicine total quantity
    const medicine = await Medicine.findById(batch.medicineId);
    if (medicine) {
      medicine.quantity += quantity;
      await medicine.save();
    }
    
    // Record adjustment
    await StockAdjustment.create({
      medicineId: batch.medicineId,
      batchId: batch._id,
      previousQuantity,
      adjustmentQuantity: quantity,
      newQuantity: batch.availableQuantity,
      adjustmentType: adjustmentType || 'correction',
      reason,
      adjustedBy: req.user.id
    });
    
    res.json({ success: true, batch, medicine });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};