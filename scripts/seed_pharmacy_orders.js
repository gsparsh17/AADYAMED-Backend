/**
 * Seeds sample e-pharmacy (customer) orders against a real pharmacy branch, so
 * the Orders screen can be exercised in every status it renders.
 *
 * Usage:
 *   node scripts/seed_pharmacy_orders.js                     # newest pharmacy user
 *   node scripts/seed_pharmacy_orders.js --email=me@shop.com # a specific login
 *   node scripts/seed_pharmacy_orders.js --clear             # remove seeded orders
 *   node scripts/seed_pharmacy_orders.js --clear --email=... # both
 *
 * Every order it writes gets an `EOSEED-xxxx` order number. Nothing else is
 * touched, and `--clear` deletes only orders carrying that prefix — real orders
 * are never at risk.
 *
 * Note on "hospital orders": there is no hospital/B2B order model. This
 * collection (EPharmacyOrder) is customer -> pharmacy only. The pharmacy's
 * inbound-from-supplier flow is PurchaseOrder, which is the Procurement screen,
 * not this one.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const User = require('../models/User');
const PatientProfile = require('../models/PatientProfile');
const PharmacyStore = require('../models/PharmacyStore');
const Medicine = require('../models/Medicine');
const EPharmacyOrder = require('../models/EPharmacyOrder');

const SEED_PREFIX = 'EOSEED-';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=').trim() : null;
};
const flag = (name) => process.argv.includes(`--${name}`);

const CUSTOMERS = [
  { name: 'Rahul Sharma', phone: '9812340001', gender: 'male', city: 'Indore', line1: '204, Silver Sands Apartments', line2: 'Scheme 54, Vijay Nagar', pincode: '452010' },
  { name: 'Ananya Iyer', phone: '9812340002', gender: 'female', city: 'Indore', line1: 'B-12, Shalimar Township', line2: 'AB Road', pincode: '452012' },
  { name: 'Mohammed Faiz', phone: '9812340003', gender: 'male', city: 'Indore', line1: '7, Khatiwala Tank', line2: 'Near Geeta Bhawan', pincode: '452014' },
  { name: 'Priya Deshmukh', phone: '9812340004', gender: 'female', city: 'Indore', line1: 'Flat 302, Aakriti Residency', line2: 'Bicholi Mardana', pincode: '452016' },
  { name: 'Sanjay Verma', phone: '9812340005', gender: 'male', city: 'Indore', line1: '18, Anoop Nagar', line2: 'Near Bhawarkua Square', pincode: '452001' },
  { name: 'Kavya Nair', phone: '9812340006', gender: 'female', city: 'Indore', line1: '55, Palasia Main Road', line2: 'Old Palasia', pincode: '452018' },
];

/**
 * One entry per card state the Orders screen can show. `age` is hours ago, so
 * the list arrives sorted newest-first with a believable spread.
 */
const SCENARIOS = [
  { status: 'prescription_review', rx: 'pending_review', pay: 'cod',    paid: 'pending', age: 0.4, items: 2, note: 'Prescription uploaded, waiting for pharmacist review' },
  { status: 'placed',              rx: 'not_required',  pay: 'online', paid: 'paid',    age: 1.5, items: 3, note: 'Payment received' },
  { status: 'placed',              rx: 'approved',      pay: 'cod',    paid: 'pending', age: 3,   items: 1, note: 'Prescription approved' },
  { status: 'confirmed',           rx: 'not_required',  pay: 'online', paid: 'paid',    age: 6,   items: 4, note: 'Confirmed and billed' },
  { status: 'packing',             rx: 'not_required',  pay: 'cod',    paid: 'pending', age: 9,   items: 2, note: 'Being packed' },
  { status: 'ready_to_ship',       rx: 'approved',      pay: 'online', paid: 'paid',    age: 20,  items: 3, note: 'Packed, awaiting pickup' },
  { status: 'shipped',             rx: 'not_required',  pay: 'online', paid: 'paid',    age: 30,  items: 2, note: 'Handed to courier' },
  { status: 'out_for_delivery',    rx: 'not_required',  pay: 'cod',    paid: 'pending', age: 34,  items: 1, note: 'Out for delivery' },
  { status: 'delivered',           rx: 'approved',      pay: 'online', paid: 'paid',    age: 54,  items: 5, note: 'Delivered to customer' },
  { status: 'delivered',           rx: 'not_required',  pay: 'cod',    paid: 'paid',    age: 78,  items: 2, note: 'Delivered, cash collected' },
  { status: 'cancelled',           rx: 'not_required',  pay: 'online', paid: 'refunded',age: 96,  items: 2, note: 'Cancelled by customer', reason: 'Customer cancelled before dispatch' },
  { status: 'returned',            rx: 'not_required',  pay: 'online', paid: 'refunded',age: 140, items: 1, note: 'Returned after delivery', reason: 'Wrong strength delivered' },
];

