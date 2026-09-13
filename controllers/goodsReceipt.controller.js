const GoodsReceipt = require('../models/GoodsReceipt');
const { scopedFilter } = require('../utils/tenantScope');

exports.listGoodsReceipts = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const filter = scopedFilter(req);
    if (req.query.purchaseOrderId) filter.purchaseOrderId = req.query.purchaseOrderId;
    if (req.query.supplierId) filter.supplierId = req.query.supplierId;
    if (req.query.startDate || req.query.endDate) {
      filter.receivedDate = {};
      if (req.query.startDate) filter.receivedDate.$gte = new Date(req.query.startDate);
      if (req.query.endDate) filter.receivedDate.$lte = new Date(req.query.endDate);
    }
    const [grns, total] = await Promise.all([
      GoodsReceipt.find(filter)
        .populate('purchaseOrderId', 'orderNumber status')
        .populate('supplierId', 'name companyName')
        .populate('receivedBy', 'name email')
        .sort({ receivedDate: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      GoodsReceipt.countDocuments(filter),
    ]);
    res.json({ success: true, grns, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.getGoodsReceipt = async (req, res) => {
  try {
    const grn = await GoodsReceipt.findOne(scopedFilter(req, { _id: req.params.id }))
      .populate('purchaseOrderId')
      .populate('supplierId')
      .populate('items.medicineId', 'medicineName genericName hsnCode')
      .populate('items.batchId', 'batchNumber expiryDate')
      .populate('receivedBy', 'name email');
    if (!grn) return res.status(404).json({ success: false, message: 'GRN not found' });
    res.json({ success: true, grn });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};
