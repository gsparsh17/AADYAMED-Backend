/**
 * Drops a couple of fresh, un-actioned orders into a pharmacy so the whole
 * fulfilment ladder can be walked: accept → packing → ready → shipped → out
 * for delivery → delivered → settlement.
 *
 * Unlike seed_pharmacy_orders.js (which paints one order per status for UI
 * work), every order here starts at `placed` and is meant to be driven by
 * hand from the app.
 *
 * Usage:
 *   node scripts/add_test_orders.js --email=pharmacy@gmail.com
 *   node scripts/add_test_orders.js --email=... --count=2
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const User = require('../models/User');
const PatientProfile = require('../models/PatientProfile');
const PharmacyStore = require('../models/PharmacyStore');
const Medicine = require('../models/Medicine');
const EPharmacyOrder = require('../models/EPharmacyOrder');

const PREFIX = 'EOTEST-';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=').trim() : null;
};

const round = (n) => Math.round(n * 100) / 100;

const SCENARIOS = [
  {
    who: { name: 'Neha Agarwal', phone: '9812340007', gender: 'female' },
    address: { line1: '12, Sapna Sangeeta Road', line2: 'Near Ratlam Kothi', city: 'Indore', pincode: '452001' },
    pay: 'cod',
    paid: 'pending',
    items: 2,
    note: 'COD — cash to collect at the door, and the Collect-by-UPI button is live on this one.',
  },
  {
    who: { name: 'Vikram Rathore', phone: '9812340008', gender: 'male' },
    address: { line1: '401, Vandana Heights', line2: 'Scheme 78, Vijay Nagar', city: 'Indore', pincode: '452010' },
    pay: 'online',
    paid: 'paid',
    items: 3,
    note: 'Prepaid — reduce a line while accepting to watch a partial refund fire.',
  },
];

async function ensurePatient(who) {
  const email = `${who.name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;
  let user = await User.findOne({ email });
  if (!user) {
    user = await User.create({
      name: who.name,
      email,
      password: 'Seed@12345',
      phone: who.phone,
      role: 'patient',
      isActive: true,
    });
  }
  let profile = await PatientProfile.findOne({ userId: user._id });
  if (!profile) {
    const [firstName, ...rest] = who.name.split(' ');
    profile = await PatientProfile.create({
      userId: user._id,
      name: who.name,
      firstName,
      lastName: rest.join(' ') || undefined,
      email,
      phone: who.phone,
      gender: who.gender,
      dateOfBirth: new Date(1992, 4, 12),
    });
  }
  return profile;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set in .env');
  await mongoose.connect(process.env.MONGO_URI);

  const email = arg('email');
  const user = await User.findOne({ role: 'pharmacy', ...(email ? { email: email.toLowerCase() } : {}) })
    .sort({ updatedAt: -1 });
  if (!user) throw new Error(email ? `No pharmacy user ${email}` : 'No pharmacy user found');
  if (!user.organizationId) throw new Error(`${user.email} has no organization yet — open the app once as this user first.`);

  const store = (await PharmacyStore.findById(user.defaultPharmacyStoreId))
    || (await PharmacyStore.findOne({ organizationId: user.organizationId, isDefault: true }));
  if (!store) throw new Error('Could not resolve a store for this user');

  const scope = { organizationId: user.organizationId, storeId: store._id };
  const medicines = await Medicine.find({ ...scope, isActive: true }).limit(20);
  if (medicines.length === 0) {
    throw new Error('This branch has no medicines — an order must reference real stock.');
  }

  const count = Math.max(1, Math.min(SCENARIOS.length, Number(arg('count')) || SCENARIOS.length));
  const existing = await EPharmacyOrder.countDocuments({ ...scope, orderNumber: new RegExp(`^${PREFIX}`) });

  console.log(`Pharmacy : ${user.email}`);
  console.log(`Branch   : ${store.name} (${store.code})`);
  console.log(`Medicines: ${medicines.length} available\n`);

  const created = [];
  for (let i = 0; i < count; i += 1) {
    const sc = SCENARIOS[i];
    const profile = await ensurePatient(sc.who);

    const items = [];
    let subtotal = 0;
    let tax = 0;
    for (let n = 0; n < sc.items; n += 1) {
      const med = medicines[(i * 2 + n) % medicines.length];
      const quantity = 1 + (n % 3);
      const unitPrice = Number(med.sellingPrice) || 40;
      const listedAmount = round(unitPrice * quantity);
      const taxRate = Number(med.taxRate) || 12;
      const taxAmount = round((listedAmount * taxRate) / 100);
      items.push({
        medicineId: med._id,
        medicineName: med.medicineName,
        genericName: med.genericName,
        quantity,
        orderedQuantity: quantity,
        unit: med.unit,
        hsnCode: med.hsnCode,
        prescriptionRequired: false,
        unitPrice,
        listedAmount,
        medicineDiscount: 0,
        taxableAmount: listedAmount,
        taxRate,
        taxAmount,
        totalAmount: round(listedAmount + taxAmount),
      });
      subtotal += listedAmount;
      tax += taxAmount;
    }

    const deliveryFee = sc.pay === 'cod' ? 40 : 0;
    const totalAmount = round(subtotal + tax + deliveryFee);
    const placedAt = new Date(Date.now() - (i + 1) * 90 * 1000);

    const order = await EPharmacyOrder.create({
      orderNumber: `${PREFIX}${String(existing + i + 1).padStart(3, '0')}`,
      ...scope,
      patientId: profile._id,
      items,
      deliveryAddress: {
        label: 'Home',
        contactName: profile.name,
        phone: profile.phone,
        line1: sc.address.line1,
        line2: sc.address.line2,
        city: sc.address.city,
        state: 'Madhya Pradesh',
        pincode: sc.address.pincode,
        country: 'India',
      },
      prescriptionRequired: false,
      prescriptionStatus: 'not_required',
      subtotal: round(subtotal),
      medicineDiscount: 0,
      couponDiscount: 0,
      tax: round(tax),
      deliveryFee,
      totalAmount,
      paymentMethod: sc.pay,
      paymentStatus: sc.paid,
      paymentDate: sc.paid === 'paid' ? placedAt : undefined,
      // Prepaid orders get a payment id so a partial refund has something to
      // refund against; it is not a real Razorpay id, so the refund call will
      // fail loudly rather than silently appearing to work.
      razorpayPaymentId: sc.paid === 'paid' ? `pay_TEST${Date.now()}${i}` : undefined,
      orderStatus: 'placed',
      statusHistory: [{ status: 'placed', note: 'Order placed by customer', at: placedAt }],
      tracking: { estimatedDeliveryAt: new Date(Date.now() + 2 * 60 * 60 * 1000) },
      createdBy: user._id,
      createdAt: placedAt,
      updatedAt: placedAt,
    });

    await EPharmacyOrder.updateOne(
      { _id: order._id },
      { $set: { createdAt: placedAt, updatedAt: placedAt } },
      { timestamps: false },
    );

    created.push({ order, sc });
  }

  console.log(`Created ${created.length} order(s) awaiting your action:\n`);
  for (const { order, sc } of created) {
    console.log(`  ${order.orderNumber}  Rs ${order.totalAmount}  ${sc.pay.toUpperCase()}  ${order.items.length} items`);
    console.log(`     ${sc.note}\n`);
  }
  console.log('Open the Orders tab — both appear as NEW ORDER cards with a live timer.');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('\n' + error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
