const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const StockAdjustment = require('../models/StockAdjustment');

function scopeFilter(scope, extra = {}) {
  return {
    organizationId: scope.organizationId,
    storeId: scope.storeId,
    ...extra,
  };
}

function scopePayload(scope, payload = {}) {
  return {
    ...payload,
    organizationId: scope.organizationId,
    storeId: scope.storeId,
  };
}

function scopeFromRequest(req) {
  if (!req?.tenant?.organizationId || !req?.tenant?.storeId) {
    const error = new Error('Pharmacy tenant context is required');
    error.statusCode = 400;
    throw error;
  }
  return {
    organizationId: req.tenant.organizationId,
    storeId: req.tenant.storeId,
  };
}

async function aggregateAvailable(scope, medicineId) {
  const [row] = await MedicineBatch.aggregate([
    { $match: scopeFilter(scope, {
      medicineId,
      isActive: true,
      isExpired: false,
      expiryDate: { $gte: new Date() },
      availableQuantity: { $gt: 0 },
    }) },
    { $group: { _id: null, quantity: { $sum: '$availableQuantity' } } },
  ]);
  return row?.quantity || 0;
}

async function consumeFefo({ scope, medicineId, quantity, actorId, reason, referenceType, referenceId }) {
  const requested = Number(quantity);
  if (!Number.isFinite(requested) || requested <= 0) {
    const error = new Error('A positive quantity is required');
    error.statusCode = 400;
    throw error;
  }

  const medicine = await Medicine.findOne(scopeFilter(scope, { _id: medicineId, isActive: true }));
  if (!medicine) {
    const error = new Error('Medicine not found in the selected store');
    error.statusCode = 404;
    throw error;
  }
  if (medicine.quantity < requested) {
    const error = new Error(`Insufficient stock for ${medicine.medicineName}. Available: ${medicine.quantity}`);
    error.statusCode = 409;
    throw error;
  }

  const available = await aggregateAvailable(scope, medicine._id);
  if (available < requested) {
    const error = new Error(`Insufficient non-expired batch stock for ${medicine.medicineName}. Available: ${available}`);
    error.statusCode = 409;
    throw error;
  }

  const batches = await MedicineBatch.find(scopeFilter(scope, {
    medicineId: medicine._id,
    isActive: true,
    isExpired: false,
    expiryDate: { $gte: new Date() },
    availableQuantity: { $gt: 0 },
  })).sort({ expiryDate: 1, createdAt: 1 });

  const changedBatches = [];
  let remaining = requested;
  let updatedMedicine = null;
  try {
    for (const batch of batches) {
      if (remaining <= 0) break;
      const qty = Math.min(remaining, batch.availableQuantity);
      const before = batch.availableQuantity;
      const updated = await MedicineBatch.findOneAndUpdate(
        scopeFilter(scope, { _id: batch._id, availableQuantity: { $gte: qty } }),
        { $inc: { availableQuantity: -qty } },
        { new: true }
      );
      if (!updated) {
        const error = new Error(`Stock changed while dispensing batch ${batch.batchNumber}; please retry`);
        error.statusCode = 409;
        throw error;
      }
      if (updated.availableQuantity <= 0) {
        updated.isActive = false;
        await updated.save();
      }
      changedBatches.push({ batchId: updated._id, quantity: qty, before, after: updated.availableQuantity, purchasePrice: Number(batch.purchasePrice || 0), batchNumber: batch.batchNumber, expiryDate: batch.expiryDate, manufactureDate: batch.manufactureDate, sellingPrice: batch.sellingPrice, mrp: batch.mrp });
      remaining -= qty;
    }

    if (remaining > 0) {
      const error = new Error('Available batch stock changed during the operation; please retry');
      error.statusCode = 409;
      throw error;
    }

    const previousMedicineQuantity = medicine.quantity;
    updatedMedicine = await Medicine.findOneAndUpdate(
      scopeFilter(scope, { _id: medicine._id, quantity: { $gte: requested } }),
      { $inc: { quantity: -requested } },
      { new: true }
    );
    if (!updatedMedicine) {
      const error = new Error('Medicine stock changed during the operation; please retry');
      error.statusCode = 409;
      throw error;
    }

    await Promise.all(changedBatches.map(change => StockAdjustment.create(scopePayload(scope, {
      medicineId: medicine._id,
      batchId: change.batchId,
      previousQuantity: previousMedicineQuantity,
      adjustmentQuantity: -change.quantity,
      newQuantity: updatedMedicine.quantity,
      previousBatchQuantity: change.before,
      newBatchQuantity: change.after,
      adjustmentType: 'deduction',
      reason: reason || 'Stock issue',
      referenceType: referenceType || 'other',
      referenceId,
      adjustedBy: actorId,
    }))));

    return {
      medicine: updatedMedicine,
      allocations: changedBatches.map(change => ({ batchId: change.batchId, quantity: change.quantity, purchasePrice: change.purchasePrice, batchNumber: change.batchNumber, expiryDate: change.expiryDate, manufactureDate: change.manufactureDate, sellingPrice: change.sellingPrice, mrp: change.mrp })),
    };
  } catch (error) {
    // Best-effort rollback if a later batch/medicine/ledger write fails.
    const rollbacks = changedBatches.map(change => MedicineBatch.updateOne(
      scopeFilter(scope, { _id: change.batchId }),
      { $inc: { availableQuantity: change.quantity }, $set: { isActive: true } }
    ));
    if (updatedMedicine) {
      rollbacks.push(Medicine.updateOne(
        scopeFilter(scope, { _id: medicine._id }),
        { $inc: { quantity: requested } }
      ));
    }
    await Promise.allSettled(rollbacks);
    throw error;
  }
}