const round = (n) => Math.round(n * 100) / 100;
const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000);

async function resolvePharmacy() {
  const email = arg('email');
  const query = { role: 'pharmacy' };
  if (email) query.email = email.toLowerCase();

  const user = await User.findOne(query).sort({ updatedAt: -1 });
  if (!user) {
    throw new Error(
      email
        ? `No pharmacy user with email ${email}`
        : 'No pharmacy user found in this database'
    );
  }
  if (!user.organizationId) {
    throw new Error(
      `${user.email} has no organizationId yet — open the app once as this user so the tenant provisions itself, then re-run.`
    );
  }

  const storeCode = arg('store');
  const store = storeCode
    ? await PharmacyStore.findOne({ organizationId: user.organizationId, code: storeCode.toUpperCase() })
    : (await PharmacyStore.findById(user.defaultPharmacyStoreId)) ||
      (await PharmacyStore.findOne({ organizationId: user.organizationId, isDefault: true }));

  if (!store) throw new Error('Could not resolve a pharmacy store for this user');
  return { user, store };
}

async function ensureCustomers() {
  const profiles = [];
  for (const c of CUSTOMERS) {
    const email = `${c.name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;

    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        name: c.name,
        email,
        // Hashed by the model's pre-save hook. These are throwaway demo logins.
        password: 'Seed@12345',
        phone: c.phone,
        role: 'patient',
        isActive: true,
      });
    }

    let profile = await PatientProfile.findOne({ userId: user._id });
    if (!profile) {
      const [firstName, ...rest] = c.name.split(' ');
      profile = await PatientProfile.create({
        userId: user._id,
        name: c.name,
        firstName,
        lastName: rest.join(' ') || undefined,
        email,
        phone: c.phone,
        gender: c.gender,
        dateOfBirth: new Date(1990, 0, 1),
      });
    }
    profiles.push({ profile, address: c });
  }
  return profiles;
}

function buildItems(medicines, count) {
  const items = [];
  let subtotal = 0;
  let tax = 0;
  let medicineDiscount = 0;

  for (let i = 0; i < count; i += 1) {
    const med = medicines[(i * 3 + count) % medicines.length];
    const quantity = 1 + ((i + count) % 3);
    const unitPrice = Number(med.sellingPrice) || 50;
    const listedAmount = round(unitPrice * quantity);
    const discount = i === 0 ? round(listedAmount * 0.05) : 0;
    const taxableAmount = round(listedAmount - discount);
    const taxRate = Number(med.taxRate) || 12;
    const taxAmount = round((taxableAmount * taxRate) / 100);

    items.push({
      medicineId: med._id,
      medicineName: med.medicineName,
      genericName: med.genericName,
      quantity,
      unit: med.unit,
      hsnCode: med.hsnCode,
      prescriptionRequired: med.prescriptionRequired === true,
      unitPrice,
      listedAmount,
      medicineDiscount: discount,
      taxableAmount,
      taxRate,
      taxAmount,
      totalAmount: round(taxableAmount + taxAmount),
    });

    subtotal += listedAmount;
    medicineDiscount += discount;
    tax += taxAmount;
  }

  return { items, subtotal: round(subtotal), medicineDiscount: round(medicineDiscount), tax: round(tax) };
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set in .env');
  await mongoose.connect(uri);

  const { user, store } = await resolvePharmacy();
  const scope = { organizationId: user.organizationId, storeId: store._id };
  console.log(`Pharmacy : ${user.email}`);
  console.log(`Branch   : ${store.name} (${store.code})`);

  if (flag('clear')) {
    const { deletedCount } = await EPharmacyOrder.deleteMany({
      ...scope,
      orderNumber: new RegExp(`^${SEED_PREFIX}`),
    });
    console.log(`Removed ${deletedCount} seeded order(s).`);
    if (!flag('seed')) return mongoose.disconnect();
  }

  const medicines = await Medicine.find({ ...scope, isActive: true }).limit(25);
  if (medicines.length === 0) {
    throw new Error(
      'This branch has no medicines. Add a few (or run the bulk upload) first — an order has to reference real stock.'
    );
  }
  console.log(`Medicines: ${medicines.length} available to draw from`);

  const customers = await ensureCustomers();
  const existing = await EPharmacyOrder.countDocuments({
    ...scope,
    orderNumber: new RegExp(`^${SEED_PREFIX}`),
  });
  if (existing > 0) {
    console.log(`\n${existing} seeded order(s) already exist. Re-run with --clear first to replace them.`);
    return mongoose.disconnect();
  }

  const docs = [];
  SCENARIOS.forEach((sc, index) => {
    const { profile, address } = customers[index % customers.length];
    const { items, subtotal, medicineDiscount, tax } = buildItems(medicines, sc.items);
    const deliveryFee = sc.pay === 'online' ? 0 : 40;
    const couponDiscount = index % 4 === 0 ? 50 : 0;
    const totalAmount = round(subtotal - medicineDiscount - couponDiscount + tax + deliveryFee);
    const placedAt = hoursAgo(sc.age);

    const history = [{ status: 'placed', note: 'Order placed by customer', at: placedAt }];
    if (sc.status !== 'placed' && sc.status !== 'prescription_review') {
      history.push({ status: sc.status, note: sc.note, at: hoursAgo(Math.max(0, sc.age - 1)) });
    }

    const shipped = ['shipped', 'out_for_delivery', 'delivered', 'returned'].includes(sc.status);
    const delivered = ['delivered', 'returned'].includes(sc.status);

    docs.push({
      orderNumber: `${SEED_PREFIX}${String(index + 1).padStart(4, '0')}`,
      ...scope,
      patientId: profile._id,
      items,
      deliveryAddress: {
        label: 'Home',
        contactName: profile.name,
        phone: profile.phone,
        line1: address.line1,
        line2: address.line2,
        city: address.city,
        state: 'Madhya Pradesh',
        pincode: address.pincode,
        country: 'India',
      },
      deliveryInstructions: index % 3 === 0 ? 'Call before arriving' : undefined,
      prescriptionRequired: sc.rx !== 'not_required',
      prescriptionStatus: sc.rx,
      couponCode: couponDiscount > 0 ? 'SAVE50' : undefined,
      subtotal,
      medicineDiscount,
      couponDiscount,
      tax,
      deliveryFee,
      totalAmount,
      paymentMethod: sc.pay,
      paymentStatus: sc.paid,
      paymentDate: sc.paid === 'paid' ? placedAt : undefined,
      refundAmount: sc.paid === 'refunded' ? totalAmount : 0,
      refundedAt: sc.paid === 'refunded' ? hoursAgo(Math.max(0, sc.age - 4)) : undefined,
      orderStatus: sc.status,
      statusHistory: history,
      tracking: shipped
        ? {
            carrier: 'Delhivery',
            trackingNumber: `DL${String(90000 + index)}IN`,
            estimatedDeliveryAt: hoursAgo(sc.age - 48),
            shippedAt: hoursAgo(Math.max(0, sc.age - 2)),
            outForDeliveryAt: sc.status === 'out_for_delivery' || delivered ? hoursAgo(Math.max(0, sc.age - 3)) : undefined,
            deliveredAt: delivered ? hoursAgo(Math.max(0, sc.age - 4)) : undefined,
          }
        : undefined,
      cancellationReason: sc.reason,
      cancelledAt: sc.status === 'cancelled' ? hoursAgo(Math.max(0, sc.age - 2)) : undefined,
      createdBy: user._id,
      createdAt: placedAt,
      updatedAt: placedAt,
    });
  });

  const created = await EPharmacyOrder.insertMany(docs);

  // insertMany honours timestamps only on insert; force createdAt back so the
  // list sorts and the "2h ago" labels read the way the scenarios intend.
  await Promise.all(
    created.map((doc, i) =>
      EPharmacyOrder.updateOne(
        { _id: doc._id },
        { $set: { createdAt: docs[i].createdAt, updatedAt: docs[i].updatedAt } },
        { timestamps: false }
      )
    )
  );

  console.log(`\nCreated ${created.length} orders:`);
  created.forEach((o) => console.log(`  ${o.orderNumber}  ${o.orderStatus.padEnd(20)} Rs ${o.totalAmount}`));
  console.log('\nPull to refresh the Orders tab to see them.');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('\n' + error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
