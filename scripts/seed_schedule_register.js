/**
 * Adds sample Schedule H / H1 / X register entries to one pharmacy, so the
 * Profile → Schedule H register screen can be seen with data in it.
 *
 * Usage:
 *   node scripts/seed_schedule_register.js --email=pharmacy@gmail.com
 *   node scripts/seed_schedule_register.js --email=pharmacy@gmail.com --clear
 *
 * Writes only to the register (no orders, no stock, no notifications). Every
 * entry carries an order number starting EOTEST-REG-, and --clear deletes
 * only those.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const User = require('../models/User');
const PharmacyStore = require('../models/PharmacyStore');
const ScheduledDrugRegister = require('../models/ScheduledDrugRegister');

const PREFIX = 'EOTEST-REG-';
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=').trim() : null;
};
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000);
const daysAhead = (d) => new Date(Date.now() + d * 86400 * 1000);

const SAMPLES = [
  { schedule: 'Schedule H1', medicineName: 'Cefixime 200', genericName: 'Cefixime', strength: '200mg', quantity: 1, batch: 'CFX2408', exp: 420, patient: 'Rahul Sharma', phone: '9812340001', address: '204, Silver Sands Apartments, Vijay Nagar, Indore, 452010', doctor: 'Dr. A. Khanna', reg: 'MPMC-2012-33817', ago: 2 },
  { schedule: 'Schedule H1', medicineName: 'Alprazolam 0.25', genericName: 'Alprazolam', strength: '0.25mg', quantity: 1, batch: 'ALP1172', exp: 300, patient: 'Ananya Iyer', phone: '9812340002', address: 'B-12, Shalimar Township, AB Road, Indore, 452012', doctor: 'Dr. M. Joshi', reg: 'MPMC-2009-21544', ago: 5 },
  { schedule: 'Schedule H', medicineName: 'Azithromycin 500', genericName: 'Azithromycin', strength: '500mg', quantity: 1, batch: 'AZ24117', exp: 250, patient: 'Mohammed Faiz', phone: '9812340003', address: '7, Khatiwala Tank, Indore, 452014', doctor: 'Dr. S. Verma', reg: 'MPMC-2015-48210', ago: 26 },
  { schedule: 'Schedule X', medicineName: 'Clonazepam 0.5', genericName: 'Clonazepam', strength: '0.5mg', quantity: 1, batch: 'CLZ0931', exp: 500, patient: 'Priya Deshmukh', phone: '9812340004', address: 'Flat 302, Aakriti Residency, Bicholi Mardana, Indore, 452016', doctor: 'Dr. R. Iyer', reg: 'MPMC-2011-60293', ago: 50 },
  { schedule: 'Schedule H', medicineName: 'Metformin 500', genericName: 'Metformin', strength: '500mg', quantity: 2, batch: 'MTF5521', exp: 600, patient: 'Sanjay Verma', phone: '9812340005', address: '18, Anoop Nagar, Indore, 452001', doctor: 'Dr. A. Khanna', reg: 'MPMC-2012-33817', ago: 74 },
];

async function main() {
  const email = arg('email');
  if (!email) throw new Error('Pass --email=<pharmacy login>.');
  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.findOne({ email: email.toLowerCase(), role: 'pharmacy' });
  if (!user) throw new Error(`No pharmacy user with email ${email}`);
  const store = (await PharmacyStore.findById(user.defaultPharmacyStoreId))
    || (await PharmacyStore.findOne({ organizationId: user.organizationId, isDefault: true }));
  if (!store) throw new Error('Could not resolve this user\'s store');
  const scope = { organizationId: user.organizationId, storeId: store._id };
  console.log(`Pharmacy: ${user.email}\nBranch  : ${store.name}`);

  if (process.argv.includes('--clear')) {
    const { deletedCount } = await ScheduledDrugRegister.deleteMany({ ...scope, orderNumber: new RegExp(`^${PREFIX}`) });
    console.log(`Removed ${deletedCount} sample entr${deletedCount === 1 ? 'y' : 'ies'}.`);
    return mongoose.disconnect();
  }

  const existing = await ScheduledDrugRegister.countDocuments({ ...scope, orderNumber: new RegExp(`^${PREFIX}`) });
  if (existing) {
    console.log(`${existing} sample entries already exist — run with --clear first to replace them.`);
    return mongoose.disconnect();
  }

  const docs = SAMPLES.map((s, i) => ({
    ...scope,
    schedule: s.schedule,
    source: 'online_order',
    orderNumber: `${PREFIX}${String(i + 1).padStart(3, '0')}`,
    medicineName: s.medicineName,
    genericName: s.genericName,
    strength: s.strength,
    quantity: s.quantity,
    batches: [{ batchNumber: s.batch, expiryDate: daysAhead(s.exp), quantity: s.quantity }],
    patientName: s.patient,
    patientPhone: s.phone,
    patientAddress: s.address,
    prescriberName: s.doctor,
    prescriberRegistration: s.reg,
    prescriptionDate: hoursAgo(s.ago + 20),
    dispensedBy: user._id,
    dispensedAt: hoursAgo(s.ago),
  }));
  await ScheduledDrugRegister.insertMany(docs);
  console.log(`Added ${docs.length} sample entries (2 × H1, 1 × X, 2 × H). Open Profile → Schedule H register.`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('\n' + e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
