const path = require('path');
const { Readable } = require('stream');
const ExcelJS = require('exceljs');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const MedicineCatalog = require('../models/MedicineCatalog');
const Supplier = require('../models/Supplier');
const StockAdjustment = require('../models/StockAdjustment');
const { scopedFilter, scopedPayload } = require('../utils/tenantScope');
const { scopeFromRequest, addToBatch, deductFromSpecificBatch } = require('../services/inventory.service');

const BULK_UPLOAD_CATEGORIES = ['tablet', 'capsule', 'syrup', 'injection', 'cream', 'ointment', 'drops', 'inhaler', 'other'];
const BULK_UPLOAD_CATEGORY_UNITS = { tablet: 'tablet', capsule: 'capsule', syrup: 'bottle', injection: 'ml', cream: 'tube', ointment: 'tube', drops: 'bottle', inhaler: 'other', other: 'other' };
const BULK_UPLOAD_MAX_ROWS = 1000;

async function readWorkbookRows(buffer, filename) {
  const workbook = new ExcelJS.Workbook();
  const ext = path.extname(filename || '').toLowerCase();
  let worksheet;
  if (ext === '.csv') {
    worksheet = await workbook.csv.read(Readable.from(buffer));
  } else {
    await workbook.xlsx.load(buffer);
    worksheet = workbook.worksheets[0];
  }
  if (!worksheet) return [];

  const headers = worksheet.getRow(1).values.slice(1).map((h) => String(h || '').trim());
  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = row.values.slice(1);
    const record = {};
    headers.forEach((header, index) => { record[header] = values[index]; });
    const isBlank = Object.values(record).every((v) => v === undefined || v === null || String(v).trim() === '');
    if (!isBlank) rows.push(record);
  });
  return rows;
}

function cellString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

const normalizeMedicinePayload = (body = {}) => {
  const payload = {
    ...body,
    ...(body.name !== undefined && body.medicineName === undefined ? { medicineName: body.name } : {}),
    ...(body.generic_name !== undefined && body.genericName === undefined ? { genericName: body.generic_name } : {}),
    ...(body.brand !== undefined && body.brandName === undefined ? { brandName: body.brand } : {}),
    ...(body.stock_quantity !== undefined && body.quantity === undefined ? { quantity: Number(body.stock_quantity) } : {}),
    ...(body.min_stock_level !== undefined && body.reorderLevel === undefined ? { reorderLevel: Number(body.min_stock_level) } : {}),
    ...(body.price_per_unit !== undefined && body.sellingPrice === undefined ? { sellingPrice: Number(body.price_per_unit) } : {}),
    ...(body.is_active !== undefined && body.isActive === undefined ? { isActive: Boolean(body.is_active) } : {})
  };
  delete payload.organizationId;
  delete payload.organization_id;
  delete payload.storeId;
  delete payload.store_id;
  // Stock is ledger-controlled. Medicine CRUD may not create/update quantity directly.
  delete payload.quantity;
  delete payload.stock_quantity;

  if (!payload.unit && payload.category) {
    const categoryUnits = {
      tablet: 'tablet', capsule: 'capsule', syrup: 'bottle', injection: 'ml',
      cream: 'tube', ointment: 'tube', drops: 'bottle', inhaler: 'other', other: 'other'
    };
    payload.unit = categoryUnits[payload.category] || 'other';
  }
  return payload;
};

const withLegacyMedicineFields = (medicine) => {
  const obj = medicine?.toObject ? medicine.toObject() : { ...medicine };
  return {
    ...obj,
    name: obj.medicineName,
    generic_name: obj.genericName,
    brand: obj.brandName,
    stock_quantity: obj.quantity,
    min_stock_level: obj.reorderLevel,
    price_per_unit: obj.sellingPrice,
    unit_price: obj.sellingPrice,
    purchase_price: obj.purchasePrice,
    requires_prescription: obj.prescriptionRequired,
    prescription_required: obj.prescriptionRequired,
    tax_rate: obj.taxRate,
    price_includes_tax: obj.priceIncludesTax,
    is_active: obj.isActive
  };
};

