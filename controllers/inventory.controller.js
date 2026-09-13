const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const StockAdjustment = require('../models/StockAdjustment');
const PurchaseOrder = require('../models/PurchaseOrder');
const PharmacySale = require('../models/PharmacySale');
const Supplier = require('../models/Supplier');
const { scopedFilter } = require('../utils/tenantScope');

const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

exports.getDashboard = async (req, res) => {
  try {
    const now = new Date();
    const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
    const endToday = new Date(startToday); endToday.setDate(endToday.getDate() + 1);
    const expiryLimit = new Date(now); expiryLimit.setDate(expiryLimit.getDate() + Number(req.tenant.store?.settings?.expiryAlertDays || 30));

    const [totalMedicines, lowStock, expiredBatches, expiringBatches, pendingOrders, activeSuppliers, todayRows, recentSales, recentAdjustments] = await Promise.all([
      Medicine.countDocuments(scopedFilter(req, { isActive: true })),
      Medicine.countDocuments(scopedFilter(req, { isActive: true, $expr: { $lte: ['$quantity', '$reorderLevel'] } })),
      MedicineBatch.countDocuments(scopedFilter(req, { availableQuantity: { $gt: 0 }, expiryDate: { $lt: now } })),
      MedicineBatch.countDocuments(scopedFilter(req, { availableQuantity: { $gt: 0 }, expiryDate: { $gte: now, $lte: expiryLimit } })),
      PurchaseOrder.countDocuments(scopedFilter(req, { status: { $in: ['draft', 'pending', 'approved', 'ordered', 'partially_received'] } })),
      Supplier.countDocuments(scopedFilter(req, { isActive: true })),
      PharmacySale.aggregate([
        { $match: scopedFilter(req, { saleDate: { $gte: startToday, $lt: endToday }, status: { $in: ['dispensed', 'partially_returned', 'returned'] } }) },
        { $group: { _id: null, revenue: { $sum: { $subtract: ['$totalAmount', { $ifNull: ['$returnedAmount', 0] }] } }, grossProfit: { $sum: '$grossProfit' }, transactions: { $sum: 1 } } },
      ]),
      PharmacySale.find(scopedFilter(req, { status: { $in: ['dispensed', 'partially_returned', 'returned'] } })).sort({ saleDate: -1 }).limit(8).select('saleNumber invoiceNumber customerName totalAmount returnedAmount saleDate paymentMethod status'),
      StockAdjustment.find(scopedFilter(req)).populate('medicineId', 'medicineName').populate('batchId', 'batchNumber').populate('adjustedBy', 'name').sort({ createdAt: -1 }).limit(8),
    ]);

    const [valuation] = await MedicineBatch.aggregate([
      { $match: scopedFilter(req, { availableQuantity: { $gt: 0 }, expiryDate: { $gte: now } }) },
      { $group: { _id: null, costValue: { $sum: { $multiply: ['$availableQuantity', '$purchasePrice'] } }, retailValue: { $sum: { $multiply: ['$availableQuantity', '$sellingPrice'] } }, units: { $sum: '$availableQuantity' } } },
    ]);

    res.json({
      success: true,
      stats: {
        totalMedicines,
        lowStock,
        expiredBatches,
        expiringBatches,
        pendingOrders,
        activeSuppliers,
        todayRevenue: money(todayRows[0]?.revenue),
        todayGrossProfit: money(todayRows[0]?.grossProfit),
        todayTransactions: todayRows[0]?.transactions || 0,
        inventoryCostValue: money(valuation?.costValue),
        inventoryRetailValue: money(valuation?.retailValue),
        inventoryUnits: valuation?.units || 0,
      },
      recentSales,
      recentAdjustments,
      store: req.tenant.store,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.getValuation = async (req, res) => {
  try {
    const now = new Date();
    const rows = await MedicineBatch.aggregate([
      { $match: scopedFilter(req, { availableQuantity: { $gt: 0 } }) },
      { $lookup: { from: 'medicines', localField: 'medicineId', foreignField: '_id', as: 'medicine' } },
      { $unwind: '$medicine' },
      { $project: {
        medicineId: 1, batchNumber: 1, expiryDate: 1, availableQuantity: 1, purchasePrice: 1, sellingPrice: 1,
        medicineName: '$medicine.medicineName', category: '$medicine.category',
        expired: { $lt: ['$expiryDate', now] },
        costValue: { $multiply: ['$availableQuantity', '$purchasePrice'] },
        retailValue: { $multiply: ['$availableQuantity', '$sellingPrice'] },
      } },
      { $sort: { medicineName: 1, expiryDate: 1 } },
    ]);
    const totals = rows.reduce((acc, row) => {
      acc.units += Number(row.availableQuantity || 0);
      acc.costValue += Number(row.costValue || 0);
      acc.retailValue += Number(row.retailValue || 0);
      if (row.expired) acc.expiredCostValue += Number(row.costValue || 0);
      return acc;
    }, { units: 0, costValue: 0, retailValue: 0, expiredCostValue: 0 });
    Object.keys(totals).filter(k => k !== 'units').forEach(k => { totals[k] = money(totals[k]); });
    res.json({ success: true, rows, totals });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.getLedger = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const filter = scopedFilter(req);
    if (req.query.medicineId) filter.medicineId = req.query.medicineId;
    if (req.query.batchId) filter.batchId = req.query.batchId;
    if (req.query.adjustmentType) filter.adjustmentType = req.query.adjustmentType;
    if (req.query.startDate || req.query.endDate) {
      filter.createdAt = {};
      if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate);
      if (req.query.endDate) filter.createdAt.$lte = new Date(req.query.endDate);
    }
    const [entries, total] = await Promise.all([
      StockAdjustment.find(filter).populate('medicineId', 'medicineName genericName').populate('batchId', 'batchNumber expiryDate').populate('adjustedBy', 'name email').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      StockAdjustment.countDocuments(filter),
    ]);
    res.json({ success: true, entries, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.getProfitLoss = async (req, res) => {
  try {
    const end = req.query.endDate ? new Date(req.query.endDate) : new Date();
    const start = req.query.startDate ? new Date(req.query.startDate) : new Date(end.getFullYear(), end.getMonth(), 1);
    const match = scopedFilter(req, { saleDate: { $gte: start, $lte: end }, status: { $in: ['dispensed', 'partially_returned', 'returned'] } });
    const [row] = await PharmacySale.aggregate([
      { $match: match },
      { $group: { _id: null, grossSales: { $sum: '$totalAmount' }, returns: { $sum: { $ifNull: ['$returnedAmount', 0] } }, taxCollected: { $sum: { $subtract: ['$tax', { $ifNull: ['$returnedTax', 0] }] } }, costOfGoods: { $sum: '$costOfGoods' }, storedGrossProfit: { $sum: '$grossProfit' }, transactions: { $sum: 1 } } },
    ]);
    const result = row || { grossSales: 0, returns: 0, taxCollected: 0, costOfGoods: 0, storedGrossProfit: 0, transactions: 0 };
    result.netSales = money(result.grossSales - result.returns);
    result.grossProfit = money(result.netSales - result.taxCollected - result.costOfGoods);
    res.json({ success: true, startDate: start, endDate: end, ...result });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};
