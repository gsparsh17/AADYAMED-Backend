const PharmacyReturn = require('../models/PharmacyReturn');
const PharmacySale = require('../models/PharmacySale');
const MedicineBatch = require('../models/MedicineBatch');
const { scopedFilter, scopedPayload } = require('../utils/tenantScope');
const { scopeFromRequest, addToBatch, deductFromSpecificBatch } = require('../services/inventory.service');

const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

function allocationsForReturn(saleItem, quantity) {
  // Skip units already returned so repeated/partial returns restore the correct
  // original FEFO batches instead of repeatedly crediting the first batch.
  let skip = Number(saleItem.returnedQuantity || 0);
  let remaining = quantity;
  const allocations = [];
  for (const allocation of saleItem.batchAllocations || []) {
    let available = Number(allocation.quantity || 0);
    if (skip >= available) {
      skip -= available;
      continue;
    }
    available -= skip;
    skip = 0;
    const qty = Math.min(remaining, available);
    if (qty > 0) {
      allocations.push({
        batchId: allocation.batchId,
        quantity: qty,
        purchasePrice: Number(allocation.purchasePrice || 0),
      });
      remaining -= qty;
    }
    if (remaining <= 0) break;
  }
  return { allocations, remaining };
}

exports.createReturn = async (req, res) => {
  let returnDoc = null;
  const appliedRestocks = [];
  try {
    const saleId = req.body.saleId || req.body.sale_id;
    const requestedItems = Array.isArray(req.body.items) ? req.body.items : [];
    if (!saleId || !requestedItems.length) return res.status(400).json({ success: false, message: 'saleId and return items are required' });

    const sale = await PharmacySale.findOne(scopedFilter(req, { _id: saleId }));
    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found in the selected store' });
    if (!['dispensed', 'partially_returned'].includes(sale.status)) {
      return res.status(400).json({ success: false, message: 'Only dispensed sales can be returned' });
    }

    const prepared = [];
    let subtotal = 0;
    let taxRefund = 0;
    let totalRefund = 0;
    let returnedCost = 0;

    for (const requested of requestedItems) {
      const saleItemId = requested.saleItemId || requested.sale_item_id || requested.itemId || requested.item_id;
      const quantity = Number(requested.quantity || 0);
      const saleItem = sale.items.id(saleItemId);
      if (!saleItem || !Number.isFinite(quantity) || quantity <= 0) {
        return res.status(400).json({ success: false, message: 'Invalid sale item or return quantity' });
      }
      const availableToReturn = Number(saleItem.quantity || 0) - Number(saleItem.returnedQuantity || 0);
      if (quantity > availableToReturn) {
        return res.status(409).json({ success: false, message: `Only ${availableToReturn} units of ${saleItem.medicineName} can still be returned` });
      }

      const unitTaxable = saleItem.quantity ? Number(saleItem.taxableAmount || 0) / saleItem.quantity : Number(saleItem.sellingPrice || 0);
      const unitTax = saleItem.quantity ? Number(saleItem.taxAmount || 0) / saleItem.quantity : 0;
      const itemSubtotal = money(unitTaxable * quantity);
      const itemTax = money(unitTax * quantity);
      const itemRefund = money(itemSubtotal + itemTax);
      const restockable = requested.restockable !== false;
      const { allocations, remaining } = allocationsForReturn(saleItem, quantity);

      if (restockable && remaining > 0) {
        return res.status(409).json({ success: false, message: `Original batch allocation is unavailable for ${saleItem.medicineName}; mark it non-restockable or correct the sale` });
      }
      if (restockable) {
        returnedCost = money(returnedCost + allocations.reduce((sum, a) => sum + a.quantity * Number(a.purchasePrice || 0), 0));
      }

      subtotal = money(subtotal + itemSubtotal);
      taxRefund = money(taxRefund + itemTax);
      totalRefund = money(totalRefund + itemRefund);
      prepared.push({ saleItem, quantity, itemSubtotal, itemTax, itemRefund, restockable, allocations, reason: requested.reason });
    }

    returnDoc = await PharmacyReturn.create(scopedPayload(req, {
      saleId: sale._id,
      items: prepared.map(p => ({
        saleItemId: p.saleItem._id,
        medicineId: p.saleItem.medicineId,
        medicineName: p.saleItem.medicineName,
        quantity: p.quantity,
        unitPrice: p.saleItem.sellingPrice,
        taxableAmount: p.itemSubtotal,
        taxAmount: p.itemTax,
        refundAmount: p.itemRefund,
        reason: p.reason,
        restockable: p.restockable,
        batchAllocations: p.allocations.map(a => ({ batchId: a.batchId, quantity: a.quantity })),
      })),
      subtotal,
      taxRefund,
      totalRefund,
      refundMethod: req.body.refundMethod || req.body.refund_method || 'cash',
      refundReference: req.body.refundReference || req.body.refund_reference,
      notes: req.body.notes,
      createdBy: req.user.id,
    }));

    const scope = scopeFromRequest(req);
    // Restore inventory against the return record. Every successful restock is
    // tracked so a later accounting write failure can be compensated.
    for (const p of prepared) {
      if (!p.restockable) continue;
      for (const allocation of p.allocations) {
        const batchExists = await MedicineBatch.exists(scopedFilter(req, { _id: allocation.batchId, medicineId: p.saleItem.medicineId }));
        if (!batchExists) {
          const error = new Error(`Original batch no longer exists for ${p.saleItem.medicineName}`);
          error.statusCode = 409;
          throw error;
        }
        await addToBatch({
          scope,
          medicineId: p.saleItem.medicineId,
          batchId: allocation.batchId,
          quantity: allocation.quantity,
          actorId: req.user.id,
          adjustmentType: 'addition',
          reason: `Sales return ${returnDoc.returnNumber}`,
          referenceType: 'return',
          referenceId: returnDoc._id,
        });
        appliedRestocks.push({ medicineId: p.saleItem.medicineId, batchId: allocation.batchId, quantity: allocation.quantity });
      }
    }

    for (const p of prepared) p.saleItem.returnedQuantity = Number(p.saleItem.returnedQuantity || 0) + p.quantity;
    sale.returnedAmount = money(Number(sale.returnedAmount || 0) + totalRefund);
    sale.returnedSubtotal = money(Number(sale.returnedSubtotal || 0) + subtotal);
    sale.returnedTax = money(Number(sale.returnedTax || 0) + taxRefund);
    sale.returnedCost = money(Number(sale.returnedCost || 0) + returnedCost);
    sale.costOfGoods = money(Math.max(0, Number(sale.costOfGoods || 0) - returnedCost));
    sale.grossProfit = money(Math.max(0, Number(sale.subtotal || 0) - Number(sale.returnedSubtotal || 0)) - sale.costOfGoods);
    const allReturned = sale.items.every(item => Number(item.returnedQuantity || 0) >= Number(item.quantity || 0));
    sale.status = allReturned ? 'returned' : 'partially_returned';
    if (allReturned && sale.paymentStatus === 'paid') sale.paymentStatus = 'refunded';
    await sale.save();

    res.status(201).json({ success: true, return: returnDoc, sale });
  } catch (error) {
    // Compensate inventory if any later return/accounting write failed.
    if (appliedRestocks.length && req.tenant) {
      const scope = scopeFromRequest(req);
      for (const restock of appliedRestocks.reverse()) {
        try {
          await deductFromSpecificBatch({
            scope,
            medicineId: restock.medicineId,
            batchId: restock.batchId,
            quantity: restock.quantity,
            actorId: req.user.id,
            adjustmentType: 'deduction',
            reason: `Rollback failed sales return`,
            referenceType: 'return',
            referenceId: returnDoc?._id,
          });
        } catch (rollbackError) {
          console.error('Sales-return stock rollback failed:', rollbackError);
        }
      }
    }
    if (returnDoc?._id) {
      try { await PharmacyReturn.deleteOne({ _id: returnDoc._id }); } catch (cleanupError) { console.error('Sales-return record cleanup failed:', cleanupError); }
    }
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.listReturns = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const filter = scopedFilter(req);
    if (req.query.saleId) filter.saleId = req.query.saleId;
    const [returns, total] = await Promise.all([
      PharmacyReturn.find(filter).populate('saleId', 'saleNumber invoiceNumber customerName customerPhone').populate('createdBy', 'name email').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      PharmacyReturn.countDocuments(filter),
    ]);
    res.json({ success: true, returns, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.getReturnById = async (req, res) => {
  try {
    const item = await PharmacyReturn.findOne(scopedFilter(req, { _id: req.params.id })).populate('saleId').populate('items.medicineId', 'medicineName genericName').populate('items.batchAllocations.batchId', 'batchNumber expiryDate');
    if (!item) return res.status(404).json({ success: false, message: 'Return not found' });
    res.json({ success: true, return: item });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};
