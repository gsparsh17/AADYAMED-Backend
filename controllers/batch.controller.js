const MedicineBatch = require('../models/MedicineBatch');
const Medicine = require('../models/Medicine');
const Supplier = require('../models/Supplier');
const { scopedFilter, scopedPayload } = require('../utils/tenantScope');
const { scopeFromRequest, addToBatch, deductFromSpecificBatch } = require('../services/inventory.service');

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
  let batch = null;
  let stockAdded = 0;
  let medicineIdForRollback = null;
  try {
    const payload = normalizeBatchPayload(req.body);
    if (!payload.medicineId || !payload.batchNumber || !payload.expiryDate || !Number.isFinite(payload.quantity) || payload.quantity < 0 || !Number.isFinite(payload.purchasePrice) || !Number.isFinite(payload.sellingPrice)) {
      return res.status(400).json({ message: 'medicineId, batchNumber, quantity, expiryDate, purchasePrice and sellingPrice are required' });
    }
    if (new Date(payload.expiryDate) <= new Date()) return res.status(400).json({ message: 'Expired stock cannot be created as an active batch' });

    const medicine = await Medicine.findOne(scopedFilter(req, { _id: payload.medicineId }));
    medicineIdForRollback = medicine?._id;
    if (!medicine) return res.status(404).json({ message: 'Medicine not found in the selected store' });
    if (payload.supplierId) {
      const supplier = await Supplier.findOne(scopedFilter(req, { _id: payload.supplierId, isActive: true }));
      if (!supplier) return res.status(400).json({ message: 'Supplier does not belong to the selected store' });
    }
    const existing = await MedicineBatch.findOne(scopedFilter(req, { medicineId: payload.medicineId, batchNumber: payload.batchNumber }));
    if (existing) return res.status(409).json({ message: 'Batch number already exists for this medicine in the selected store' });

    const openingQuantity = Number(payload.availableQuantity || 0);
    batch = await MedicineBatch.create(scopedPayload(req, { ...payload, quantity: 0, availableQuantity: 0, addedBy: req.user.id }));
    if (openingQuantity > 0) {
      await addToBatch({ scope: scopeFromRequest(req), medicineId: medicine._id, batchId: batch._id, quantity: openingQuantity, actorId: req.user.id, adjustmentType: 'addition', reason: req.body.reason || 'Opening/batch stock', referenceType: 'stocktake' });
      stockAdded = openingQuantity;
      batch.quantity = openingQuantity;
      await batch.save();
    }
    res.status(201).json({ success: true, batch: withLegacyBatchFields(await MedicineBatch.findById(batch._id)), medicine: await Medicine.findById(medicine._id) });
  } catch (error) {
    if (stockAdded > 0 && batch?._id && medicineIdForRollback) {
      try { await deductFromSpecificBatch({ scope: scopeFromRequest(req), medicineId: medicineIdForRollback, batchId: batch._id, quantity: stockAdded, actorId: req.user.id, adjustmentType: 'deduction', reason: 'Rollback failed batch creation', referenceType: 'stocktake' }); } catch (rollbackError) { console.error('Batch creation rollback failed:', rollbackError); }
    }
    if (batch?._id) {
      try {
        const current = await MedicineBatch.findOne(scopedFilter(req, { _id: batch._id }));
        if (current && Number(current.availableQuantity || 0) <= 0) await current.deleteOne();
      } catch (_) {}
    }
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
    if (!Number.isFinite(quantity) || quantity === 0) return res.status(400).json({ message: 'A non-zero numeric quantity is required' });
    const batch = await MedicineBatch.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!batch) return res.status(404).json({ message: 'Batch not found in the selected store' });
    const scope = scopeFromRequest(req);
    const result = quantity > 0
      ? await addToBatch({ scope, medicineId: batch.medicineId, batchId: batch._id, quantity, actorId: req.user.id, adjustmentType: adjustmentType || 'correction', reason: reason || 'Batch stock correction', referenceType: 'stocktake' })
      : await deductFromSpecificBatch({ scope, medicineId: batch.medicineId, batchId: batch._id, quantity: Math.abs(quantity), actorId: req.user.id, adjustmentType: adjustmentType || 'correction', reason: reason || 'Batch stock correction', referenceType: 'stocktake' });
    res.json({ success: true, batch: withLegacyBatchFields(result.batch), medicine: result.medicine });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};
