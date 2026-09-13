const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const StockAdjustment = require('../models/StockAdjustment');

const normalizeMedicinePayload = (body = {}) => ({
  ...body,
  ...(body.name !== undefined && body.medicineName === undefined ? { medicineName: body.name } : {}),
  ...(body.generic_name !== undefined && body.genericName === undefined ? { genericName: body.generic_name } : {}),
  ...(body.brand !== undefined && body.brandName === undefined ? { brandName: body.brand } : {}),
  ...(body.stock_quantity !== undefined && body.quantity === undefined ? { quantity: Number(body.stock_quantity) } : {}),
  ...(body.min_stock_level !== undefined && body.reorderLevel === undefined ? { reorderLevel: Number(body.min_stock_level) } : {}),
  ...(body.price_per_unit !== undefined && body.sellingPrice === undefined ? { sellingPrice: Number(body.price_per_unit) } : {}),
  ...(body.is_active !== undefined && body.isActive === undefined ? { isActive: Boolean(body.is_active) } : {})
});

const withLegacyMedicineFields = (medicine) => {
  const obj = medicine?.toObject ? medicine.toObject() : { ...medicine };
  return {
    ...obj,
    name: obj.medicineName,
    generic_name: obj.genericName,
    brand: obj.brandName,
    stock_quantity: obj.quantity,
    min_stock_level: obj.reorderLevel,
    price_per_unit: obj.sellingPrice,
    unit_price: obj.sellingPrice,
    purchase_price: obj.purchasePrice,
    requires_prescription: obj.prescriptionRequired,
    prescription_required: obj.prescriptionRequired,
    tax_rate: obj.taxRate,
    is_active: obj.isActive
  };
};

exports.createMedicine = async (req, res) => {
  try {
    const medicine = await Medicine.create({
      ...normalizeMedicinePayload(req.body),
      createdBy: req.user.id
    });
    
    res.status(201).json({ success: true, medicine: withLegacyMedicineFields(medicine) });
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
      is_active,
      lowStock,
      page = 1, 
      limit = 20 
    } = req.query;
    
    const filter = {};
    
    if (search) {
      filter.$text = { $search: search };
    }
    if (category) filter.category = category;
    if (req.query['stock_quantity[gt]'] !== undefined) {
      filter.quantity = { $gt: Number(req.query['stock_quantity[gt]']) || 0 };
    }
    const activeFilter = isActive !== undefined ? isActive : is_active;
    if (activeFilter !== undefined) filter.isActive = activeFilter === 'true';
    
    const medicines = await Medicine.find(filter)
      .sort({ medicineName: 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    // Check low stock
    if (lowStock === 'true') {
      const lowStockMedicines = medicines.filter(med => 
        med.quantity <= med.reorderLevel
      );
      return res.json({ success: true, medicines: lowStockMedicines.map(withLegacyMedicineFields) });
    }
    
    const total = await Medicine.countDocuments(filter);
    
    res.json({
      success: true,
      medicines: medicines.map(withLegacyMedicineFields),
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
      medicine: withLegacyMedicineFields(medicine), 
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
      { ...normalizeMedicinePayload(req.body), updatedBy: req.user.id },
      { new: true, runValidators: true }
    );
    
    if (!medicine) {
      return res.status(404).json({ message: 'Medicine not found' });
    }
    
    res.json({ success: true, medicine: withLegacyMedicineFields(medicine) });
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
    const threshold = req.query.threshold !== undefined ? Number(req.query.threshold) : null;
    const filter = threshold !== null && Number.isFinite(threshold)
      ? { isActive: true, quantity: { $lte: threshold } }
      : { isActive: true, $expr: { $lte: ['$quantity', '$reorderLevel'] } };

    const medicines = await Medicine.find(filter).sort({ quantity: 1 });
    res.json({ success: true, medicines: medicines.map(withLegacyMedicineFields) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.searchMedicines = async (req, res) => {
  try {
    const query = String(req.query.query || req.query.q || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    if (!query) return res.json([]);

    const medicines = await Medicine.find({
      isActive: true,
      $or: [
        { medicineName: { $regex: query, $options: 'i' } },
        { genericName: { $regex: query, $options: 'i' } },
        { brandName: { $regex: query, $options: 'i' } },
        { barcode: { $regex: query, $options: 'i' } }
      ]
    }).sort({ medicineName: 1 }).limit(limit);

    res.json(medicines.map(withLegacyMedicineFields));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getExpiredMedicines = async (req, res) => {
  try {
    const now = new Date();
    const batches = await MedicineBatch.find({
      isActive: true,
      $or: [{ isExpired: true }, { expiryDate: { $lt: now } }]
    })
      .populate('medicineId')
      .sort({ expiryDate: 1 });

    const response = batches.map(batch => {
      const medicine = batch.medicineId ? withLegacyMedicineFields(batch.medicineId) : {};
      return {
        ...medicine,
        batch_id: batch._id,
        batch_number: batch.batchNumber,
        expiry_date: batch.expiryDate,
        stock_quantity: batch.availableQuantity,
        quantity: batch.availableQuantity,
        purchase_price: batch.purchasePrice,
        price_per_unit: batch.sellingPrice,
        sellingPrice: batch.sellingPrice
      };
    });
    res.json(response);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getExpiringMedicines = async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + days);
    
    const now = new Date();
    const batches = await MedicineBatch.find({
      isActive: true,
      isExpired: false,
      expiryDate: { $gte: now, $lte: expiryDate }
    })
    .populate('medicineId', 'medicineName genericName brandName category')
    .sort({ expiryDate: 1 });

    const normalizedBatches = batches.map(batch => ({
      ...batch.toObject(),
      medicine_id: batch.medicineId ? {
        ...batch.medicineId.toObject(),
        name: batch.medicineId.medicineName,
        generic_name: batch.medicineId.genericName,
        brand: batch.medicineId.brandName
      } : null,
      batch_number: batch.batchNumber,
      expiry_date: batch.expiryDate,
      quantity: batch.availableQuantity,
      purchase_price: batch.purchasePrice,
      selling_price: batch.sellingPrice
    }));

    res.json({ success: true, batches: normalizedBatches });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};