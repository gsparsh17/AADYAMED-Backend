const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const StockAdjustment = require('../models/StockAdjustment');

exports.createMedicine = async (req, res) => {
  try {
    const medicine = await Medicine.create({
      ...req.body,
      createdBy: req.user.id
    });
    
    res.status(201).json({ success: true, medicine });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getAllMedicines = async (req, res) => {
  try {
    const { 
      search, 
      category, 
      isActive, 
      lowStock,
      page = 1, 
      limit = 20 
    } = req.query;
    
    const filter = {};
    
    if (search) {
      filter.$text = { $search: search };
    }
    if (category) filter.category = category;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    
    const medicines = await Medicine.find(filter)
      .sort({ medicineName: 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    // Check low stock
    if (lowStock === 'true') {
      const lowStockMedicines = medicines.filter(med => 
        med.quantity <= med.reorderLevel
      );
      return res.json({ success: true, medicines: lowStockMedicines });
    }
    
    const total = await Medicine.countDocuments(filter);
    
    res.json({
      success: true,
      medicines,
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

exports.getMedicineById = async (req, res) => {
  try {
    const medicine = await Medicine.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email');
    
    if (!medicine) {
      return res.status(404).json({ message: 'Medicine not found' });
    }
    
    // Get batches
    const batches = await MedicineBatch.find({ 
      medicineId: medicine._id,
      isActive: true 
    }).sort({ expiryDate: 1 });
    
    // Get stock adjustments
    const adjustments = await StockAdjustment.find({ 
      medicineId: medicine._id 
    })
    .sort({ createdAt: -1 })
    .limit(10)
    .populate('adjustedBy', 'name');
    
    res.json({ 
      success: true, 
      medicine, 
      batches,
      adjustments 
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateMedicine = async (req, res) => {
  try {
    const medicine = await Medicine.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedBy: req.user.id },
      { new: true, runValidators: true }
    );
    
    if (!medicine) {
      return res.status(404).json({ message: 'Medicine not found' });
    }
    
    res.json({ success: true, medicine });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deleteMedicine = async (req, res) => {
  try {
    const medicine = await Medicine.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );
    
    if (!medicine) {
      return res.status(404).json({ message: 'Medicine not found' });
    }
    
    res.json({ success: true, message: 'Medicine deactivated' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.addStock = async (req, res) => {
  try {
    const { batchNumber, quantity, purchasePrice, sellingPrice, expiryDate, manufactureDate, supplierId } = req.body;
    
    const medicine = await Medicine.findById(req.params.id);
    if (!medicine) {
      return res.status(404).json({ message: 'Medicine not found' });
    }
    
    // Create batch
    const batch = await MedicineBatch.create({
      medicineId: medicine._id,
      batchNumber,
      quantity,
      availableQuantity: quantity,
      purchasePrice,
      sellingPrice: sellingPrice || medicine.sellingPrice,
      expiryDate,
      manufactureDate,
      supplierId,
      addedBy: req.user.id
    });
    
    // Update medicine quantity
    medicine.quantity += quantity;
    await medicine.save();
    
    // Record stock adjustment
    await StockAdjustment.create({
      medicineId: medicine._id,
      batchId: batch._id,
      previousQuantity: medicine.quantity - quantity,
      adjustmentQuantity: quantity,
      newQuantity: medicine.quantity,
      adjustmentType: 'addition',
      reason: 'New stock purchase',
      referenceType: 'purchase',
      adjustedBy: req.user.id
    });
    
    res.status(201).json({ success: true, batch, medicine });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getLowStockMedicines = async (req, res) => {
  try {
    const medicines = await Medicine.find({
      isActive: true,
      quantity: { $lte: { $ifNull: ['$reorderLevel', 10] } }
    }).sort({ quantity: 1 });
    
    res.json({ success: true, medicines });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getExpiringMedicines = async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + days);
    
    const batches = await MedicineBatch.find({
      isActive: true,
      isExpired: false,
      expiryDate: { $lte: expiryDate }
    })
    .populate('medicineId', 'medicineName genericName')
    .sort({ expiryDate: 1 });
    
    res.json({ success: true, batches });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};