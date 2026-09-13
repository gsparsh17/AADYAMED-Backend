const mongoose = require('mongoose');
const PurchaseOrder = require('../models/PurchaseOrder');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const Supplier = require('../models/Supplier');
const StockAdjustment = require('../models/StockAdjustment');
const { scopedFilter, scopedPayload } = require('../utils/tenantScope');

function normalizeItem(item = {}) {
  return {
    medicineId: item.medicineId || item.medicine_id,
    quantity: Number(item.quantity || 0),
    purchasePrice: Number(item.purchasePrice ?? item.unit_cost ?? item.purchase_price ?? 0),
    sellingPrice: Number(item.sellingPrice ?? item.selling_price ?? 0) || undefined,
    batchNumber: item.batchNumber || item.batch_number,
    expiryDate: item.expiryDate || item.expiry_date,
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
      });
    }

    const tax = Number((subtotal * 0.18).toFixed(2));
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

    let totalReceived = 0;
    let totalDamaged = 0;
    for (const receivedItem of receivedItems) {
      const orderItem = purchaseOrder.items.id(receivedItem.itemId);
      if (!orderItem) return res.status(400).json({ success: false, message: `Purchase order item ${receivedItem.itemId} not found` });

      const previouslyReceived = Number(orderItem.receivedQuantity || 0);
      const remainingOrdered = Math.max(0, Number(orderItem.quantity) - previouslyReceived);
      const receivedQty = Number(receivedItem.quantity || 0);
      const damagedQty = Number(damagedItems.find(d => String(d.itemId) === String(receivedItem.itemId))?.quantity || 0);
      if (receivedQty <= 0 || receivedQty > remainingOrdered) {
        return res.status(400).json({ success: false, message: `Invalid received quantity for ${orderItem.medicineName}. Remaining: ${remainingOrdered}` });
      }
      if (damagedQty < 0 || damagedQty > receivedQty) {
        return res.status(400).json({ success: false, message: `Invalid damaged quantity for ${orderItem.medicineName}` });
      }
      if (!receivedItem.expiryDate) return res.status(400).json({ success: false, message: `Expiry date is required for ${orderItem.medicineName}` });

      const medicine = await Medicine.findOne(scopedFilter(req, { _id: orderItem.medicineId }));
      if (!medicine) return res.status(400).json({ success: false, message: `Medicine ${orderItem.medicineName} is not in the selected store` });

      const stockQty = receivedQty - damagedQty;
      const batchNumber = receivedItem.batchNumber || orderItem.batchNumber || `BATCH-${Date.now()}-${medicine._id.toString().slice(-4)}`;
      let batch = await MedicineBatch.findOne(scopedFilter(req, { medicineId: medicine._id, batchNumber }));
      if (batch) {
        batch.quantity += stockQty;
        batch.availableQuantity += stockQty;
        batch.expiryDate = receivedItem.expiryDate;
        batch.purchasePrice = orderItem.purchasePrice;
        batch.sellingPrice = receivedItem.sellingPrice || orderItem.sellingPrice || medicine.sellingPrice;
        batch.supplierInvoice = receivedItem.invoiceNumber || batch.supplierInvoice;
        batch.isActive = batch.availableQuantity > 0;
        await batch.save();
      } else {
        batch = await MedicineBatch.create(scopedPayload(req, {
          medicineId: medicine._id,
          batchNumber,
          quantity: stockQty,
          availableQuantity: stockQty,
          purchasePrice: orderItem.purchasePrice,
          sellingPrice: receivedItem.sellingPrice || orderItem.sellingPrice || medicine.sellingPrice,
          expiryDate: receivedItem.expiryDate,
          manufactureDate: receivedItem.manufactureDate || new Date(),
          supplierId: purchaseOrder.supplierId,
          supplierInvoice: receivedItem.invoiceNumber,
          addedBy: req.user.id,
        }));
      }

      const previousQuantity = Number(medicine.quantity || 0);
      medicine.quantity = previousQuantity + stockQty;
      await medicine.save();

      if (stockQty > 0) {
        await StockAdjustment.create(scopedPayload(req, {
          medicineId: medicine._id,
          batchId: batch._id,
          previousQuantity,
          adjustmentQuantity: stockQty,
          newQuantity: medicine.quantity,
          adjustmentType: 'addition',
          reason: 'Purchase order received',
          referenceType: 'purchase',
          referenceId: purchaseOrder._id,
          adjustedBy: req.user.id,
        }));
      }

      orderItem.receivedQuantity = previouslyReceived + receivedQty;
      orderItem.damagedQuantity = Number(orderItem.damagedQuantity || 0) + damagedQty;
      orderItem.batchNumber = batchNumber;
      orderItem.expiryDate = receivedItem.expiryDate;
      totalReceived += stockQty;
      totalDamaged += damagedQty;
    }

    const totalOrdered = purchaseOrder.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const totalReceivedSoFar = purchaseOrder.items.reduce((sum, item) => sum + Number(item.receivedQuantity || 0), 0);
    if (totalReceivedSoFar === 0) purchaseOrder.status = 'ordered';
    else if (totalReceivedSoFar < totalOrdered) purchaseOrder.status = 'partially_received';
    else {
      purchaseOrder.status = 'received';
      purchaseOrder.receivedDate = new Date();
    }

    purchaseOrder.receivedBy = req.user.id;
    if (notes) purchaseOrder.notes = notes;
    await purchaseOrder.save();

    res.json({ success: true, purchaseOrder: legacyPurchaseOrder(purchaseOrder), summary: { totalReceived, totalDamaged, totalOrdered } });
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
