/**
 * One-time import of a drug-name reference export into the shared
 * MedicineCatalog collection (NOT per-pharmacy stock — see models/MedicineCatalog.js).
 *
 * Usage:
 *   node scripts/import_medicine_catalog.js "C:\Users\sande\Downloads\test.medicines.csv"
 */
const path = require('path');
const ExcelJS = require('exceljs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const MedicineCatalog = require('../models/MedicineCatalog');

const CATEGORY_MAP = {
  tablet: 'tablet',
  capsule: 'capsule',
  syrup: 'syrup',
  injection: 'injection',
  ampoule: 'injection',
  vial: 'injection',
  cream: 'cream',
  ointment: 'ointment',
  gel: 'ointment',
  drop: 'drops',
  drops: 'drops',
  inhaler: 'inhaler'
};

function mapCategory(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return CATEGORY_MAP[key] || 'other';
}

function toBool(raw) {
  return String(raw || '').trim().toLowerCase() === 'true';
}

function toNumber(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

async function readRows(filePath) {
  const workbook = new ExcelJS.Workbook();
  const ext = path.extname(filePath).toLowerCase();
  let worksheet;
  if (ext === '.csv') {
    worksheet = await workbook.csv.readFile(filePath);
  } else {
    await workbook.xlsx.readFile(filePath);
    worksheet = workbook.worksheets[0];
  }

  const headerRow = worksheet.getRow(1).values;
  // ExcelJS rows are 1-indexed and values[0] is undefined
  const headers = headerRow.slice(1).map((h) => String(h || '').trim());

  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = row.values.slice(1);
    const record = {};
    headers.forEach((header, index) => {
      record[header] = values[index];
    });
    rows.push(record);
  });
  return rows;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node scripts/import_medicine_catalog.js <path-to-csv-or-xlsx>');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const rows = await readRows(filePath);
  console.log(`Read ${rows.length} rows from ${filePath}`);

  let created = 0;
  let skipped = 0;
  const skippedReasons = [];

  for (const row of rows) {
    const name = String(row.name || '').trim();
    if (!name) {
      skipped += 1;
      skippedReasons.push('missing name');
      continue;
    }

    const doc = {
      name,
      genericName: String(row.generic_name || '').trim() || undefined,
      brandName: String(row.brand || '').trim() || undefined,
      category: mapCategory(row.category),
      strength: String(row.strength || '').trim() || undefined,
      composition: String(row.composition || '').trim() || undefined,
      manufacturer: String(row.manufacturer || '').trim() || undefined,
      hsnCode: String(row.hsn_code || row['gst_history[0].hsn_code'] || '').trim() || undefined,
      gstRate: toNumber(row.gst_rate ?? row['gst_history[0].gst_rate']),
      prescriptionRequired: toBool(row.prescription_required),
      source: 'test.medicines.csv'
    };

    try {
      // Avoid piling up exact duplicates on repeated runs of this script.
      await MedicineCatalog.updateOne(
        { name: doc.name, strength: doc.strength || null, manufacturer: doc.manufacturer || null },
        { $setOnInsert: doc },
        { upsert: true }
      );
      created += 1;
    } catch (error) {
      skipped += 1;
      skippedReasons.push(`${name}: ${error.message}`);
    }
  }

  console.log(`Upserted (created-or-existing): ${created}`);
  console.log(`Skipped: ${skipped}`);
  if (skippedReasons.length) {
    console.log('Skip reasons (first 20):', skippedReasons.slice(0, 20));
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((error) => {
  console.error('Import failed:', error);
  process.exit(1);
});
