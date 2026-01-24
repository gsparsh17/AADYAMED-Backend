const Supplier = require('../models/Supplier');
const PurchaseOrder = require('../models/PurchaseOrder');

exports.createSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.create({
      ...req.body,
      addedBy: req.user.id
    });
    
    res.status(201).json({ success: true, supplier });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getAllSuppliers = async (req, res) => {
  try {
    const { 
      search, 
      isActive, 
      page = 1, 
      limit = 20 
    } = req.query;
    
    const filter = {};
    if (search) {
      filter.$text = { $search: search };
    }
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    
    const suppliers = await Supplier.find(filter)
      .sort({ name: 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await Supplier.countDocuments(filter);
    
    res.json({
      success: true,
      suppliers,
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

exports.getSupplierById = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    
    if (!supplier) {
      return res.status(404).json({ message: 'Supplier not found' });
    }
    
    // Get purchase orders
    const purchaseOrders = await PurchaseOrder.find({ 
      supplierId: supplier._id 
    })
    .sort({ orderDate: -1 })
    .limit(10);
    
    // Calculate total purchases
    const purchaseStats = await PurchaseOrder.aggregate([
      { $match: { supplierId: supplier._id, status: { $ne: 'cancelled' } } },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalAmount: { $sum: '$totalAmount' },
          paidAmount: { $sum: '$paidAmount' }
        }
      }
    ]);
    
    res.json({ 
      success: true, 
      supplier, 
      purchaseOrders,
      stats: purchaseStats[0] || { totalOrders: 0, totalAmount: 0, paidAmount: 0 }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!supplier) {
      return res.status(404).json({ message: 'Supplier not found' });
    }
    
    res.json({ success: true, supplier });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};