async function addToBatch({
  scope,
  medicineId,
  batchId,
  quantity,
  actorId,
  adjustmentType = 'addition',
  reason,
  referenceType = 'other',
  referenceId,
}) {
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    const error = new Error('A positive quantity is required');
    error.statusCode = 400;
    throw error;
  }

  const medicine = await Medicine.findOne(scopeFilter(scope, { _id: medicineId }));
  const batch = await MedicineBatch.findOne(scopeFilter(scope, { _id: batchId, medicineId }));
  if (!medicine || !batch) {
    const error = new Error('Medicine or batch not found in the selected store');
    error.statusCode = 404;
    throw error;
  }

  const previousMedicineQuantity = medicine.quantity;
  const previousBatchQuantity = batch.availableQuantity;
  const updatedBatch = await MedicineBatch.findOneAndUpdate(
    scopeFilter(scope, { _id: batch._id }),
    { $inc: { availableQuantity: qty }, $set: { isActive: true, isExpired: batch.expiryDate < new Date() } },
    { new: true }
  );
  const updatedMedicine = await Medicine.findOneAndUpdate(
    scopeFilter(scope, { _id: medicine._id }),
    { $inc: { quantity: qty } },
    { new: true }
  );
  if (!updatedMedicine) {
    await MedicineBatch.updateOne(scopeFilter(scope, { _id: batch._id }), { $inc: { availableQuantity: -qty } });
    const error = new Error('Medicine stock changed during the operation; please retry');
    error.statusCode = 409;
    throw error;
  }

  try {
    await StockAdjustment.create(scopePayload(scope, {
      medicineId: medicine._id,
      batchId: batch._id,
      previousQuantity: previousMedicineQuantity,
      adjustmentQuantity: qty,
      newQuantity: updatedMedicine.quantity,
      previousBatchQuantity,
      newBatchQuantity: updatedBatch.availableQuantity,
      adjustmentType,
      reason,
      referenceType,
      referenceId,
      adjustedBy: actorId,
    }));
  } catch (error) {
    await Promise.allSettled([
      MedicineBatch.updateOne(scopeFilter(scope, { _id: batch._id }), { $inc: { availableQuantity: -qty } }),
      Medicine.updateOne(scopeFilter(scope, { _id: medicine._id }), { $inc: { quantity: -qty } }),
    ]);
    throw error;
  }

  return { medicine: updatedMedicine, batch: updatedBatch };
}

async function deductFromSpecificBatch({
  scope,
  medicineId,
  batchId,
  quantity,
  actorId,
  adjustmentType = 'deduction',
  reason,
  referenceType = 'other',
  referenceId,
}) {
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    const error = new Error('A positive quantity is required');
    error.statusCode = 400;
    throw error;
  }
  const medicine = await Medicine.findOne(scopeFilter(scope, { _id: medicineId }));
  const batch = await MedicineBatch.findOne(scopeFilter(scope, { _id: batchId, medicineId }));
  if (!medicine || !batch) {
    const error = new Error('Medicine or batch not found in the selected store');
    error.statusCode = 404;
    throw error;
  }
  if (medicine.quantity < qty || batch.availableQuantity < qty) {
    const error = new Error('Insufficient stock');
    error.statusCode = 409;
    throw error;
  }

  const previousMedicineQuantity = medicine.quantity;
  const previousBatchQuantity = batch.availableQuantity;
  const updatedBatch = await MedicineBatch.findOneAndUpdate(
    scopeFilter(scope, { _id: batch._id, availableQuantity: { $gte: qty } }),
    { $inc: { availableQuantity: -qty } },
    { new: true }
  );
  if (!updatedBatch) {
    const error = new Error('Batch stock changed; please retry');
    error.statusCode = 409;
    throw error;
  }
  if (updatedBatch.availableQuantity <= 0) {
    updatedBatch.isActive = false;
    await updatedBatch.save();
  }

  const updatedMedicine = await Medicine.findOneAndUpdate(
    scopeFilter(scope, { _id: medicine._id, quantity: { $gte: qty } }),
    { $inc: { quantity: -qty } },
    { new: true }
  );
  if (!updatedMedicine) {
    await MedicineBatch.updateOne(scopeFilter(scope, { _id: batch._id }), { $inc: { availableQuantity: qty }, $set: { isActive: true } });
    const error = new Error('Medicine stock changed; please retry');
    error.statusCode = 409;
    throw error;
  }

  try {
    await StockAdjustment.create(scopePayload(scope, {
      medicineId: medicine._id,
      batchId: batch._id,
      previousQuantity: previousMedicineQuantity,
      adjustmentQuantity: -qty,
      newQuantity: updatedMedicine.quantity,
      previousBatchQuantity,
      newBatchQuantity: updatedBatch.availableQuantity,
      adjustmentType,
      reason,
      referenceType,
      referenceId,
      adjustedBy: actorId,
    }));
  } catch (error) {
    await Promise.allSettled([
      MedicineBatch.updateOne(scopeFilter(scope, { _id: batch._id }), { $inc: { availableQuantity: qty }, $set: { isActive: true } }),
      Medicine.updateOne(scopeFilter(scope, { _id: medicine._id }), { $inc: { quantity: qty } }),
    ]);
    throw error;
  }

  return { medicine: updatedMedicine, batch: updatedBatch };
}

module.exports = {
  scopeFilter,
  scopePayload,
  scopeFromRequest,
  aggregateAvailable,
  consumeFefo,
  addToBatch,
  deductFromSpecificBatch,
};
