const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const StockAdjustment = require('../models/StockAdjustment');
const Supplier = require('../models/Supplier');
const { scopedFilter, scopedPayload } = require('../utils/tenantScope');

const normalizeMedicinePayload = (body = {}) => {
  const payload = {
    ...body,
    ...(body.name !== undefined && body.medicineName === undefined ? { medicineName: body.name } : {}),
    ...(body.generic_name !== undefined && body.genericName === undefined ? { genericName: body.generic_name } : {}),
    ...(body.brand !== undefined && body.brandName === undefined ? { brandName: body.brand } : {}),
    ...(body.stock_quantity !== undefined && body.quantity === undefined ? { quantity: Number(body.stock_quantity) } : {}),
    ...(body.min_stock_level !== undefined && body.reorderLevel === undefined ? { reorderLevel: Number(body.min_stock_level) } : {}),
    ...(body.price_per_unit !== undefined && body.sellingPrice === undefined ? { sellingPrice: Number(body.price_per_unit) } : {}),
    ...(body.is_active !== undefined && body.isActive === undefined ? { isActive: Boolean(body.is_active) } : {})
  };
  delete payload.organizationId;
  delete payload.organization_id;
  delete payload.storeId;
  delete payload.store_id;

  if (!payload.unit && payload.category) {
    const categoryUnits = {
      tablet: 'tablet', capsule: 'capsule', syrup: 'bottle', injection: 'ml',
      cream: 'tube', ointment: 'tube', drops: 'bottle', inhaler: 'other', other: 'other'
    };
    payload.unit = categoryUnits[payload.category] || 'other';
  }
  return payload;
};

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
    const medicine = await Medicine.create(scopedPayload(req, {
      ...normalizeMedicinePayload(req.body),
      createdBy: req.user.id
    }));
    res.status(201).json({ success: true, medicine: withLegacyMedicineFields(medicine) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.getAllMedicines = async (req, res) => {
  try {
    const { search, category, isActive, is_active, lowStock, page = 1, limit = 20 } = req.query;
    const filter = scopedFilter(req);
    if (search) filter.$text = { $search: search };
    if (category) filter.category = category;
    if (req.query['stock_quantity[gt]'] !== undefined) {
      filter.quantity = { $gt: Number(req.query['stock_quantity[gt]']) || 0 };
    }
    const activeFilter = isActive !== undefined ? isActive : is_active;
    if (activeFilter !== undefined) filter.isActive = activeFilter === 'true';

    const medicines = await Medicine.find(filter)
      .sort({ medicineName: 1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit));

    if (lowStock === 'true') {
      const lowStockMedicines = medicines.filter(med => med.quantity <= med.reorderLevel);
      return res.json({ success: true, medicines: lowStockMedicines.map(withLegacyMedicineFields) });
    }

    const total = await Medicine.countDocuments(filter);
    res.json({
      success: true,
      medicines: medicines.map(withLegacyMedicineFields),
      pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit)) }
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.getMedicineById = async (req, res) => {
  try {
    const medicine = await Medicine.findOne(scopedFilter(req, { _id: req.params.id }))
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email');
    if (!medicine) return res.status(404).json({ message: 'Medicine not found in the selected store' });

    const batches = await MedicineBatch.find(scopedFilter(req, { medicineId: medicine._id, isActive: true }))
      .sort({ expiryDate: 1 });
    const adjustments = await StockAdjustment.find(scopedFilter(req, { medicineId: medicine._id }))
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('adjustedBy', 'name');

    res.json({ success: true, medicine: withLegacyMedicineFields(medicine), batches, adjustments });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.updateMedicine = async (req, res) => {
  try {
    const medicine = await Medicine.findOneAndUpdate(
      scopedFilter(req, { _id: req.params.id }),
      { ...normalizeMedicinePayload(req.body), updatedBy: req.user.id },
      { new: true, runValidators: true }
    );
    if (!medicine) return res.status(404).json({ message: 'Medicine not found in the selected store' });
    res.json({ success: true, medicine: withLegacyMedicineFields(medicine) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.deleteMedicine = async (req, res) => {
  try {
    const medicine = await Medicine.findOneAndUpdate(
      scopedFilter(req, { _id: req.params.id }),
      { isActive: false, updatedBy: req.user.id },
      { new: true }
    );
    if (!medicine) return res.status(404).json({ message: 'Medicine not found in the selected store' });
    res.json({ success: true, message: 'Medicine deactivated' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.addStock = async (req, res) => {
  try {
    const { batchNumber, quantity, purchasePrice, sellingPrice, expiryDate, manufactureDate, supplierId } = req.body;
    const numericQuantity = Number(quantity);
    if (!batchNumber || !expiryDate || !Number.isFinite(numericQuantity) || numericQuantity <= 0) {
      return res.status(400).json({ message: 'batchNumber, expiryDate and a positive quantity are required' });
    }

    const medicine = await Medicine.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!medicine) return res.status(404).json({ message: 'Medicine not found in the selected store' });

    if (supplierId) {
      const supplier = await Supplier.findOne(scopedFilter(req, { _id: supplierId, isActive: true }));
      if (!supplier) return res.status(400).json({ message: 'Supplier does not belong to the selected store' });
    }

    const duplicate = await MedicineBatch.exists(scopedFilter(req, { medicineId: medicine._id, batchNumber }));
    if (duplicate) return res.status(409).json({ message: 'Batch number already exists for this medicine in the selected store' });

    const previousQuantity = medicine.quantity;
    const batch = await MedicineBatch.create(scopedPayload(req, {
      medicineId: medicine._id,
      batchNumber,
      quantity: numericQuantity,
      availableQuantity: numericQuantity,
      purchasePrice,
      sellingPrice: sellingPrice || medicine.sellingPrice,
      expiryDate,
      manufactureDate: manufactureDate || new Date(),
      supplierId,
      addedBy: req.user.id
    }));

    medicine.quantity += numericQuantity;
    await medicine.save();

    await StockAdjustment.create(scopedPayload(req, {
      medicineId: medicine._id,
      batchId: batch._id,
      previousQuantity,
      adjustmentQuantity: numericQuantity,
      newQuantity: medicine.quantity,
      adjustmentType: 'addition',
      reason: 'New stock purchase',
      referenceType: 'purchase',
      adjustedBy: req.user.id
    }));

    res.status(201).json({ success: true, batch, medicine: withLegacyMedicineFields(medicine) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.getLowStockMedicines = async (req, res) => {
  try {
    const threshold = req.query.threshold !== undefined ? Number(req.query.threshold) : null;
    const extra = threshold !== null && Number.isFinite(threshold)
      ? { isActive: true, quantity: { $lte: threshold } }
      : { isActive: true, $expr: { $lte: ['$quantity', '$reorderLevel'] } };
    const medicines = await Medicine.find(scopedFilter(req, extra)).sort({ quantity: 1 });
    res.json({ success: true, medicines: medicines.map(withLegacyMedicineFields) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.searchMedicines = async (req, res) => {
  try {
    const query = String(req.query.query || req.query.q || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    if (!query) return res.json([]);
    const medicines = await Medicine.find(scopedFilter(req, {
      isActive: true,
      $or: [
        { medicineName: { $regex: query, $options: 'i' } },
        { genericName: { $regex: query, $options: 'i' } },
        { brandName: { $regex: query, $options: 'i' } },
        { barcode: { $regex: query, $options: 'i' } }
      ]
    })).sort({ medicineName: 1 }).limit(limit);
    res.json(medicines.map(withLegacyMedicineFields));
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.getExpiredMedicines = async (req, res) => {
  try {
    const now = new Date();
    const batches = await MedicineBatch.find(scopedFilter(req, {
      isActive: true,
      $or: [{ isExpired: true }, { expiryDate: { $lt: now } }]
    })).populate('medicineId').sort({ expiryDate: 1 });

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
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.getExpiringMedicines = async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + days);
    const now = new Date();
    const batches = await MedicineBatch.find(scopedFilter(req, {
      isActive: true,
      isExpired: false,
      expiryDate: { $gte: now, $lte: expiryDate }
    }))
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
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};
