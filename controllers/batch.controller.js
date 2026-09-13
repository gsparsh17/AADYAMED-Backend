const MedicineBatch = require('../models/MedicineBatch');
const Medicine = require('../models/Medicine');
const StockAdjustment = require('../models/StockAdjustment');

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
      batches: batches.map(withLegacyBatchFields),
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

exports.createBatch = async (req, res) => {
  try {
    const payload = normalizeBatchPayload(req.body);
    if (!payload.medicineId || !payload.batchNumber || !payload.expiryDate || !Number.isFinite(payload.quantity) || payload.quantity < 0 || !Number.isFinite(payload.purchasePrice) || !Number.isFinite(payload.sellingPrice)) {
      return res.status(400).json({ message: 'medicineId, batchNumber, quantity, expiryDate, purchasePrice and sellingPrice are required' });
    }

    const medicine = await Medicine.findById(payload.medicineId);
    if (!medicine) return res.status(404).json({ message: 'Medicine not found' });

    const existing = await MedicineBatch.findOne({ medicineId: payload.medicineId, batchNumber: payload.batchNumber, isActive: true });
    if (existing) return res.status(409).json({ message: 'Batch number already exists for this medicine' });

    const batch = await MedicineBatch.create({ ...payload, addedBy: req.user.id });
    const previousQuantity = medicine.quantity;
    medicine.quantity += payload.availableQuantity;
    await medicine.save();

    await StockAdjustment.create({
      medicineId: medicine._id,
      batchId: batch._id,
      previousQuantity,
      adjustmentQuantity: payload.availableQuantity,
      newQuantity: medicine.quantity,
      adjustmentType: 'addition',
      reason: 'Batch created',
      referenceType: 'purchase',
      adjustedBy: req.user.id
    });

    res.status(201).json({ success: true, batch: withLegacyBatchFields(batch), medicine });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getBatchesByMedicine = async (req, res) => {
  try {
    const batches = await MedicineBatch.find({ medicineId: req.params.medicineId, isActive: true })
      .populate('supplierId', 'name companyName')
      .sort({ expiryDate: 1 });
    res.json(batches.map(withLegacyBatchFields));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateBatch = async (req, res) => {
  try {
    const batch = await MedicineBatch.findByIdAndUpdate(
      req.params.id,
      normalizeBatchPayload(req.body),
      { new: true, runValidators: true }
    );
    
    if (!batch) {
      return res.status(404).json({ message: 'Batch not found' });
    }
    
    res.json({ success: true, batch: withLegacyBatchFields(batch) });
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