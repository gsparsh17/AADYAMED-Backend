const StockTransfer = require('../models/StockTransfer');
const PharmacyStore = require('../models/PharmacyStore');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const { scopeFromRequest, consumeFefo, addToBatch, deductFromSpecificBatch, scopeFilter } = require('../services/inventory.service');

const currentStoreId = req => String(req.tenant.storeId);

exports.createTransfer = async (req, res) => {
  try {
    const destinationStoreId = req.body.destinationStoreId || req.body.destination_store_id;
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!destinationStoreId || !items.length) return res.status(400).json({ success: false, message: 'Destination store and items are required' });
    if (String(destinationStoreId) === currentStoreId(req)) return res.status(400).json({ success: false, message: 'Source and destination stores must be different' });
    const destination = await PharmacyStore.findOne({ _id: destinationStoreId, organizationId: req.tenant.organizationId, status: 'active' });
    if (!destination) return res.status(400).json({ success: false, message: 'Destination store is not in this pharmacy organization' });

    const prepared = [];
    for (const row of items) {
      const medicineId = row.medicineId || row.medicine_id;
      const quantity = Number(row.quantity || row.requestedQuantity || 0);
      const medicine = await Medicine.findOne(scopeFilter(scopeFromRequest(req), { _id: medicineId, isActive: true }));
      if (!medicine || quantity <= 0) return res.status(400).json({ success: false, message: 'Invalid medicine or transfer quantity' });
      if (medicine.quantity < quantity) return res.status(409).json({ success: false, message: `Insufficient stock for ${medicine.medicineName}` });
      prepared.push({ medicineId: medicine._id, medicineName: medicine.medicineName, requestedQuantity: quantity });
    }

    const transfer = await StockTransfer.create({
      organizationId: req.tenant.organizationId,
      sourceStoreId: req.tenant.storeId,
      destinationStoreId,
      items: prepared,
      requestedBy: req.user.id,
      notes: req.body.notes,
    });
    res.status(201).json({ success: true, transfer });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.listTransfers = async (req, res) => {
  try {
    const filter = { organizationId: req.tenant.organizationId, $or: [{ sourceStoreId: req.tenant.storeId }, { destinationStoreId: req.tenant.storeId }] };
    if (req.query.status) filter.status = req.query.status;
    const transfers = await StockTransfer.find(filter).populate('sourceStoreId', 'name code').populate('destinationStoreId', 'name code').populate('requestedBy approvedBy dispatchedBy receivedBy', 'name email').sort({ createdAt: -1 }).limit(200);
    res.json({ success: true, transfers });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.getTransfer = async (req, res) => {
  try {
    const transfer = await StockTransfer.findOne({ _id: req.params.id, organizationId: req.tenant.organizationId, $or: [{ sourceStoreId: req.tenant.storeId }, { destinationStoreId: req.tenant.storeId }] }).populate('sourceStoreId destinationStoreId').populate('items.medicineId', 'medicineName genericName barcode');
    if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found' });
    res.json({ success: true, transfer });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.approveTransfer = async (req, res) => {
  try {
    const transfer = await StockTransfer.findOne({ _id: req.params.id, organizationId: req.tenant.organizationId, sourceStoreId: req.tenant.storeId });
    if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found for this source store' });
    if (transfer.status !== 'requested') return res.status(400).json({ success: false, message: 'Only requested transfers can be approved' });
    transfer.status = 'approved'; transfer.approvedBy = req.user.id; transfer.approvedAt = new Date();
    await transfer.save();
    res.json({ success: true, transfer });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
};

exports.dispatchTransfer = async (req, res) => {
  try {
    const transfer = await StockTransfer.findOne({ _id: req.params.id, organizationId: req.tenant.organizationId, sourceStoreId: req.tenant.storeId });
    if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found for this source store' });
    if (transfer.status !== 'approved') return res.status(400).json({ success: false, message: 'Only approved transfers can be dispatched' });
    const scope = scopeFromRequest(req);
    const dispatched = [];
    try {
      for (const item of transfer.items) {
        const result = await consumeFefo({ scope, medicineId: item.medicineId, quantity: item.requestedQuantity, actorId: req.user.id, reason: `Stock transfer ${transfer.transferNumber}`, referenceType: 'transfer', referenceId: transfer._id });
        item.dispatchedQuantity = item.requestedQuantity;
        item.batchAllocations = result.allocations.map(a => ({ sourceBatchId: a.batchId, batchNumber: a.batchNumber, quantity: a.quantity, expiryDate: a.expiryDate, manufactureDate: a.manufactureDate, purchasePrice: a.purchasePrice, sellingPrice: a.sellingPrice, mrp: a.mrp }));
        dispatched.push({ medicineId: item.medicineId, allocations: result.allocations });
      }
      transfer.status = 'dispatched'; transfer.dispatchedBy = req.user.id; transfer.dispatchedAt = new Date();
      await transfer.save();
    } catch (error) {
      for (const done of dispatched.reverse()) {
        for (const allocation of done.allocations) {
          try {
            await addToBatch({ scope, medicineId: done.medicineId, batchId: allocation.batchId, quantity: allocation.quantity, actorId: req.user.id, adjustmentType: 'addition', reason: `Rollback transfer ${transfer.transferNumber}`, referenceType: 'transfer', referenceId: transfer._id });
          } catch (rollbackError) {
            console.error('Stock-transfer dispatch rollback failed:', rollbackError);
          }
        }
      }
      throw error;
    }
    res.json({ success: true, transfer });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
};

exports.receiveTransfer = async (req, res) => {
  const appliedReceipts = [];
  try {
    const transfer = await StockTransfer.findOne({ _id: req.params.id, organizationId: req.tenant.organizationId, destinationStoreId: req.tenant.storeId });
    if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found for this destination store' });
    if (transfer.status !== 'dispatched') return res.status(400).json({ success: false, message: 'Only dispatched transfers can be received' });
    const destinationScope = scopeFromRequest(req);
    const sourceScope = { organizationId: req.tenant.organizationId, storeId: transfer.sourceStoreId };

    for (const item of transfer.items) {
      const sourceMedicine = await Medicine.findOne(scopeFilter(sourceScope, { _id: item.medicineId }));
      if (!sourceMedicine) {
        const error = new Error(`Source medicine record missing for ${item.medicineName}`);
        error.statusCode = 409;
        throw error;
      }
      let destinationMedicine = null;
      if (sourceMedicine.barcode) destinationMedicine = await Medicine.findOne(scopeFilter(destinationScope, { barcode: sourceMedicine.barcode }));
      if (!destinationMedicine) {
        const match = { medicineName: sourceMedicine.medicineName };
        if (sourceMedicine.genericName) match.genericName = sourceMedicine.genericName;
        destinationMedicine = await Medicine.findOne(scopeFilter(destinationScope, match));
      }
      if (!destinationMedicine) {
        const data = sourceMedicine.toObject();
        delete data._id; delete data.__v; delete data.createdAt; delete data.updatedAt;
        data.organizationId = destinationScope.organizationId; data.storeId = destinationScope.storeId; data.quantity = 0; data.createdBy = req.user.id;
        destinationMedicine = await Medicine.create(data);
      }

      let totalReceived = 0;
      for (const allocation of item.batchAllocations) {
        let batch = await MedicineBatch.findOne(scopeFilter(destinationScope, { medicineId: destinationMedicine._id, batchNumber: allocation.batchNumber }));
        if (!batch) {
          batch = await MedicineBatch.create({ organizationId: destinationScope.organizationId, storeId: destinationScope.storeId, medicineId: destinationMedicine._id, batchNumber: allocation.batchNumber, quantity: allocation.quantity, availableQuantity: 0, manufactureDate: allocation.manufactureDate || new Date(), expiryDate: allocation.expiryDate, purchasePrice: allocation.purchasePrice || 0, sellingPrice: allocation.sellingPrice || destinationMedicine.sellingPrice, mrp: allocation.mrp, isActive: true, addedBy: req.user.id });
        } else {
          batch.quantity += allocation.quantity;
          await batch.save();
        }
        await addToBatch({ scope: destinationScope, medicineId: destinationMedicine._id, batchId: batch._id, quantity: allocation.quantity, actorId: req.user.id, adjustmentType: 'addition', reason: `Received transfer ${transfer.transferNumber}`, referenceType: 'transfer', referenceId: transfer._id });
        appliedReceipts.push({ medicineId: destinationMedicine._id, batchId: batch._id, quantity: allocation.quantity });
        allocation.destinationBatchId = batch._id;
        totalReceived += allocation.quantity;
      }
      item.receivedQuantity = totalReceived;
    }
    transfer.status = 'received'; transfer.receivedBy = req.user.id; transfer.receivedAt = new Date();
    await transfer.save();
    res.json({ success: true, transfer });
  } catch (error) {
    if (req.tenant && appliedReceipts.length) {
      const destinationScope = scopeFromRequest(req);
      for (const receipt of appliedReceipts.reverse()) {
        try {
          await deductFromSpecificBatch({ scope: destinationScope, medicineId: receipt.medicineId, batchId: receipt.batchId, quantity: receipt.quantity, actorId: req.user.id, adjustmentType: 'deduction', reason: 'Rollback failed transfer receipt', referenceType: 'transfer', referenceId: req.params.id });
          // Keep lifetime received quantity aligned with the compensated stock.
          await MedicineBatch.updateOne(scopeFilter(destinationScope, { _id: receipt.batchId }), { $inc: { quantity: -receipt.quantity } });
        } catch (rollbackError) {
          console.error('Stock-transfer receipt rollback failed:', rollbackError);
        }
      }
    }
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.cancelTransfer = async (req, res) => {
  try {
    const transfer = await StockTransfer.findOne({ _id: req.params.id, organizationId: req.tenant.organizationId, sourceStoreId: req.tenant.storeId });
    if (!transfer) return res.status(404).json({ success: false, message: 'Transfer not found' });
    if (!['requested', 'approved'].includes(transfer.status)) return res.status(400).json({ success: false, message: 'A dispatched transfer cannot be cancelled' });
    transfer.status = 'cancelled'; transfer.notes = [transfer.notes, req.body.reason].filter(Boolean).join('\n');
    await transfer.save();
    res.json({ success: true, transfer });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
};
