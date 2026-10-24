/**
 * Places fresh "just arrived" orders at one pharmacy and fires the same new-
 * order alert a real checkout does — for testing the push, the ring-until-
 * acknowledged alarm, the accept countdown, the checklist, substitutes and
 * printing end to end.
 *
 * Usage:
 *   node scripts/push_test_orders.js --email=store@example.com            # 3 orders
 *   node scripts/push_test_orders.js --email=store@example.com --count=5
 *   node scripts/push_test_orders.js --email=store@example.com --clear    # remove them
 *   ... --no-alert   insert without sending push notifications
 *
 * --email is required on purpose: this sends real push notifications, so it
 * must never fall back to "whichever pharmacy was updated last".
 *
 * Orders are cash on delivery only. A prepaid test order would, once the
 * acceptance window ran out, make the timeout job try to refund a payment id
 * Razorpay has never seen. Order numbers start with EOTEST- and --clear
 * deletes only those (plus their register entries).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const User = require('../models/User');
const PatientProfile = require('../models/PatientProfile');
const PharmacyStore = require('../models/PharmacyStore');
const Medicine = require('../models/Medicine');
const EPharmacyOrder = require('../models/EPharmacyOrder');
const ScheduledDrugRegister = require('../models/ScheduledDrugRegister');
const { aggregateAvailable } = require('../services/inventory.service');
const { notifyNewPharmacyOrder } = require('../services/pharmacyOrderAlert.service');

const PREFIX = 'EOTEST-';
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=').trim() : null;
};
const flag = (name) => process.argv.includes(`--${name}`);
const round = (n) => Math.round(n * 100) / 100;

const CUSTOMER = {
  name: 'Test Customer', email: 'test.customer.eotest@example.com', phone: '9000000001',
  line1: '12, Test Lane', line2: 'Near City Hospital', city: 'Indore', state: 'Madhya Pradesh', pincode: '452001',
};

async function ensureCustomer() {
  let user = await User.findOne({ email: CUSTOMER.email });
  if (!user) {
    user = await User.create({ name: CUSTOMER.name, email: CUSTOMER.email, password: 'Seed@12345', phone: CUSTOMER.phone, role: 'patient', isActive: true });
  }
  let profile = await PatientProfile.findOne({ userId: user._id });
  if (!profile) {
    profile = await PatientProfile.create({ userId: user._id, name: CUSTOMER.name, firstName: 'Test', lastName: 'Customer', email: CUSTOMER.email, phone: CUSTOMER.phone, gender: 'other', dateOfBirth: new Date(1990, 0, 1) });
  }
  return profile;
}

function line(med, quantity) {
  const unitPrice = Number(med.sellingPrice) || 50;
  const listedAmount = round(unitPrice * quantity);
  const taxRate = Number(med.taxRate) || 12;
  // Prices include tax, as the store's catalogue does.
  const taxableAmount = round(listedAmount / (1 + taxRate / 100));
  return {
    medicineId: med._id, medicineName: med.medicineName, genericName: med.genericName, quantity, unit: med.unit,
    hsnCode: med.hsnCode, prescriptionRequired: med.prescriptionRequired === true, unitPrice, listedAmount,
    medicineDiscount: 0, taxableAmount, taxRate, taxAmount: round(listedAmount - taxableAmount), totalAmount: listedAmount,
  };
}

async function main() {
  const email = arg('email');
  if (!email) throw new Error('Pass --email=<pharmacy login> — this sends real push notifications.');
  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.findOne({ email: email.toLowerCase(), role: 'pharmacy' });
  if (!user) throw new Error(`No pharmacy user with email ${email}`);
  const store = (await PharmacyStore.findById(user.defaultPharmacyStoreId))
    || (await PharmacyStore.findOne({ organizationId: user.organizationId, isDefault: true }));
  if (!store) throw new Error('Could not resolve this user\'s store');
  const scope = { organizationId: user.organizationId, storeId: store._id };
  console.log(`Pharmacy: ${user.email}\nBranch  : ${store.name} (${store.code})`);

  if (flag('clear')) {
    const ids = (await EPharmacyOrder.find({ ...scope, orderNumber: new RegExp(`^${PREFIX}`) }).select('_id')).map((o) => o._id);
    const reg = await ScheduledDrugRegister.deleteMany({ orderId: { $in: ids } });
    const { deletedCount } = await EPharmacyOrder.deleteMany({ _id: { $in: ids } });
    console.log(`Removed ${deletedCount} test order(s) and ${reg.deletedCount} register entr${reg.deletedCount === 1 ? 'y' : 'ies'}.`);
    console.log('Note: stock allocated by accepting a test order is not returned — cancel it in the app first if that matters.');
    return mongoose.disconnect();
  }

  // Only medicines with stock, so Accept actually works.
  const all = await Medicine.find({ ...scope, isActive: true }).limit(80);
  const stocked = [];
  for (const m of all) {
    const available = await aggregateAvailable(scope, m._id);
    if (available > 0) stocked.push({ m, available });
  }
  if (stocked.length < 2) throw new Error('This branch needs at least 2 medicines with stock (batches) to place test orders.');
  const plain = stocked.filter((s) => !s.m.prescriptionRequired);
  const rx = stocked.filter((s) => s.m.prescriptionRequired);
  const scheduled = rx.find((s) => ['Schedule H1', 'Schedule X', 'Schedule H'].includes(s.m.schedule));
  // A line ordered beyond what's on the shelf, to show the stock warning
  // and same-salt alternatives.
  const short = stocked.find((s) => s.m.genericName && s.available < 20);
  const pick = (list, i) => (list.length ? list[i % list.length] : stocked[i % stocked.length]);

  const plans = [
    { label: 'Plain order — accept / print', rx: false, lines: [[pick(plain, 0), 2], [pick(plain, 1), 1]] },
    { label: 'Prescription to check — checklist + register', rx: true, lines: [[scheduled || pick(rx, 0), 1], [pick(plain, 2), 1]] },
    { label: 'One line short of stock — substitutes', rx: false, lines: [[short || pick(stocked, 3), (short ? short.available : 1) + 2], [pick(plain, 3), 1]] },
  ];
  const count = Math.max(1, Math.min(Number(arg('count')) || 3, 10));
  const profile = await ensureCustomer();
  const existing = await EPharmacyOrder.countDocuments({ orderNumber: new RegExp(`^${PREFIX}`) });

  for (let i = 0; i < count; i += 1) {
    const plan = plans[i % plans.length];
    const items = plan.lines.map(([s, q]) => line(s.m, q));
    const needsRx = plan.rx || items.some((it) => it.prescriptionRequired);
    const subtotal = round(items.reduce((s, it) => s + it.listedAmount, 0));
    const tax = round(items.reduce((s, it) => s + it.taxAmount, 0));
    const deliveryFee = 30;
    const status = needsRx ? 'prescription_review' : 'placed';
    const order = await EPharmacyOrder.create({
      orderNumber: `${PREFIX}${String(existing + i + 1).padStart(4, '0')}`,
      ...scope,
      patientId: profile._id,
      items,
      deliveryAddress: { label: 'Home', contactName: CUSTOMER.name, phone: CUSTOMER.phone, line1: CUSTOMER.line1, line2: CUSTOMER.line2, city: CUSTOMER.city, state: CUSTOMER.state, pincode: CUSTOMER.pincode, country: 'India' },
      deliveryInstructions: 'TEST ORDER — do not deliver',
      prescriptionRequired: needsRx,
      prescriptionStatus: needsRx ? 'pending_review' : 'not_required',
      subtotal, medicineDiscount: 0, couponDiscount: 0, tax, deliveryFee,
      totalAmount: round(subtotal + deliveryFee),
      paymentMethod: 'cod', paymentStatus: 'pending',
      orderStatus: status,
      statusHistory: [{ status, note: 'Test order placed', at: new Date() }],
      createdBy: user._id,
    });
    if (!flag('no-alert')) await notifyNewPharmacyOrder(order);
    console.log(`  ${order.orderNumber}  ${status.padEnd(20)} Rs ${order.totalAmount}  — ${plan.label}`);
  }
  console.log(`\n${flag('no-alert') ? 'Inserted without alerts.' : 'Alerts sent.'} Orders auto-cancel after 15 min (30 for prescriptions) if not accepted — that is expected.`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('\n' + error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