exports.createMedicine = async (req, res) => {
  try {
    const medicine = await Medicine.create(scopedPayload(req, {
      ...normalizeMedicinePayload(req.body),
      createdBy: req.user.id
    }));
    res.status(201).json({ success: true, medicine: withLegacyMedicineFields(medicine) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.getAllMedicines = async (req, res) => {
  try {
    const { search, category, isActive, is_active, lowStock, page = 1, limit = 20 } = req.query;
    const filter = scopedFilter(req);
    if (search) filter.$text = { $search: search };
    if (category) filter.category = category;
    if (req.query['stock_quantity[gt]'] !== undefined) {
      filter.quantity = { $gt: Number(req.query['stock_quantity[gt]']) || 0 };
    }
    const activeFilter = isActive !== undefined ? isActive : is_active;
    if (activeFilter !== undefined) filter.isActive = activeFilter === 'true';

    const medicines = await Medicine.find(filter)
      .sort({ medicineName: 1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit));

    if (lowStock === 'true') {
      const lowStockMedicines = medicines.filter(med => med.quantity <= med.reorderLevel);
      return res.json({ success: true, medicines: lowStockMedicines.map(withLegacyMedicineFields) });
    }

    const total = await Medicine.countDocuments(filter);
    res.json({
      success: true,
      medicines: medicines.map(withLegacyMedicineFields),
      pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit)) }
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.getMedicineById = async (req, res) => {
  try {
    const medicine = await Medicine.findOne(scopedFilter(req, { _id: req.params.id }))
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email');
    if (!medicine) return res.status(404).json({ message: 'Medicine not found in the selected store' });

    const batches = await MedicineBatch.find(scopedFilter(req, { medicineId: medicine._id, isActive: true }))
      .sort({ expiryDate: 1 });
    const adjustments = await StockAdjustment.find(scopedFilter(req, { medicineId: medicine._id }))
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('adjustedBy', 'name');

    res.json({ success: true, medicine: withLegacyMedicineFields(medicine), batches, adjustments });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.updateMedicine = async (req, res) => {
  try {
    const medicine = await Medicine.findOneAndUpdate(
      scopedFilter(req, { _id: req.params.id }),
      { $set: { ...normalizeMedicinePayload(req.body), updatedBy: req.user.id } },
      { new: true, runValidators: true }
    );
    if (!medicine) return res.status(404).json({ message: 'Medicine not found in the selected store' });
    res.json({ success: true, medicine: withLegacyMedicineFields(medicine) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.deleteMedicine = async (req, res) => {
  try {
    const medicine = await Medicine.findOneAndUpdate(
      scopedFilter(req, { _id: req.params.id }),
      { $set: { isActive: false, updatedBy: req.user.id } },
      { new: true }
    );
    if (!medicine) return res.status(404).json({ message: 'Medicine not found in the selected store' });
    res.json({ success: true, message: 'Medicine deactivated' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.addStock = async (req, res) => {
  let batch = null;
  let stockAdded = 0;
  let medicineIdForRollback = null;
  try {
    const { batchNumber, quantity, purchasePrice, sellingPrice, expiryDate, manufactureDate, supplierId } = req.body;
    const numericQuantity = Number(quantity);
    if (!batchNumber || !expiryDate || !Number.isFinite(numericQuantity) || numericQuantity <= 0) return res.status(400).json({ message: 'batchNumber, expiryDate and a positive quantity are required' });
    if (new Date(expiryDate) <= new Date()) return res.status(400).json({ message: 'Expired stock cannot be added' });
    const medicine = await Medicine.findOne(scopedFilter(req, { _id: req.params.id }));
    medicineIdForRollback = medicine?._id;
    if (!medicine) return res.status(404).json({ message: 'Medicine not found in the selected store' });
    if (supplierId) {
      const supplier = await Supplier.findOne(scopedFilter(req, { _id: supplierId, isActive: true }));
      if (!supplier) return res.status(400).json({ message: 'Supplier does not belong to the selected store' });
    }
    const duplicate = await MedicineBatch.exists(scopedFilter(req, { medicineId: medicine._id, batchNumber }));
    if (duplicate) return res.status(409).json({ message: 'Batch number already exists for this medicine in the selected store' });
    batch = await MedicineBatch.create(scopedPayload(req, { medicineId: medicine._id, batchNumber, quantity: 0, availableQuantity: 0, purchasePrice, sellingPrice: sellingPrice || medicine.sellingPrice, expiryDate, manufactureDate: manufactureDate || new Date(), supplierId, addedBy: req.user.id }));
    await addToBatch({ scope: scopeFromRequest(req), medicineId: medicine._id, batchId: batch._id, quantity: numericQuantity, actorId: req.user.id, adjustmentType: 'addition', reason: req.body.reason || 'Batch stock receipt', referenceType: 'purchase' });
    stockAdded = numericQuantity;
    batch.quantity = numericQuantity;
    await batch.save();
    res.status(201).json({ success: true, batch, medicine: withLegacyMedicineFields(await Medicine.findById(medicine._id)) });
  } catch (error) {
    if (stockAdded > 0 && batch?._id && medicineIdForRollback) {
      try { await deductFromSpecificBatch({ scope: scopeFromRequest(req), medicineId: medicineIdForRollback, batchId: batch._id, quantity: stockAdded, actorId: req.user.id, adjustmentType: 'deduction', reason: 'Rollback failed batch stock receipt', referenceType: 'purchase' }); } catch (rollbackError) { console.error('Medicine stock rollback failed:', rollbackError); }
    }
    if (batch?._id) {
      try {
        const current = await MedicineBatch.findOne(scopedFilter(req, { _id: batch._id }));
        if (current && Number(current.availableQuantity || 0) <= 0) await current.deleteOne();
      } catch (_) {}
    }
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.getLowStockMedicines = async (req, res) => {
  try {
    const threshold = req.query.threshold !== undefined ? Number(req.query.threshold) : null;
    const extra = threshold !== null && Number.isFinite(threshold)
      ? { isActive: true, quantity: { $lte: threshold } }
      : { isActive: true, $expr: { $lte: ['$quantity', '$reorderLevel'] } };
    const medicines = await Medicine.find(scopedFilter(req, extra)).sort({ quantity: 1 });
    res.json({ success: true, medicines: medicines.map(withLegacyMedicineFields) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.searchMedicines = async (req, res) => {
  try {
    const query = String(req.query.query || req.query.q || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    if (!query) return res.json([]);
    const medicines = await Medicine.find(scopedFilter(req, {
      isActive: true,
      $or: [
        { medicineName: { $regex: query, $options: 'i' } },
        { genericName: { $regex: query, $options: 'i' } },
        { brandName: { $regex: query, $options: 'i' } },
        { barcode: { $regex: query, $options: 'i' } }
      ]
    })).sort({ medicineName: 1 }).limit(limit);
    res.json(medicines.map(withLegacyMedicineFields));
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.getExpiredMedicines = async (req, res) => {
  try {
    const now = new Date();
    const batches = await MedicineBatch.find(scopedFilter(req, {
      isActive: true,
      $or: [{ isExpired: true }, { expiryDate: { $lt: now } }]
    })).populate('medicineId').sort({ expiryDate: 1 });

    const response = batches.map(batch => {
      const medicine = batch.medicineId ? withLegacyMedicineFields(batch.medicineId) : {};
      return {
        ...medicine,
        batch_id: batch._id,
        batch_number: batch.batchNumber,
        expiry_date: batch.expiryDate,
        stock_quantity: batch.availableQuantity,
        quantity: batch.availableQuantity,
        purchase_price: batch.purchasePrice,
        price_per_unit: batch.sellingPrice,
        sellingPrice: batch.sellingPrice
      };
    });
    res.json(response);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.downloadBulkUploadTemplate = async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Medicines');
    sheet.columns = [
      { header: 'Medicine Name', key: 'medicineName', width: 28 },
      { header: 'Generic Name', key: 'genericName', width: 22 },
      { header: 'Brand Name', key: 'brandName', width: 18 },
      { header: 'Category', key: 'category', width: 14 },
      { header: 'Strength', key: 'strength', width: 14 },
      { header: 'Selling Price', key: 'sellingPrice', width: 14 },
      { header: 'Purchase Price', key: 'purchasePrice', width: 14 },
      { header: 'Reorder Level', key: 'reorderLevel', width: 14 },
      { header: 'Prescription Required', key: 'prescriptionRequired', width: 20 },
      { header: 'HSN Code', key: 'hsnCode', width: 14 },
      { header: 'GST Rate', key: 'gstRate', width: 12 },
      { header: 'Manufacturer', key: 'manufacturer', width: 18 },
      { header: 'Composition', key: 'composition', width: 24 },
      { header: 'Initial Stock', key: 'initialStock', width: 14 },
      { header: 'Batch Number', key: 'batchNumber', width: 16 },
      { header: 'Expiry Date', key: 'expiryDate', width: 14 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.addRow({
      medicineName: 'Paracetamol 500mg', genericName: 'Acetaminophen', brandName: 'Dolo',
      category: 'tablet', strength: '500mg', sellingPrice: 25, purchasePrice: 18,
      reorderLevel: 20, prescriptionRequired: 'No', hsnCode: '30049099', gstRate: 5,
      manufacturer: 'Micro Labs', composition: 'Paracetamol', initialStock: 100,
      batchNumber: 'BATCH-001', expiryDate: '2027-01-31'
    });
    sheet.addRow({
      medicineName: 'Amoxicillin 250mg', genericName: 'Amoxicillin', brandName: '',
      category: 'capsule', strength: '250mg', sellingPrice: 40, purchasePrice: 30,
      reorderLevel: 15, prescriptionRequired: 'Yes', hsnCode: '30041000', gstRate: 12,
      manufacturer: '', composition: 'Amoxicillin', initialStock: '', batchNumber: '', expiryDate: ''
    });

    const notes = workbook.addWorksheet('Instructions');
    notes.columns = [{ width: 100 }];
    [
      'How to use this template',
      '1. Medicine Name, Category and Selling Price are required for every row.',
      '2. Category must be one of: tablet, capsule, syrup, injection, cream, ointment, drops, inhaler, other. Anything else is saved as "other".',
      '3. Prescription Required: Yes or No.',
      '4. Initial Stock is optional — leave blank if you will add stock later from the app.',
      '5. If Initial Stock is set, Batch Number and Expiry Date (YYYY-MM-DD) are required for that row, or the stock is skipped (the medicine is still created).',
      '6. Do not rename the column headers on the "Medicines" sheet — the upload matches columns by name.',
      '7. Save as .xlsx or .csv and upload it from the "Bulk Upload" screen in the app.'
    ].forEach((line) => notes.addRow([line]));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="medicine_bulk_upload_template.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Turns one spreadsheet row into the Medicine payload plus its optional
 * opening-stock instruction. Throws with a human-readable message when the
 * row cannot be imported at all.
 *
 * Both the dry run and the real import go through this, so what the preview
 * reports and what the import writes cannot drift apart.
 */
function buildBulkUploadRow(req, row) {
  const medicineName = cellString(row['Medicine Name']);
  if (!medicineName) throw new Error('Medicine Name is required');

  const categoryRaw = cellString(row['Category']).toLowerCase();
  const category = BULK_UPLOAD_CATEGORIES.includes(categoryRaw) ? categoryRaw : 'other';

  const sellingPrice = Number(row['Selling Price']);
  if (!Number.isFinite(sellingPrice) || sellingPrice <= 0) throw new Error('Selling Price must be a positive number');

  const purchasePriceRaw = row['Purchase Price'];
  const reorderLevelRaw = row['Reorder Level'];
  const gstRateRaw = row['GST Rate'];

  const payload = scopedPayload(req, {
    medicineName,
    genericName: cellString(row['Generic Name']) || undefined,
    brandName: cellString(row['Brand Name']) || undefined,
    category,
    unit: BULK_UPLOAD_CATEGORY_UNITS[category] || 'other',
    strength: cellString(row['Strength']) || undefined,
    sellingPrice,
    purchasePrice: purchasePriceRaw !== undefined && cellString(purchasePriceRaw) !== '' ? Number(purchasePriceRaw) : undefined,
    reorderLevel: reorderLevelRaw !== undefined && cellString(reorderLevelRaw) !== '' ? Number(reorderLevelRaw) : 10,
    prescriptionRequired: /^(yes|true|1)$/i.test(cellString(row['Prescription Required'])),
    hsnCode: cellString(row['HSN Code']) || undefined,
    taxRate: gstRateRaw !== undefined && cellString(gstRateRaw) !== '' ? Number(gstRateRaw) : undefined,
    manufacturer: cellString(row['Manufacturer']) || undefined,
    composition: cellString(row['Composition']) || undefined,
    isActive: true,
    createdBy: req.user.id
  });

  // Opening stock is optional, and a bad batch/expiry never fails the row —
  // the medicine is still worth creating, the stock is just skipped.
  const initialStock = Number(row['Initial Stock'] || 0);
  let stock = null;
  let skipReason = null;
  if (Number.isFinite(initialStock) && initialStock > 0) {
    const batchNumber = cellString(row['Batch Number']);
    const expiryRaw = row['Expiry Date'];
    const expiryDate = expiryRaw ? new Date(expiryRaw) : null;
    if (!batchNumber || !expiryDate || Number.isNaN(expiryDate.getTime())) {
      skipReason = 'Batch Number and a valid Expiry Date are required to add opening stock';
    } else if (expiryDate <= new Date()) {
      skipReason = 'opening stock skipped — expiry date is in the past';
    } else {
      stock = { initialStock, batchNumber, expiryDate };
    }
  }

  return { medicineName, payload, sellingPrice, stock, skipReason };
}

exports.bulkUploadMedicines = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'A .csv or .xlsx file is required (field name "file")' });

    // Dry run is the default posture of the two-step import: the client asks
    // for a preview first, the user confirms, and only then does it post the
    // same file again with dryRun off. An import that writes on the first
    // request gives the user no point at which to say no.
    const dryRunRaw = req.query.dryRun !== undefined ? req.query.dryRun : (req.body && req.body.dryRun);
    const dryRun = /^(1|true|yes)$/i.test(String(dryRunRaw === undefined ? '' : dryRunRaw));

    const rows = await readWorkbookRows(req.file.buffer, req.file.originalname);
    if (rows.length === 0) return res.status(400).json({ success: false, message: 'The file has no data rows' });
    if (rows.length > BULK_UPLOAD_MAX_ROWS) return res.status(400).json({ success: false, message: `Maximum ${BULK_UPLOAD_MAX_ROWS} rows per upload` });

    const results = [];
    let created = 0;
    let failed = 0;
    let warnings = 0;

    for (let i = 0; i < rows.length; i += 1) {
      const rowNumber = i + 2; // header occupies row 1
      let medicineName = cellString(rows[i]['Medicine Name']);
      try {
        const parsed = buildBulkUploadRow(req, rows[i]);
        medicineName = parsed.medicineName;

        if (dryRun) {
          // Run the same schema validation Medicine.create() would, without
          // touching the database, so the preview catches what the import
          // would reject.
          const invalid = new Medicine(parsed.payload).validateSync();
          if (invalid) throw new Error(Object.values(invalid.errors).map((e) => e.message).join('; '));

          const note = parsed.skipReason ? `Will be created, but ${parsed.skipReason}` : null;
          if (note) warnings += 1;
          results.push({ row: rowNumber, medicineName, status: 'valid', note });
          created += 1;
          continue;
        }

        const medicine = await Medicine.create(parsed.payload);

        let note = parsed.skipReason ? `Medicine created, but ${parsed.skipReason}` : null;
        if (parsed.stock) {
          try {
            const batch = await MedicineBatch.create(scopedPayload(req, {
              medicineId: medicine._id,
              batchNumber: parsed.stock.batchNumber,
              quantity: 0,
              availableQuantity: 0,
              purchasePrice: parsed.payload.purchasePrice || parsed.sellingPrice,
              sellingPrice: parsed.sellingPrice,
              expiryDate: parsed.stock.expiryDate,
              manufactureDate: new Date(),
              addedBy: req.user.id
            }));
            await addToBatch({
              scope: scopeFromRequest(req),
              medicineId: medicine._id,
              batchId: batch._id,
              quantity: parsed.stock.initialStock,
              actorId: req.user.id,
              adjustmentType: 'addition',
              reason: 'Bulk upload',
              referenceType: 'other'
            });
          } catch (stockError) {
            note = `Medicine created, but adding initial stock failed: ${stockError.message}`;
          }
        }

        if (note) warnings += 1;
        results.push({ row: rowNumber, medicineName, status: 'created', note });
        created += 1;
      } catch (rowError) {
        results.push({ row: rowNumber, medicineName, status: 'failed', error: rowError.message });
        failed += 1;
      }
    }

    res.json({ success: true, dryRun, total: rows.length, created, failed, warnings, results });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.searchMedicineCatalog = async (req, res) => {
  try {
    const query = String(req.query.q || req.query.query || '').trim();
    if (!query) return res.json({ success: true, results: [] });
    const results = await MedicineCatalog.find({
      $or: [
        { name: { $regex: query, $options: 'i' } },
        { genericName: { $regex: query, $options: 'i' } },
        { brandName: { $regex: query, $options: 'i' } }
      ]
    }).limit(20).lean();
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getExpiringMedicines = async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + days);
    const now = new Date();
    const batches = await MedicineBatch.find(scopedFilter(req, {
      isActive: true,
      isExpired: false,
      expiryDate: { $gte: now, $lte: expiryDate }
    }))
      .populate('medicineId', 'medicineName genericName brandName category')
      .sort({ expiryDate: 1 });

    const normalizedBatches = batches.map(batch => ({
      ...batch.toObject(),
      medicine_id: batch.medicineId ? {
        ...batch.medicineId.toObject(),
        name: batch.medicineId.medicineName,
        generic_name: batch.medicineId.genericName,
        brand: batch.medicineId.brandName
      } : null,
      batch_number: batch.batchNumber,
      expiry_date: batch.expiryDate,
      quantity: batch.availableQuantity,
      purchase_price: batch.purchasePrice,
      selling_price: batch.sellingPrice
    }));
    res.json({ success: true, batches: normalizedBatches });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};
