const Supplier = require('../models/Supplier');
const PurchaseOrder = require('../models/PurchaseOrder');
const { scopedFilter, scopedPayload } = require('../utils/tenantScope');

const sanitizeSupplierPayload = (body = {}) => {
  const payload = { ...body };
  ['organizationId', 'organization_id', 'storeId', 'store_id', 'addedBy'].forEach(key => delete payload[key]);
  return payload;
};

exports.createSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.create(scopedPayload(req, {
      ...sanitizeSupplierPayload(req.body),
      addedBy: req.user.id
    }));
    res.status(201).json({ success: true, supplier });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.getAllSuppliers = async (req, res) => {
  try {
    const { search, isActive, page = 1, limit = 20 } = req.query;
    const filter = scopedFilter(req);
    if (search) filter.$text = { $search: search };
    if (isActive !== undefined) filter.isActive = isActive === 'true';

    const suppliers = await Supplier.find(filter)
      .sort({ name: 1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit));
    const total = await Supplier.countDocuments(filter);

    res.json({
      success: true,
      suppliers,
      pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit)) }
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.getSupplierById = async (req, res) => {
  try {
    const supplier = await Supplier.findOne(scopedFilter(req, { _id: req.params.id }));
    if (!supplier) return res.status(404).json({ message: 'Supplier not found in the selected store' });

    const purchaseOrders = await PurchaseOrder.find(scopedFilter(req, { supplierId: supplier._id }))
      .sort({ orderDate: -1 })
      .limit(10);
    const purchaseStats = await PurchaseOrder.aggregate([
      { $match: scopedFilter(req, { supplierId: supplier._id, status: { $ne: 'cancelled' } }) },
      { $group: { _id: null, totalOrders: { $sum: 1 }, totalAmount: { $sum: '$totalAmount' }, paidAmount: { $sum: '$paidAmount' } } }
    ]);

    res.json({ success: true, supplier, purchaseOrders, stats: purchaseStats[0] || { totalOrders: 0, totalAmount: 0, paidAmount: 0 } });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.updateSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findOneAndUpdate(
      scopedFilter(req, { _id: req.params.id }),
      { $set: sanitizeSupplierPayload(req.body) },
      { new: true, runValidators: true }
    );
    if (!supplier) return res.status(404).json({ message: 'Supplier not found in the selected store' });
    res.json({ success: true, supplier });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};


exports.deleteSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findOneAndUpdate(
      scopedFilter(req, { _id: req.params.id }),
      { isActive: false },
      { new: true }
    );
    if (!supplier) return res.status(404).json({ success: false, message: 'Supplier not found in the selected store' });
    res.json({ success: true, message: 'Supplier deactivated', supplier });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};
