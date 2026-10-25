/**
 * Common lab tests a new lab can add to its catalogue in one tap, each with
 * the parameters it reports and typical adult reference ranges.
 *
 * Ranges are a starting point, not clinical truth: methods and analysers
 * differ, so every lab can edit them after importing. `low`/`high` drive the
 * automatic H/L flags in result entry; `critLow`/`critHigh` mark values that
 * need a call to the doctor. Qualitative parameters use `text` (the expected
 * result) instead of numbers. Prices are typical Indian MRPs, also editable.
 */
const p = (name, unit, low, high, extra = {}) => ({ name, unit, low, high, ...extra });
const q = (name, text) => ({ name, unit: '', text });

module.exports = [
  {
    testCode: 'CBC', testName: 'Complete blood count', category: 'Haematology', sampleType: 'Blood (EDTA)',
    price: 350, reportTime: 12, fastingRequired: false,
    parameters: [
      p('Haemoglobin', 'g/dL', 12, 16, { critLow: 7, critHigh: 20 }),
      p('Total RBC count', 'million/µL', 4.0, 5.5),
      p('Packed cell volume (PCV)', '%', 36, 48),
      p('MCV', 'fL', 80, 100),
      p('MCH', 'pg', 27, 32),
      p('MCHC', 'g/dL', 32, 36),
      p('Total WBC count', '/µL', 4000, 11000, { critLow: 2000, critHigh: 30000 }),
      p('Neutrophils', '%', 40, 75),
      p('Lymphocytes', '%', 20, 45),
      p('Eosinophils', '%', 1, 6),
      p('Monocytes', '%', 2, 10),
      p('Platelet count', '/µL', 150000, 450000, { critLow: 50000, critHigh: 1000000 }),
    ],
  },
  {
    testCode: 'ESR', testName: 'Erythrocyte sedimentation rate', category: 'Haematology', sampleType: 'Blood (EDTA)',
    price: 150, reportTime: 6, fastingRequired: false,
    parameters: [p('ESR', 'mm/hr', 0, 20)],
  },
  {
    testCode: 'FBS', testName: 'Fasting blood sugar', category: 'Diabetes', sampleType: 'Blood (fluoride)',
    price: 100, reportTime: 4, fastingRequired: true, fastingHours: 10,
    parameters: [p('Glucose, fasting', 'mg/dL', 70, 100, { critLow: 50, critHigh: 400 })],
  },
  {
    testCode: 'PPBS', testName: 'Post-prandial blood sugar', category: 'Diabetes', sampleType: 'Blood (fluoride)',
    price: 100, reportTime: 4, fastingRequired: false,
    parameters: [p('Glucose, post-prandial', 'mg/dL', 70, 140, { critLow: 50, critHigh: 450 })],
  },
  {
    testCode: 'HBA1C', testName: 'HbA1c (glycated haemoglobin)', category: 'Diabetes', sampleType: 'Blood (EDTA)',
    price: 450, reportTime: 12, fastingRequired: false,
    parameters: [p('HbA1c', '%', 4.0, 5.6), p('Estimated average glucose', 'mg/dL', 70, 114)],
  },
  {
    testCode: 'LIPID', testName: 'Lipid profile', category: 'Heart', sampleType: 'Blood (serum)',
    price: 600, reportTime: 12, fastingRequired: true, fastingHours: 12,
    parameters: [
      p('Total cholesterol', 'mg/dL', 0, 200),
      p('Triglycerides', 'mg/dL', 0, 150),
      p('HDL cholesterol', 'mg/dL', 40, 60),
      p('LDL cholesterol', 'mg/dL', 0, 100),
      p('VLDL cholesterol', 'mg/dL', 5, 40),
      p('Total cholesterol / HDL ratio', '', 0, 5),
    ],
  },
  {
    testCode: 'LFT', testName: 'Liver function test', category: 'Liver', sampleType: 'Blood (serum)',
    price: 650, reportTime: 12, fastingRequired: false,
    parameters: [
      p('Bilirubin, total', 'mg/dL', 0.2, 1.2),
      p('Bilirubin, direct', 'mg/dL', 0, 0.3),
      p('SGOT (AST)', 'U/L', 0, 40),
      p('SGPT (ALT)', 'U/L', 0, 41),
      p('Alkaline phosphatase', 'U/L', 44, 147),
      p('Total protein', 'g/dL', 6.0, 8.3),
      p('Albumin', 'g/dL', 3.5, 5.0),
      p('Globulin', 'g/dL', 2.0, 3.5),
    ],
  },
  {
    testCode: 'KFT', testName: 'Kidney function test', category: 'Kidney', sampleType: 'Blood (serum)',
    price: 600, reportTime: 12, fastingRequired: false,
    parameters: [
      p('Urea', 'mg/dL', 15, 40),
      p('Creatinine', 'mg/dL', 0.6, 1.3, { critHigh: 5 }),
      p('Uric acid', 'mg/dL', 3.5, 7.2),
      p('Sodium', 'mmol/L', 135, 145, { critLow: 120, critHigh: 160 }),
      p('Potassium', 'mmol/L', 3.5, 5.1, { critLow: 2.8, critHigh: 6.2 }),
      p('Chloride', 'mmol/L', 98, 107),
    ],
  },
  {
    testCode: 'THYROID', testName: 'Thyroid profile (T3, T4, TSH)', category: 'Thyroid', sampleType: 'Blood (serum)',
    price: 550, reportTime: 24, fastingRequired: false,
    parameters: [
      p('T3, total', 'ng/dL', 80, 200),
      p('T4, total', 'µg/dL', 5.1, 14.1),
      p('TSH', 'µIU/mL', 0.27, 4.2),
    ],
  },
  {
    testCode: 'TSH', testName: 'TSH (thyroid stimulating hormone)', category: 'Thyroid', sampleType: 'Blood (serum)',
    price: 300, reportTime: 24, fastingRequired: false,
    parameters: [p('TSH', 'µIU/mL', 0.27, 4.2)],
  },
  {
    testCode: 'VITD', testName: 'Vitamin D (25-OH)', category: 'Vitamins', sampleType: 'Blood (serum)',
    price: 1200, reportTime: 24, fastingRequired: false,
    parameters: [p('25-OH vitamin D', 'ng/mL', 30, 100)],
  },
  {
    testCode: 'VITB12', testName: 'Vitamin B12', category: 'Vitamins', sampleType: 'Blood (serum)',
    price: 900, reportTime: 24, fastingRequired: false,
    parameters: [p('Vitamin B12', 'pg/mL', 211, 911)],
  },
  {
    testCode: 'IRON', testName: 'Iron studies', category: 'Haematology', sampleType: 'Blood (serum)',
    price: 800, reportTime: 24, fastingRequired: true, fastingHours: 8,
    parameters: [
      p('Serum iron', 'µg/dL', 60, 170),
      p('TIBC', 'µg/dL', 250, 450),
      p('Transferrin saturation', '%', 20, 50),
      p('Ferritin', 'ng/mL', 15, 300),
    ],
  },
  {
    testCode: 'CRP', testName: 'C-reactive protein (CRP)', category: 'Inflammation', sampleType: 'Blood (serum)',
    price: 450, reportTime: 12, fastingRequired: false,
    parameters: [p('CRP', 'mg/L', 0, 5)],
  },
  {
    testCode: 'URINE', testName: 'Urine routine & microscopy', category: 'Urine', sampleType: 'Urine',
    price: 200, reportTime: 6, fastingRequired: false,
    parameters: [
      q('Colour', 'Pale yellow'),
      q('Appearance', 'Clear'),
      p('pH', '', 4.6, 8.0),
      p('Specific gravity', '', 1.005, 1.030),
      q('Protein', 'Negative'),
      q('Glucose', 'Negative'),
      q('Ketones', 'Negative'),
      p('Pus cells', '/hpf', 0, 5),
      p('RBCs', '/hpf', 0, 2),
      p('Epithelial cells', '/hpf', 0, 5),
    ],
  },
  {
    testCode: 'DENGUE', testName: 'Dengue NS1 antigen', category: 'Infection', sampleType: 'Blood (serum)',
    price: 600, reportTime: 6, fastingRequired: false,
    parameters: [q('Dengue NS1 antigen', 'Negative')],
  },
  {
    testCode: 'MALARIA', testName: 'Malaria antigen (rapid)', category: 'Infection', sampleType: 'Blood (EDTA)',
    price: 400, reportTime: 4, fastingRequired: false,
    parameters: [q('P. falciparum', 'Negative'), q('P. vivax', 'Negative')],
  },
  {
    testCode: 'WIDAL', testName: 'Widal test', category: 'Infection', sampleType: 'Blood (serum)',
    price: 250, reportTime: 6, fastingRequired: false,
    parameters: [q('S. typhi O', 'Less than 1:80'), q('S. typhi H', 'Less than 1:160')],
  },
  {
    testCode: 'BGRH', testName: 'Blood group & Rh type', category: 'Haematology', sampleType: 'Blood (EDTA)',
    price: 150, reportTime: 4, fastingRequired: false,
    parameters: [{ name: 'Blood group', unit: '', text: '' }, { name: 'Rh factor', unit: '', text: '' }],
  },
  {
    testCode: 'CALCIUM', testName: 'Serum calcium', category: 'Bone', sampleType: 'Blood (serum)',
    price: 200, reportTime: 12, fastingRequired: false,
    parameters: [p('Calcium', 'mg/dL', 8.6, 10.3, { critLow: 6.5, critHigh: 13 })],
  },
];
