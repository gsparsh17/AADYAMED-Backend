const mongoose = require('mongoose');
const PurchaseOrder = require('../models/PurchaseOrder');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const Supplier = require('../models/Supplier');
const GoodsReceipt = require('../models/GoodsReceipt');
const { scopedFilter, scopedPayload } = require('../utils/tenantScope');
const { scopeFromRequest, addToBatch, deductFromSpecificBatch } = require('../services/inventory.service');

function normalizeItem(item = {}) {
  return {
    medicineId: item.medicineId || item.medicine_id,
    quantity: Number(item.quantity || 0),
    purchasePrice: Number(item.purchasePrice ?? item.unit_cost ?? item.purchase_price ?? 0),
    sellingPrice: Number(item.sellingPrice ?? item.selling_price ?? 0) || undefined,
    batchNumber: item.batchNumber || item.batch_number,
    expiryDate: item.expiryDate || item.expiry_date,
    mrp: Number(item.mrp || 0) || undefined,
    taxRate: Number(item.taxRate ?? item.tax_rate ?? 0) || 0,
  };
}

function normalizeReceiveItem(item = {}) {
  return {
    itemId: item.itemId || item.item_id || item._id,
    quantity: Number(item.quantity ?? item.quantityReceived ?? item.quantity_received ?? 0),
    batchNumber: item.batchNumber || item.batch_number,
    expiryDate: item.expiryDate || item.expiry_date,
    manufactureDate: item.manufactureDate || item.manufacture_date,
    invoiceNumber: item.invoiceNumber || item.invoice_number,
    sellingPrice: Number(item.sellingPrice ?? item.selling_price ?? 0) || undefined,
  };
}

function legacyPurchaseOrder(order) {
  if (!order) return order;
  const obj = typeof order.toObject === 'function' ? order.toObject() : { ...order };
  obj.order_number = obj.orderNumber;
  obj.supplier_id = obj.supplierId;
  obj.order_date = obj.orderDate;
  obj.expected_delivery = obj.expectedDeliveryDate;
  obj.received_date = obj.receivedDate;
  obj.total_amount = obj.totalAmount;
  obj.paid_amount = obj.paidAmount;
  obj.payment_status = obj.paymentStatus;
  obj.store_id = obj.storeId;
  obj.organization_id = obj.organizationId;
  obj.items = (obj.items || []).map((item) => ({
    ...item,
    medicine_id: item.medicineId,
    medicine_name: item.medicineName,
    unit_cost: item.purchasePrice,
    selling_price: item.sellingPrice,
    received: item.receivedQuantity,
    received_quantity: item.receivedQuantity,
    damaged_quantity: item.damagedQuantity,
    batch_number: item.batchNumber,
    expiry_date: item.expiryDate,
  }));
  return obj;
}

