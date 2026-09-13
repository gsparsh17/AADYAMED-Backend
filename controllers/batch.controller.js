const MedicineBatch = require('../models/MedicineBatch');
const Medicine = require('../models/Medicine');
const Supplier = require('../models/Supplier');
const StockAdjustment = require('../models/StockAdjustment');
const { scopedFilter, scopedPayload } = require('../utils/tenantScope');

const normalizeBatchPayload = (body = {}) => ({
  medicineId: body.medicineId || body.medicine_id,
  batchNumber: body.batchNumber || body.batch_number,
  quantity: Number(body.quantity ?? body.stock_quantity),
  availableQuantity: Number(body.availableQuantity ?? body.available_quantity ?? body.quantity ?? body.stock_quantity),
  manufactureDate: body.manufactureDate || body.manufacture_date || new Date(),
  expiryDate: body.expiryDate || body.expiry_date,
  purchasePrice: Number(body.purchasePrice ?? body.purchase_price),
  sellingPrice: Number(body.sellingPrice ?? body.selling_price ?? body.price_per_unit),
  mrp: body.mrp !== undefined ? Number(body.mrp) : undefined,
  supplierId: body.supplierId || body.supplier_id,
  supplierInvoice: body.supplierInvoice || body.supplier_invoice,
  rackNumber: body.rackNumber || body.rack_number,
  shelfNumber: body.shelfNumber || body.shelf_number,
  notes: body.notes
});

const withLegacyBatchFields = batch => {
  const obj = batch?.toObject ? batch.toObject() : { ...batch };
  return {
    ...obj,
    medicine_id: obj.medicineId,
    batch_number: obj.batchNumber,
    available_quantity: obj.availableQuantity,
    manufacture_date: obj.manufactureDate,
    expiry_date: obj.expiryDate,
    purchase_price: obj.purchasePrice,
    selling_price: obj.sellingPrice,
    supplier_id: obj.supplierId
  };
};

exports.getAllBatches = async (req, res) => {
  try {
    const { medicineId, isExpired, isActive, page = 1, limit = 20 } = req.query;
    const filter = scopedFilter(req);
    if (medicineId) filter.medicineId = medicineId;
    if (isExpired !== undefined) filter.isExpired = isExpired === 'true';
    if (isActive !== undefined) filter.isActive = isActive === 'true';

    const batches = await MedicineBatch.find(filter)
      .populate('medicineId', 'medicineName genericName')
      .populate('supplierId', 'name companyName')
      .sort({ expiryDate: 1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit));

    const total = await MedicineBatch.countDocuments(filter);
    res.json({
      success: true,
      batches: batches.map(withLegacyBatchFields),
      pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit)) }
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.createBatch = async (req, res) => {
  try {
    const payload = normalizeBatchPayload(req.body);
    if (!payload.medicineId || !payload.batchNumber || !payload.expiryDate || !Number.isFinite(payload.quantity) || payload.quantity < 0 || !Number.isFinite(payload.purchasePrice) || !Number.isFinite(payload.sellingPrice)) {
      return res.status(400).json({ message: 'medicineId, batchNumber, quantity, expiryDate, purchasePrice and sellingPrice are required' });
    }

    const medicine = await Medicine.findOne(scopedFilter(req, { _id: payload.medicineId }));
    if (!medicine) return res.status(404).json({ message: 'Medicine not found in the selected store' });

    if (payload.supplierId) {
      const supplier = await Supplier.findOne(scopedFilter(req, { _id: payload.supplierId, isActive: true }));
      if (!supplier) return res.status(400).json({ message: 'Supplier does not belong to the selected store' });
    }

    const existing = await MedicineBatch.findOne(scopedFilter(req, {
      medicineId: payload.medicineId,
      batchNumber: payload.batchNumber,
      isActive: true
    }));
    if (existing) return res.status(409).json({ message: 'Batch number already exists for this medicine in the selected store' });

    const batch = await MedicineBatch.create(scopedPayload(req, { ...payload, addedBy: req.user.id }));
    const previousQuantity = medicine.quantity;
    medicine.quantity += payload.availableQuantity;
    await medicine.save();

    await StockAdjustment.create(scopedPayload(req, {
      medicineId: medicine._id,
      batchId: batch._id,
      previousQuantity,
      adjustmentQuantity: payload.availableQuantity,
      newQuantity: medicine.quantity,
      adjustmentType: 'addition',
      reason: 'Batch created',
      referenceType: 'purchase',
      adjustedBy: req.user.id
    }));

    res.status(201).json({ success: true, batch: withLegacyBatchFields(batch), medicine });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.getBatchesByMedicine = async (req, res) => {
  try {
    const medicine = await Medicine.exists(scopedFilter(req, { _id: req.params.medicineId }));
    if (!medicine) return res.status(404).json({ message: 'Medicine not found in the selected store' });

    const batches = await MedicineBatch.find(scopedFilter(req, {
      medicineId: req.params.medicineId,
      isActive: true
    }))
      .populate('supplierId', 'name companyName')
      .sort({ expiryDate: 1 });
    res.json(batches.map(withLegacyBatchFields));
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.updateBatch = async (req, res) => {
  try {
    const current = await MedicineBatch.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!current) return res.status(404).json({ message: 'Batch not found in the selected store' });

    const normalized = normalizeBatchPayload(req.body);
    const update = Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined && !(typeof value === 'number' && Number.isNaN(value))));
    delete update.quantity;
    delete update.availableQuantity;
    delete update.medicineId;

    if (update.supplierId) {
      const supplier = await Supplier.exists(scopedFilter(req, { _id: update.supplierId }));
      if (!supplier) return res.status(400).json({ message: 'Supplier does not belong to the selected store' });
    }

    const batch = await MedicineBatch.findOneAndUpdate(
      scopedFilter(req, { _id: req.params.id }),
      { $set: update },
      { new: true, runValidators: true }
    );
    res.json({ success: true, batch: withLegacyBatchFields(batch) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.adjustBatchQuantity = async (req, res) => {
  try {
    const quantity = Number(req.body.quantity);
    const { reason, adjustmentType } = req.body;
    if (!Number.isFinite(quantity) || quantity === 0) {
      return res.status(400).json({ message: 'A non-zero numeric quantity is required' });
    }

    const batch = await MedicineBatch.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!batch) return res.status(404).json({ message: 'Batch not found in the selected store' });

    const previousBatchQuantity = batch.availableQuantity;
    batch.availableQuantity += quantity;
    if (batch.availableQuantity < 0) return res.status(400).json({ message: 'Insufficient stock' });
    batch.isActive = batch.availableQuantity > 0;
    await batch.save();

    const medicine = await Medicine.findOne(scopedFilter(req, { _id: batch.medicineId }));
    if (!medicine) return res.status(409).json({ message: 'Batch references a medicine outside the selected store' });
    const previousMedicineQuantity = medicine.quantity;
    medicine.quantity += quantity;
    if (medicine.quantity < 0) return res.status(400).json({ message: 'Insufficient medicine stock' });
    await medicine.save();

    await StockAdjustment.create(scopedPayload(req, {
      medicineId: batch.medicineId,
      batchId: batch._id,
      previousQuantity: previousMedicineQuantity,
      adjustmentQuantity: quantity,
      newQuantity: medicine.quantity,
      adjustmentType: adjustmentType || 'correction',
      reason,
      adjustedBy: req.user.id
    }));

    res.json({ success: true, batch: withLegacyBatchFields(batch), medicine });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};
