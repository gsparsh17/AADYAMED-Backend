const PurchaseOrder = require('../models/PurchaseOrder');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const Supplier = require('../models/Supplier');
const StockAdjustment = require('../models/StockAdjustment');

exports.createPurchaseOrder = async (req, res) => {
  try {
    const { supplierId, items, expectedDeliveryDate, notes } = req.body;
    
    // Validate supplier
    const supplier = await Supplier.findById(supplierId);
    if (!supplier || !supplier.isActive) {
      return res.status(400).json({ message: 'Invalid supplier' });
    }
    
    // Calculate totals
    let subtotal = 0;
    const validatedItems = [];
    
    for (const item of items) {
      const medicine = await Medicine.findById(item.medicineId);
      if (!medicine) {
        return res.status(400).json({ message: `Medicine ${item.medicineId} not found` });
      }
      
      const itemTotal = item.quantity * item.purchasePrice;
      subtotal += itemTotal;
      
      validatedItems.push({
        medicineId: medicine._id,
        medicineName: medicine.medicineName,
        quantity: item.quantity,
        unit: medicine.unit,
        purchasePrice: item.purchasePrice,
        sellingPrice: medicine.sellingPrice
      });
    }
    
    const tax = subtotal * 0.18; // 18% GST (adjust as needed)
    const totalAmount = subtotal + tax;
    
    const purchaseOrder = await PurchaseOrder.create({
      supplierId,
      items: validatedItems,
      expectedDeliveryDate,
      subtotal,
      tax,
      totalAmount,
      notes,
      status: 'draft',
      createdBy: req.user.id
    });
    
    res.status(201).json({ success: true, purchaseOrder });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getAllPurchaseOrders = async (req, res) => {
  try {
    const { 
      status, 
      supplierId,
      startDate,
      endDate,
      page = 1, 
      limit = 20 
    } = req.query;
    
    const filter = {};
    if (status) filter.status = status;
    if (supplierId) filter.supplierId = supplierId;
    if (startDate && endDate) {
      filter.orderDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const purchaseOrders = await PurchaseOrder.find(filter)
      .populate('supplierId', 'name companyName')
      .populate('createdBy', 'name email')
      .sort({ orderDate: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await PurchaseOrder.countDocuments(filter);
    
    res.json({
      success: true,
      purchaseOrders,
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

exports.approvePurchaseOrder = async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrder.findById(req.params.id);
    
    if (!purchaseOrder) {
      return res.status(404).json({ message: 'Purchase order not found' });
    }
    
    if (purchaseOrder.status !== 'draft') {
      return res.status(400).json({ message: 'Only draft orders can be approved' });
    }
    
    purchaseOrder.status = 'approved';
    purchaseOrder.approvedBy = req.user.id;
    await purchaseOrder.save();
    
    res.json({ success: true, purchaseOrder });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.receivePurchaseOrder = async (req, res) => {
  try {
    const { receivedItems, damagedItems = [], notes } = req.body;
    
    const purchaseOrder = await PurchaseOrder.findById(req.params.id);
    
    if (!purchaseOrder) {
      return res.status(404).json({ message: 'Purchase order not found' });
    }
    
    if (!['approved', 'ordered', 'partially_received'].includes(purchaseOrder.status)) {
      return res.status(400).json({ message: 'Order must be approved or ordered' });
    }
    
    let totalReceived = 0;
    let totalDamaged = 0;
    
    // Process each received item
    for (const receivedItem of receivedItems) {
      const orderItem = purchaseOrder.items.id(receivedItem.itemId);
      if (!orderItem) continue;
      
      const receivedQty = receivedItem.quantity || 0;
      const damagedQty = damagedItems.find(d => d.itemId === receivedItem.itemId)?.quantity || 0;
      
      orderItem.receivedQuantity = receivedQty;
      orderItem.damagedQuantity = damagedQty;
      
      totalReceived += receivedQty;
      totalDamaged += damagedQty;
      
      // Add to stock if received
      if (receivedQty > 0) {
        const medicine = await Medicine.findById(orderItem.medicineId);
        if (medicine) {
          // Create batch
          const batch = await MedicineBatch.create({
            medicineId: medicine._id,
            batchNumber: receivedItem.batchNumber || `BATCH-${Date.now()}`,
            quantity: receivedQty,
            availableQuantity: receivedQty,
            purchasePrice: orderItem.purchasePrice,
            sellingPrice: orderItem.sellingPrice || medicine.sellingPrice,
            expiryDate: receivedItem.expiryDate,
            manufactureDate: receivedItem.manufactureDate || new Date(),
            supplierId: purchaseOrder.supplierId,
            supplierInvoice: receivedItem.invoiceNumber,
            addedBy: req.user.id
          });
          
          // Update medicine quantity
          medicine.quantity += receivedQty;
          await medicine.save();
          
          // Record stock adjustment
          await StockAdjustment.create({
            medicineId: medicine._id,
            batchId: batch._id,
            previousQuantity: medicine.quantity - receivedQty,
            adjustmentQuantity: receivedQty,
            newQuantity: medicine.quantity,
            adjustmentType: 'addition',
            reason: 'Purchase order received',
            referenceType: 'purchase',
            referenceId: purchaseOrder._id,
            adjustedBy: req.user.id
          });
        }
      }
    }
    
    // Update order status
    const totalOrdered = purchaseOrder.items.reduce((sum, item) => sum + item.quantity, 0);
    const totalReceivedSoFar = purchaseOrder.items.reduce((sum, item) => sum + item.receivedQuantity, 0);
    
    if (totalReceivedSoFar === 0) {
      purchaseOrder.status = 'ordered';
    } else if (totalReceivedSoFar < totalOrdered) {
      purchaseOrder.status = 'partially_received';
    } else {
      purchaseOrder.status = 'received';
      purchaseOrder.receivedDate = new Date();
    }
    
    purchaseOrder.receivedBy = req.user.id;
    purchaseOrder.notes = notes || purchaseOrder.notes;
    
    await purchaseOrder.save();
    
    res.json({ 
      success: true, 
      purchaseOrder,
      summary: {
        totalReceived,
        totalDamaged,
        totalOrdered
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getPurchaseOrderStats = async (req, res) => {
  try {
    const { startDate, endDate, supplierId } = req.query;
    
    const matchStage = { status: { $ne: 'cancelled' } };
    if (startDate && endDate) {
      matchStage.orderDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    if (supplierId) matchStage.supplierId = supplierId;
    
    const stats = await PurchaseOrder.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: {
            month: { $month: '$orderDate' },
            year: { $year: '$orderDate' }
          },
          totalOrders: { $sum: 1 },
          totalAmount: { $sum: '$totalAmount' },
          averageOrderValue: { $avg: '$totalAmount' }
        }
      },
      { $sort: { '_id.year': -1, '_id.month': -1 } }
    ]);
    
    // Get top suppliers
    const topSuppliers = await PurchaseOrder.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$supplierId',
          totalOrders: { $sum: 1 },
          totalAmount: { $sum: '$totalAmount' }
        }
      },
      { $sort: { totalAmount: -1 } },
      { $limit: 5 }
    ]);
    
    // Populate supplier names
    for (const supplier of topSuppliers) {
      const supplierDetails = await Supplier.findById(supplier._id).select('name');
      supplier.supplierName = supplierDetails?.name || 'Unknown';
    }
    
    res.json({ success: true, stats, topSuppliers });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};