exports.createPurchaseOrder = async (req, res) => {
  try {
    const supplierId = req.body.supplierId || req.body.supplier_id;
    const expectedDeliveryDate = req.body.expectedDeliveryDate || req.body.expected_delivery;
    const notes = req.body.notes;
    const items = Array.isArray(req.body.items) ? req.body.items.map(normalizeItem) : [];

    if (!supplierId || !mongoose.isValidObjectId(supplierId)) {
      return res.status(400).json({ success: false, message: 'Valid supplier is required' });
    }
    if (!items.length) return res.status(400).json({ success: false, message: 'At least one purchase item is required' });

    const supplier = await Supplier.findOne(scopedFilter(req, { _id: supplierId, isActive: true }));
    if (!supplier) return res.status(400).json({ success: false, message: 'Supplier does not belong to the selected store' });

    let subtotal = 0;
    const validatedItems = [];
    for (const item of items) {
      if (!item.medicineId || !mongoose.isValidObjectId(item.medicineId) || item.quantity <= 0 || item.purchasePrice < 0) {
        return res.status(400).json({ success: false, message: 'Invalid medicine, quantity or purchase price' });
      }
      const medicine = await Medicine.findOne(scopedFilter(req, { _id: item.medicineId, isActive: true }));
      if (!medicine) return res.status(400).json({ success: false, message: `Medicine ${item.medicineId} is not in the selected store` });

      subtotal += item.quantity * item.purchasePrice;
      validatedItems.push({
        medicineId: medicine._id,
        medicineName: medicine.medicineName,
        quantity: item.quantity,
        unit: medicine.unit,
        purchasePrice: item.purchasePrice,
        sellingPrice: item.sellingPrice || medicine.sellingPrice,
        batchNumber: item.batchNumber,
        expiryDate: item.expiryDate,
        mrp: item.mrp,
        taxRate: item.taxRate || medicine.taxRate || 0,
        taxAmount: Number(((item.quantity * item.purchasePrice) * (item.taxRate || medicine.taxRate || 0) / 100).toFixed(2)),
      });
    }

    const tax = Number(validatedItems.reduce((sum, item) => sum + Number(item.taxAmount || 0), 0).toFixed(2));
    const totalAmount = Number((subtotal + tax).toFixed(2));
    const purchaseOrder = await PurchaseOrder.create(scopedPayload(req, {
      supplierId,
      items: validatedItems,
      expectedDeliveryDate,
      subtotal,
      tax,
      totalAmount,
      notes,
      status: 'draft',
      createdBy: req.user.id,
    }));

    res.status(201).json({ success: true, purchaseOrder: legacyPurchaseOrder(purchaseOrder) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.getAllPurchaseOrders = async (req, res) => {
  try {
    const { status, startDate, endDate, page = 1, limit = 20 } = req.query;
    const supplierId = req.query.supplierId || req.query.supplier_id || req.query.supplier;
    const filter = scopedFilter(req);
    if (status) filter.status = status;
    if (supplierId) filter.supplierId = supplierId;
    if (startDate || endDate) {
      filter.orderDate = {};
      if (startDate) filter.orderDate.$gte = new Date(startDate);
      if (endDate) filter.orderDate.$lte = new Date(endDate);
    }

    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));
    const purchaseOrders = await PurchaseOrder.find(filter)
      .populate('supplierId', 'name companyName phone')
      .populate('createdBy', 'name email')
      .sort({ orderDate: -1 })
      .skip((pageNumber - 1) * pageSize)
      .limit(pageSize);
    const total = await PurchaseOrder.countDocuments(filter);
    const normalized = purchaseOrders.map(legacyPurchaseOrder);

    res.json({
      success: true,
      purchaseOrders: normalized,
      orders: normalized,
      pagination: { page: pageNumber, limit: pageSize, total, pages: Math.ceil(total / pageSize) },
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.getPurchaseOrderById = async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrder.findOne(scopedFilter(req, { _id: req.params.id }))
      .populate('supplierId', 'name companyName phone email address')
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email')
      .populate('receivedBy', 'name email');
    if (!purchaseOrder) return res.status(404).json({ success: false, message: 'Purchase order not found in the selected store' });

    const normalized = legacyPurchaseOrder(purchaseOrder);
    res.json({ success: true, purchaseOrder: normalized, order: normalized });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.approvePurchaseOrder = async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrder.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!purchaseOrder) return res.status(404).json({ success: false, message: 'Purchase order not found in the selected store' });
    if (!['draft', 'pending'].includes(purchaseOrder.status)) {
      return res.status(400).json({ success: false, message: 'Only draft or pending orders can be approved' });
    }
    purchaseOrder.status = 'approved';
    purchaseOrder.approvedBy = req.user.id;
    await purchaseOrder.save();
    res.json({ success: true, purchaseOrder: legacyPurchaseOrder(purchaseOrder) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.receivePurchaseOrder = async (req, res) => {
  const appliedStocks = [];
  let createdGrn = null;
  try {
    const receivedItems = (req.body.receivedItems || req.body.received_items || []).map(normalizeReceiveItem);
    const damagedItems = (req.body.damagedItems || req.body.damaged_items || []).map(normalizeReceiveItem);
    const { notes } = req.body;
    if (!receivedItems.length) return res.status(400).json({ success: false, message: 'At least one received item is required' });

    const purchaseOrder = await PurchaseOrder.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!purchaseOrder) return res.status(404).json({ success: false, message: 'Purchase order not found in the selected store' });
    if (!['approved', 'ordered', 'partially_received'].includes(purchaseOrder.status)) {
      return res.status(400).json({ success: false, message: 'Order must be approved or ordered before receiving stock' });
    }

    // Validate the complete GRN before mutating stock. This prevents a bad later
    // line from leaving earlier PO lines partially received.
    const seen = new Set();
    const plans = [];
    for (const receivedItem of receivedItems) {
      if (!receivedItem.itemId || seen.has(String(receivedItem.itemId))) {
        return res.status(400).json({ success: false, message: 'Each purchase-order item may appear only once per GRN' });
      }
      seen.add(String(receivedItem.itemId));
      const orderItem = purchaseOrder.items.id(receivedItem.itemId);
      if (!orderItem) return res.status(400).json({ success: false, message: `Purchase order item ${receivedItem.itemId} not found` });
      const previouslyReceived = Number(orderItem.receivedQuantity || 0);
      const remainingOrdered = Math.max(0, Number(orderItem.quantity) - previouslyReceived);
      const receivedQty = Number(receivedItem.quantity || 0);
      const damagedQty = Number(damagedItems.find(d => String(d.itemId) === String(receivedItem.itemId))?.quantity || 0);
      if (receivedQty <= 0 || receivedQty > remainingOrdered) return res.status(400).json({ success: false, message: `Invalid received quantity for ${orderItem.medicineName}. Remaining: ${remainingOrdered}` });
      if (damagedQty < 0 || damagedQty > receivedQty) return res.status(400).json({ success: false, message: `Invalid damaged quantity for ${orderItem.medicineName}` });
      if (!receivedItem.expiryDate || Number.isNaN(new Date(receivedItem.expiryDate).getTime())) return res.status(400).json({ success: false, message: `Valid expiry date is required for ${orderItem.medicineName}` });
      if (new Date(receivedItem.expiryDate) <= new Date()) return res.status(400).json({ success: false, message: `Expired stock cannot be received for ${orderItem.medicineName}` });

      const medicine = await Medicine.findOne(scopedFilter(req, { _id: orderItem.medicineId }));
      if (!medicine) return res.status(400).json({ success: false, message: `Medicine ${orderItem.medicineName} is not in the selected store` });
      const acceptedQty = receivedQty - damagedQty;
      const batchNumber = receivedItem.batchNumber || orderItem.batchNumber || `BATCH-${Date.now()}-${medicine._id.toString().slice(-4)}`;
      plans.push({ orderItem, medicine, receivedItem, receivedQty, damagedQty, acceptedQty, batchNumber, previouslyReceived });
    }

    const scope = scopeFromRequest(req);
    const grnItems = [];
    let totalReceived = 0;
    let totalDamaged = 0;
    let acceptedValue = 0;
    let damagedValue = 0;

    for (const plan of plans) {
      const { orderItem, medicine, receivedItem, receivedQty, damagedQty, acceptedQty, batchNumber, previouslyReceived } = plan;
      let batch = null;
      let createdBatch = false;
      if (acceptedQty > 0) {
        batch = await MedicineBatch.findOne(scopedFilter(req, { medicineId: medicine._id, batchNumber }));
        createdBatch = !batch;
        if (!batch) {
          batch = await MedicineBatch.create(scopedPayload(req, {
            medicineId: medicine._id,
            batchNumber,
            quantity: 0,
            availableQuantity: 0,
            purchasePrice: orderItem.purchasePrice,
            sellingPrice: receivedItem.sellingPrice || orderItem.sellingPrice || medicine.sellingPrice,
            mrp: orderItem.mrp,
            expiryDate: receivedItem.expiryDate,
            manufactureDate: receivedItem.manufactureDate || new Date(),
            supplierId: purchaseOrder.supplierId,
            supplierInvoice: receivedItem.invoiceNumber,
            addedBy: req.user.id,
          }));
        }
        await addToBatch({ scope, medicineId: medicine._id, batchId: batch._id, quantity: acceptedQty, actorId: req.user.id, adjustmentType: 'addition', reason: `GRN for ${purchaseOrder.orderNumber}`, referenceType: 'grn', referenceId: purchaseOrder._id });
        appliedStocks.push({ medicineId: medicine._id, batchId: batch._id, quantity: acceptedQty, createdBatch });
        batch.quantity = Number(batch.quantity || 0) + acceptedQty;
        batch.expiryDate = receivedItem.expiryDate;
        batch.purchasePrice = orderItem.purchasePrice;
        batch.sellingPrice = receivedItem.sellingPrice || orderItem.sellingPrice || medicine.sellingPrice;
        batch.mrp = orderItem.mrp || batch.mrp;
        batch.supplierId = purchaseOrder.supplierId;
        batch.supplierInvoice = receivedItem.invoiceNumber || req.body.supplierInvoiceNumber || req.body.supplier_invoice_number || batch.supplierInvoice;
        await batch.save();
      }

      orderItem.receivedQuantity = previouslyReceived + receivedQty;
      orderItem.damagedQuantity = Number(orderItem.damagedQuantity || 0) + damagedQty;
      orderItem.batchNumber = batchNumber;
      orderItem.expiryDate = receivedItem.expiryDate;
      totalReceived += acceptedQty;
      totalDamaged += damagedQty;
      acceptedValue += acceptedQty * Number(orderItem.purchasePrice || 0);
      damagedValue += damagedQty * Number(orderItem.purchasePrice || 0);
      grnItems.push({
        purchaseOrderItemId: orderItem._id,
        medicineId: medicine._id,
        medicineName: medicine.medicineName,
        batchId: batch?._id,
        batchNumber,
        orderedQuantity: orderItem.quantity,
        receivedQuantity: receivedQty,
        acceptedQuantity: acceptedQty,
        damagedQuantity: damagedQty,
        purchasePrice: orderItem.purchasePrice,
        sellingPrice: receivedItem.sellingPrice || orderItem.sellingPrice || medicine.sellingPrice,
        mrp: orderItem.mrp,
        taxRate: orderItem.taxRate || 0,
        expiryDate: receivedItem.expiryDate,
        manufactureDate: receivedItem.manufactureDate || new Date(),
      });
    }

    createdGrn = await GoodsReceipt.create(scopedPayload(req, {
      purchaseOrderId: purchaseOrder._id,
      supplierId: purchaseOrder.supplierId,
      supplierInvoiceNumber: req.body.supplierInvoiceNumber || req.body.supplier_invoice_number || receivedItems[0]?.invoiceNumber,
      supplierInvoiceDate: req.body.supplierInvoiceDate || req.body.supplier_invoice_date,
      items: grnItems,
      acceptedValue: Number(acceptedValue.toFixed(2)),
      damagedValue: Number(damagedValue.toFixed(2)),
      notes,
      receivedBy: req.user.id,
    }));

    purchaseOrder.grnIds.push(createdGrn._id);
    const totalOrdered = purchaseOrder.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const totalReceivedSoFar = purchaseOrder.items.reduce((sum, item) => sum + Number(item.receivedQuantity || 0), 0);
    purchaseOrder.status = totalReceivedSoFar < totalOrdered ? 'partially_received' : 'received';
    if (purchaseOrder.status === 'received') purchaseOrder.receivedDate = new Date();
    purchaseOrder.receivedBy = req.user.id;
    if (notes) purchaseOrder.notes = notes;
    await purchaseOrder.save();

    res.json({ success: true, purchaseOrder: legacyPurchaseOrder(purchaseOrder), grn: createdGrn, summary: { totalReceived, totalDamaged, totalOrdered } });
  } catch (error) {
    // Compensate any stock added before a later batch/GRN/PO write failed.
    if (req.tenant && appliedStocks.length) {
      const scope = scopeFromRequest(req);
      for (const stock of appliedStocks.reverse()) {
        try {
          await deductFromSpecificBatch({ scope, medicineId: stock.medicineId, batchId: stock.batchId, quantity: stock.quantity, actorId: req.user.id, adjustmentType: 'deduction', reason: 'Rollback failed GRN', referenceType: 'grn', referenceId: req.params.id });
          await MedicineBatch.updateOne(scopedFilter(req, { _id: stock.batchId }), { $inc: { quantity: -stock.quantity } });
          if (stock.createdBatch) {
            const current = await MedicineBatch.findOne(scopedFilter(req, { _id: stock.batchId }));
            if (current && Number(current.quantity || 0) <= 0 && Number(current.availableQuantity || 0) <= 0) await current.deleteOne();
          }
        } catch (rollbackError) {
          console.error('GRN stock rollback failed:', rollbackError);
        }
      }
    }
    if (createdGrn?._id) {
      try { await GoodsReceipt.deleteOne({ _id: createdGrn._id }); } catch (cleanupError) { console.error('GRN cleanup failed:', cleanupError); }
    }
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.getPurchaseOrderGrns = async (req, res) => {
  try {
    const order = await PurchaseOrder.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!order) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    const grns = await GoodsReceipt.find(scopedFilter(req, { purchaseOrderId: order._id })).populate('receivedBy', 'name email').sort({ receivedDate: -1 });
    res.json({ success: true, grns });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.getPurchaseOrderStats = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const supplierId = req.query.supplierId || req.query.supplier_id || req.query.supplier;
    const matchStage = scopedFilter(req, { status: { $ne: 'cancelled' } });
    if (startDate || endDate) {
      matchStage.orderDate = {};
      if (startDate) matchStage.orderDate.$gte = new Date(startDate);
      if (endDate) matchStage.orderDate.$lte = new Date(endDate);
    }
    if (supplierId && mongoose.isValidObjectId(supplierId)) matchStage.supplierId = new mongoose.Types.ObjectId(supplierId);

    const [stats, topSuppliers, totals] = await Promise.all([
      PurchaseOrder.aggregate([
        { $match: matchStage },
        { $group: { _id: { month: { $month: '$orderDate' }, year: { $year: '$orderDate' } }, totalOrders: { $sum: 1 }, totalAmount: { $sum: '$totalAmount' }, averageOrderValue: { $avg: '$totalAmount' } } },
        { $sort: { '_id.year': -1, '_id.month': -1 } },
      ]),
      PurchaseOrder.aggregate([
        { $match: matchStage },
        { $group: { _id: '$supplierId', totalOrders: { $sum: 1 }, totalAmount: { $sum: '$totalAmount' } } },
        { $sort: { totalAmount: -1 } },
        { $limit: 5 },
      ]),
      PurchaseOrder.aggregate([
        { $match: matchStage },
        { $group: { _id: null, totalOrders: { $sum: 1 }, totalAmount: { $sum: '$totalAmount' } } },
      ]),
    ]);

    for (const supplier of topSuppliers) {
      const details = await Supplier.findOne(scopedFilter(req, { _id: supplier._id })).select('name');
      supplier.supplierName = details?.name || 'Unknown';
    }

    res.json({ success: true, stats, topSuppliers, summary: totals[0] || { totalOrders: 0, totalAmount: 0 } });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.markPurchaseOrderOrdered = async (req, res) => {
  try {
    const order = await PurchaseOrder.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!order) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    if (order.status !== 'approved') return res.status(400).json({ success: false, message: 'Only approved orders can be marked ordered' });
    order.status = 'ordered';
    await order.save();
    res.json({ success: true, purchaseOrder: legacyPurchaseOrder(order) });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
};

exports.cancelPurchaseOrder = async (req, res) => {
  try {
    const order = await PurchaseOrder.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!order) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    if (['received', 'cancelled', 'returned'].includes(order.status) || order.items.some(item => Number(item.receivedQuantity || 0) > 0)) {
      return res.status(400).json({ success: false, message: 'Received purchase orders cannot be cancelled' });
    }
    order.status = 'cancelled';
    if (req.body.reason) order.notes = [order.notes, `Cancelled: ${req.body.reason}`].filter(Boolean).join('\n');
    await order.save();
    res.json({ success: true, purchaseOrder: legacyPurchaseOrder(order) });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
};

exports.recordPurchasePayment = async (req, res) => {
  try {
    const amount = Number(req.body.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, message: 'A positive payment amount is required' });
    const order = await PurchaseOrder.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!order) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    if (order.status === 'cancelled') return res.status(400).json({ success: false, message: 'Cancelled purchase orders cannot be paid' });
    order.paidAmount = Math.min(Number(order.totalAmount || 0), Number(order.paidAmount || 0) + amount);
    order.paymentStatus = order.paidAmount >= order.totalAmount ? 'paid' : order.paidAmount > 0 ? 'partial' : 'pending';
    order.paymentMethod = req.body.paymentMethod || req.body.payment_method || order.paymentMethod;
    order.paymentDate = new Date();
    await order.save();
    res.json({ success: true, purchaseOrder: legacyPurchaseOrder(order) });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
};
