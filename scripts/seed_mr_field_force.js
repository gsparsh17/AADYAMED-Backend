/**
 * Provisions a complete MR (medical representative) field force so the MR
 * module can actually be logged into and exercised.
 *
 * The MR reporting chain is strict — MR reports to ABM, ABM to RBM, RBM to
 * ZSM (controllers/mr.controller.js REQUIRED_MANAGER) — so a single MR login
 * is not enough on its own: without managers above it the team, hierarchy and
 * approval screens have nothing to show, and without accounts, visits and
 * targets the dashboard is all zeroes. This seeds the whole ladder plus a
 * month of realistic activity.
 *
 * Everything it writes is tagged so it can be removed again: users by the
 * SEED_DOMAIN e-mail domain, territories and POB orders by their code prefix.
 *
 * Usage:
 *   node scripts/seed_mr_field_force.js            # create (skips what exists)
 *   node scripts/seed_mr_field_force.js --reset    # wipe seeded data, recreate
 *   node scripts/seed_mr_field_force.js --purge    # wipe seeded data, stop
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const User = require('../models/User');
const MRProfile = require('../models/MRProfile');
const MRTerritory = require('../models/MRTerritory');
const MRAccount = require('../models/MRAccount');
const MRVisit = require('../models/MRVisit');
const MRAttendance = require('../models/MRAttendance');
const MRTourPlan = require('../models/MRTourPlan');
const MRExpense = require('../models/MRExpense');
const MRTarget = require('../models/MRTarget');
const MRPOB = require('../models/MRPOB');
const MRSampleLedger = require('../models/MRSampleLedger');
const MRDetailingContent = require('../models/MRDetailingContent');

// The User model's e-mail regex only accepts 2-3 character trailing labels,
// so an obviously-fake domain like 'mrfield.test' would be rejected.
const SEED_DOMAIN = 'aadya-mr.in';
const CODE_PREFIX = 'MRT';
const POB_PREFIX = 'POBT-';
const PASSWORD = 'Mr@12345';

const has = (name) => process.argv.includes(`--${name}`);

const now = new Date();
const MONTH = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n, hour = 10) => {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d;
};

// Indore geography, so geofence checks have plausible coordinates.
const HQ = { lat: 22.7196, lng: 75.8577 };
const near = (i) => ({
  lat: HQ.lat + (i % 5) * 0.004 - 0.008,
  lng: HQ.lng + (i % 4) * 0.005 - 0.01,
});

// Ordered top-down: each level's manager must already exist when it is made.
const PEOPLE = [
  { key: 'zsm', designation: 'ZSM', name: 'Rajeev Malhotra', local: 'zsm', phone: '9900110001', hq: 'Bhopal', zone: 'West' },
  { key: 'rbm', designation: 'RBM', name: 'Sunita Deshpande', local: 'rbm', phone: '9900110002', hq: 'Indore', zone: 'West', manager: 'zsm' },
  { key: 'abm', designation: 'ABM', name: 'Farhan Qureshi', local: 'abm', phone: '9900110003', hq: 'Indore', zone: 'West', manager: 'rbm' },
  { key: 'mr1', designation: 'MR', name: 'Ankit Sharma', local: 'mr', phone: '9900110004', hq: 'Indore', zone: 'West', manager: 'abm', primary: true },
  { key: 'mr2', designation: 'MR', name: 'Priya Nair', local: 'mr2', phone: '9900110005', hq: 'Indore', zone: 'West', manager: 'abm' },
];

const TERRITORIES = [
  { code: `${CODE_PREFIX}-IND-01`, name: 'Indore Central', city: 'Indore', pincodes: ['452001', '452003'] },
  { code: `${CODE_PREFIX}-IND-02`, name: 'Indore East', city: 'Indore', pincodes: ['452010', '452016'] },
  { code: `${CODE_PREFIX}-BPL-01`, name: 'Bhopal North', city: 'Bhopal', pincodes: ['462001', '462003'] },
];

const ACCOUNTS = [
  { type: 'doctor', name: 'Dr. Meenakshi Rao', specialty: 'Cardiology', org: 'Sanjeevani Heart Centre', cls: 'A', freq: 3, value: 180000, terr: 0, line1: '21, Race Course Road', pin: '452003' },
  { type: 'doctor', name: 'Dr. Ashwin Kulkarni', specialty: 'Orthopaedics', org: 'Apex Bone & Joint', cls: 'A', freq: 2, value: 145000, terr: 0, line1: '4, Palasia Square', pin: '452001' },
  { type: 'doctor', name: 'Dr. Sneha Bhatt', specialty: 'Paediatrics', org: 'Little Steps Clinic', cls: 'B', freq: 2, value: 80000, terr: 1, line1: '88, Vijay Nagar', pin: '452010' },
  { type: 'doctor', name: 'Dr. Imran Shaikh', specialty: 'Diabetology', org: 'Metro Diabetes Care', cls: 'B', freq: 2, value: 96000, terr: 1, line1: '12, Scheme 54', pin: '452010' },
  { type: 'doctor', name: 'Dr. Kavita Jain', specialty: 'Dermatology', org: 'Glow Skin Clinic', cls: 'C', freq: 1, value: 42000, terr: 1, line1: '7, Saket Nagar', pin: '452016' },
  { type: 'chemist', name: 'Shree Medicos', specialty: null, org: 'Shree Medicos', cls: 'A', freq: 4, value: 260000, terr: 0, line1: 'Shop 3, MG Road', pin: '452001' },
  { type: 'chemist', name: 'Nirmal Pharmacy', specialty: null, org: 'Nirmal Pharmacy', cls: 'B', freq: 3, value: 120000, terr: 0, line1: '15, Sapna Sangeeta', pin: '452001' },
  { type: 'chemist', name: 'Vijay Nagar Chemist', specialty: null, org: 'Vijay Nagar Chemist', cls: 'B', freq: 3, value: 110000, terr: 1, line1: '2, Scheme 78', pin: '452010' },
  { type: 'stockist', name: 'Malwa Distributors', specialty: null, org: 'Malwa Distributors', cls: 'A', freq: 1, value: 900000, terr: 0, line1: 'Plot 40, Sanwer Road', pin: '452015' },
  { type: 'hospital', name: 'Arihant Hospital', specialty: 'Multi-speciality', org: 'Arihant Hospital', cls: 'A', freq: 1, value: 520000, terr: 1, line1: 'Ring Road, Vijay Nagar', pin: '452010' },
];

const PRODUCTS = [
  { productName: 'Cardiplus 40', brand: 'Cardiplus', sku: 'CRD40', rate: 148 },
  { productName: 'Osteomax D3', brand: 'Osteomax', sku: 'OSTD3', rate: 96 },
  { productName: 'Pedisyp 60ml', brand: 'Pedisyp', sku: 'PDS60', rate: 72 },
  { productName: 'Glycostat 500', brand: 'Glycostat', sku: 'GLY500', rate: 118 },
];

async function purge() {
  const users = await User.find({ email: new RegExp(`@${SEED_DOMAIN}$`) }).select('_id');
  const userIds = users.map((u) => u._id);
  const profiles = await MRProfile.find({ userId: { $in: userIds } }).select('_id');
  const profileIds = profiles.map((p) => p._id);

  const dropped = {
    visits: (await MRVisit.deleteMany({ profileId: { $in: profileIds } })).deletedCount,
    attendance: (await MRAttendance.deleteMany({ profileId: { $in: profileIds } })).deletedCount,
    tourPlans: (await MRTourPlan.deleteMany({ profileId: { $in: profileIds } })).deletedCount,
    expenses: (await MRExpense.deleteMany({ profileId: { $in: profileIds } })).deletedCount,
    targets: (await MRTarget.deleteMany({ profileId: { $in: profileIds } })).deletedCount,
    pob: (await MRPOB.deleteMany({ orderNumber: new RegExp(`^${POB_PREFIX}`) })).deletedCount,
    samples: (await MRSampleLedger.deleteMany({ profileId: { $in: profileIds } })).deletedCount,
    detailing: (await MRDetailingContent.deleteMany({ createdByUserId: { $in: userIds } })).deletedCount,
    accounts: (await MRAccount.deleteMany({ assignedProfileIds: { $in: profileIds } })).deletedCount,
    territories: (await MRTerritory.deleteMany({ code: new RegExp(`^${CODE_PREFIX}-`) })).deletedCount,
    profiles: (await MRProfile.deleteMany({ _id: { $in: profileIds } })).deletedCount,
    users: (await User.deleteMany({ _id: { $in: userIds } })).deletedCount,
  };

  const total = Object.values(dropped).reduce((a, b) => a + b, 0);
  console.log(`Removed ${total} seeded document(s).`);
  Object.entries(dropped)
    .filter(([, n]) => n > 0)
    .forEach(([k, n]) => console.log(`  ${k.padEnd(12)} ${n}`));
  if (total === 0) console.log('  (nothing was there)');
  return total;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set in .env');
  await mongoose.connect(process.env.MONGO_URI);

  if (has('purge') || has('reset')) {
    await purge();
    if (has('purge')) {
      await mongoose.disconnect();
      return;
    }
    console.log('');
  }

  // Phone numbers must be unique across the whole User collection: OTP login
  // resolves an account by phone and refuses an ambiguous match.
  for (const person of PEOPLE) {
    const clash = await User.findOne({
      phone: person.phone,
      email: { $not: new RegExp(`@${SEED_DOMAIN}$`) },
    }).select('email role');
    if (clash) {
      throw new Error(
        `Phone ${person.phone} is already on ${clash.email} (${clash.role}). `
        + 'Change the number in PEOPLE before seeding, or OTP login will be ambiguous.',
      );
    }
  }

  // ---- territories --------------------------------------------------
  const territories = [];
  for (const t of TERRITORIES) {
    let doc = await MRTerritory.findOne({ code: t.code });
    if (!doc) {
      doc = await MRTerritory.create({
        code: t.code,
        name: t.name,
        headquarters: t.city,
        city: t.city,
        state: 'Madhya Pradesh',
        pincodes: t.pincodes,
        isActive: true,
      });
    }
    territories.push(doc);
  }

  // ---- people -------------------------------------------------------
  const byKey = {};
  for (const person of PEOPLE) {
    const email = `${person.local}@${SEED_DOMAIN}`;
    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        email,
        password: PASSWORD, // hashed by the User pre('save') hook
        name: person.name,
        phone: person.phone,
        role: 'mr',
        isVerified: true,
        isActive: true,
        profileCompleted: false,
        registrationSource: 'admin',
      });
    }

    const employeeCode = `${CODE_PREFIX}${String(person.phone).slice(-3)}`;
    let profile = await MRProfile.findOne({ userId: user._id });
    if (!profile) {
      profile = await MRProfile.create({
        userId: user._id,
        employeeCode,
        designation: person.designation,
        managerId: person.manager ? byKey[person.manager].profile._id : null,
        headquarters: person.hq,
        division: 'Cardio-Diabetic',
        state: 'Madhya Pradesh',
        zone: person.zone,
        // Field users carry territories; managers cover them through reports.
        territoryIds: person.designation === 'MR'
          ? (person.key === 'mr1' ? [territories[0]._id, territories[1]._id] : [territories[2]._id])
          : [],
        productLine: 'Cardio-Diabetic',
        dateOfJoining: daysAgo(400),
        reportingEnabled: true,
        isActive: true,
      });
    }

    if (!user.profileCompleted || String(user.profileId || '') !== String(profile._id)) {
      user.profileCompleted = true;
      user.profileId = profile._id;
      user.profileModel = 'MRProfile';
      await user.save();
    }

    byKey[person.key] = { user, profile, person };
  }

  const mr1 = byKey.mr1.profile;
  const mr2 = byKey.mr2.profile;
  const abm = byKey.abm.profile;

  await MRTerritory.updateMany(
    { _id: { $in: territories.map((t) => t._id) } },
    { $set: { managerProfileId: abm._id } },
  );

  // ---- accounts: the doctors, chemists and stockists being called on --
  const accounts = [];
  for (let i = 0; i < ACCOUNTS.length; i += 1) {
    const a = ACCOUNTS[i];
    // Every third account also goes to the second MR, so joint work and the
    // team screens have something to show.
    const assigned = i % 3 === 2 ? [mr1._id, mr2._id] : [mr1._id];
    let doc = await MRAccount.findOne({ name: a.name, 'address.city': 'Indore' });
    if (!doc) {
      doc = await MRAccount.create({
        type: a.type,
        name: a.name,
        specialty: a.specialty || undefined,
        registrationNumber: a.type === 'doctor' ? `MP/${20000 + i}` : undefined,
        phone: `98201100${String(i).padStart(2, '0')}`,
        email: `${a.name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '')}@${SEED_DOMAIN}`,
        organizationName: a.org,
        address: {
          line1: a.line1,
          locality: territories[a.terr].name,
          city: 'Indore',
          state: 'Madhya Pradesh',
          pincode: a.pin,
        },
        location: near(i),
        territoryId: territories[a.terr]._id,
        assignedProfileIds: assigned,
        classification: a.cls,
        visitFrequencyPerMonth: a.freq,
        potentialValue: a.value,
        isActive: true,
        createdBy: abm._id,
      });
    }
    accounts.push(doc);
  }

  // ---- targets for the month -----------------------------------------
  const TARGETS = [
    { profile: mr1, setBy: abm, calls: 240, doctor: 170, chemist: 70, pob: 900000, sales: 1100000, days: 24 },
    { profile: mr2, setBy: abm, calls: 220, doctor: 150, chemist: 70, pob: 750000, sales: 900000, days: 24 },
    { profile: abm, setBy: byKey.rbm.profile, calls: 60, doctor: 45, chemist: 15, pob: 1800000, sales: 2200000, days: 24 },
  ];
  for (const t of TARGETS) {
    await MRTarget.updateOne(
      { profileId: t.profile._id, month: MONTH },
      {
        $set: {
          callTarget: t.calls,
          doctorCallTarget: t.doctor,
          chemistCallTarget: t.chemist,
          pobTarget: t.pob,
          salesTarget: t.sales,
          workingDaysTarget: t.days,
          setBy: t.setBy._id,
        },
      },
      { upsert: true },
    );
  }

  // ---- attendance: the working days so far this month -----------------
  let attendanceDays = 0;
  for (let back = 1; back <= 20; back += 1) {
    const day = daysAgo(back, 9);
    if (day.getMonth() !== now.getMonth()) break; // stay inside this month
    if (day.getDay() === 0) continue; // Sundays off
    const out = new Date(day);
    out.setHours(18, 30, 0, 0);
    await MRAttendance.updateOne(
      { profileId: mr1._id, dateKey: dayKey(day) },
      {
        $set: {
          punchIn: { at: day, lat: HQ.lat, lng: HQ.lng, accuracy: 12 },
          punchOut: { at: out, lat: HQ.lat, lng: HQ.lng, accuracy: 14 },
          workType: back % 7 === 0 ? 'meeting' : 'field',
          status: back % 9 === 0 ? 'half_day' : 'present',
        },
      },
      { upsert: true },
    );
    attendanceDays += 1;
  }

  // ---- visits: a month of calls in every state the screens render -----
  // Statuses are spread on purpose: approved ones feed the dashboard's call
  // count, submitted ones sit in the ABM's approval queue, and a planned one
  // is left un-actioned so check-in and check-out can be walked by hand.
  const VISIT_PLAN = [
    { back: 1, acct: 0, status: 'planned', geo: 'unknown' },
    { back: 1, acct: 5, status: 'checked_in', geo: 'inside' },
    { back: 2, acct: 1, status: 'submitted', geo: 'inside', pob: 42600 },
    { back: 2, acct: 6, status: 'submitted', geo: 'inside' },
    { back: 3, acct: 2, status: 'approved', geo: 'inside', pob: 18400 },
    { back: 4, acct: 3, status: 'approved', geo: 'outside' },
    { back: 5, acct: 7, status: 'approved', geo: 'inside', pob: 31200 },
    { back: 6, acct: 0, status: 'approved', geo: 'inside' },
    { back: 7, acct: 8, status: 'approved', geo: 'inside', pob: 126000 },
    { back: 8, acct: 4, status: 'approved', geo: 'inside' },
    { back: 9, acct: 9, status: 'approved', geo: 'inside', pob: 74500 },
    { back: 10, acct: 5, status: 'approved', geo: 'inside' },
    { back: 11, acct: 1, status: 'rejected', geo: 'outside' },
    { back: 12, acct: 2, status: 'approved', geo: 'inside' },
  ];

  let pobSeq = await MRPOB.countDocuments({ orderNumber: new RegExp(`^${POB_PREFIX}`) });
  const visitsMade = [];
  for (const v of VISIT_PLAN) {
    const account = accounts[v.acct];
    const visitDate = daysAgo(v.back, 11);
    if (await MRVisit.exists({ profileId: mr1._id, accountId: account._id, visitDate })) continue;

    const out = new Date(visitDate);
    out.setMinutes(out.getMinutes() + 35);
    const product = PRODUCTS[v.acct % PRODUCTS.length];
    const started = v.status !== 'planned';
    const finished = ['completed', 'submitted', 'approved', 'rejected'].includes(v.status);

    let pobOrder = null;
    if (v.pob) {
      pobSeq += 1;
      const quantity = Math.max(1, Math.round(v.pob / product.rate));
      pobOrder = await MRPOB.create({
        orderNumber: `${POB_PREFIX}${String(pobSeq).padStart(3, '0')}`,
        profileId: mr1._id,
        accountId: account._id,
        orderDate: visitDate,
        items: [{
          productName: product.productName,
          sku: product.sku,
          quantity,
          rate: product.rate,
          amount: quantity * product.rate,
        }],
        totalAmount: quantity * product.rate,
        status: v.back > 6 ? 'fulfilled' : 'accepted',
        notes: `Raised during the call on ${account.name}`,
      });
    }

    const visit = await MRVisit.create({
      profileId: mr1._id,
      accountId: account._id,
      visitDate,
      status: v.status,
      checkIn: started ? { ...near(v.acct), accuracy: 10, capturedAt: visitDate } : undefined,
      checkOut: finished ? { ...near(v.acct), accuracy: 12, capturedAt: out } : undefined,
      checkInDistanceMeters: started ? (v.geo === 'outside' ? 840 : 45) : undefined,
      geofenceStatus: v.geo,
      callType: v.acct % 5 === 0 ? 'joint' : 'solo',
      jointWithProfileIds: v.acct % 5 === 0 ? [abm._id] : [],
      productsDiscussed: finished
        ? [{ productName: product.productName, brand: product.brand, notes: 'Detailed efficacy and dosing' }]
        : [],
      samples: finished ? [{ productName: product.productName, batchNumber: 'B2409', quantity: 2 }] : [],
      discussionNotes: finished
        ? `Discussed ${product.productName} positioning and current prescribing habits.`
        : undefined,
      doctorFeedback: finished ? 'Open to trialling with new patients next cycle.' : undefined,
      nextVisitDate: daysAgo(-7, 11),
      pobAmount: v.pob || 0,
      pobOrderId: pobOrder ? pobOrder._id : null,
      submittedAt: ['submitted', 'approved', 'rejected'].includes(v.status) ? out : undefined,
      approvedBy: ['approved', 'rejected'].includes(v.status) ? abm._id : null,
      approvedAt: ['approved', 'rejected'].includes(v.status) ? daysAgo(v.back - 1, 19) : undefined,
      managerComment: v.status === 'rejected'
        ? 'Check-in was 840 m away — re-do the DCR from the correct location.'
        : undefined,
    });
    visitsMade.push(visit);
  }

  // ---- sample ledger: stock issued, drawn down by the calls above -----
  for (let i = 0; i < PRODUCTS.length; i += 1) {
    const product = PRODUCTS[i];
    await MRSampleLedger.updateOne(
      { sourceKey: `seed-issue-${product.sku}` },
      {
        $set: {
          profileId: mr1._id,
          transactionDate: daysAgo(18, 10),
          itemType: 'sample',
          productName: product.productName,
          batchNumber: 'B2409',
          transactionType: 'issue',
          quantity: 60,
          notes: 'Opening stock issued from the depot',
          createdBy: abm._id,
        },
      },
      { upsert: true },
    );
    await MRSampleLedger.updateOne(
      { sourceKey: `seed-consume-${product.sku}` },
      {
        $set: {
          profileId: mr1._id,
          transactionDate: daysAgo(4, 17),
          itemType: 'sample',
          productName: product.productName,
          batchNumber: 'B2409',
          transactionType: 'consume',
          quantity: 12 + i * 4,
          accountId: accounts[i]._id,
          notes: 'Left with the doctor during detailing',
          createdBy: mr1._id,
        },
      },
      { upsert: true },
    );
  }

  // ---- expenses: one of each state the approval screen handles --------
  const EXPENSES = [
    { back: 2, category: 'travel', amount: 1450, description: 'Indore-Dewas-Indore by cab', status: 'submitted' },
    { back: 3, category: 'daily_allowance', amount: 600, description: 'Daily allowance', status: 'submitted' },
    { back: 6, category: 'local_conveyance', amount: 320, description: 'Auto fares, Palasia beat', status: 'approved' },
    { back: 9, category: 'lodging', amount: 2200, description: 'Overnight halt, Ujjain', status: 'paid' },
    { back: 1, category: 'meals', amount: 380, description: 'Working lunch with chemist', status: 'draft' },
  ];
  for (const e of EXPENSES) {
    const expenseDate = daysAgo(e.back, 20);
    if (await MRExpense.exists({ profileId: mr1._id, expenseDate, category: e.category })) continue;
    await MRExpense.create({
      profileId: mr1._id,
      expenseDate,
      category: e.category,
      amount: e.amount,
      description: e.description,
      status: e.status,
      submittedAt: e.status === 'draft' ? undefined : expenseDate,
      approvedBy: ['approved', 'paid'].includes(e.status) ? abm._id : null,
      approvedAt: ['approved', 'paid'].includes(e.status) ? daysAgo(e.back - 1, 12) : undefined,
    });
  }

  // ---- tour plan: this month, submitted so the ABM has one to approve -
  const planDays = [];
  for (let d = 0; d < 12; d += 1) {
    const date = daysAgo(-d, 10); // forward from today
    if (date.getDay() === 0) continue;
    const territory = territories[d % 2];
    planDays.push({
      date,
      area: territory.name,
      objective: d % 3 === 0 ? 'Chemist coverage and stock check' : 'Doctor detailing',
      accountIds: accounts
        .filter((a) => String(a.territoryId) === String(territory._id))
        .slice(0, 3)
        .map((a) => a._id),
    });
  }
  await MRTourPlan.updateOne(
    { profileId: mr1._id, month: MONTH },
    { $set: { days: planDays, status: 'submitted', submittedAt: daysAgo(1, 21) } },
    { upsert: true },
  );
  await MRTourPlan.updateOne(
    { profileId: mr2._id, month: MONTH },
    { $set: { days: planDays.slice(0, 6), status: 'draft' } },
    { upsert: true },
  );

  // ---- detailing library ---------------------------------------------
  const DETAILING = [
    { title: 'Cardiplus 40 - clinical summary', productName: 'Cardiplus 40', contentType: 'pdf', url: 'https://example.com/detailing/cardiplus-40.pdf', tags: ['cardio', 'clinical'] },
    { title: 'Osteomax D3 - dosing visual aid', productName: 'Osteomax D3', contentType: 'image', url: 'https://example.com/detailing/osteomax-d3.png', tags: ['ortho'] },
    { title: 'Glycostat 500 - MOA animation', productName: 'Glycostat 500', contentType: 'video', url: 'https://example.com/detailing/glycostat-moa.mp4', tags: ['diabetes'] },
  ];
  for (const d of DETAILING) {
    await MRDetailingContent.updateOne(
      { title: d.title },
      { $set: { ...d, isActive: true, createdByUserId: byKey.abm.user._id } },
      { upsert: true },
    );
  }

  // ---- report ---------------------------------------------------------
  const line = (label, value) => console.log(`  ${label.padEnd(14)} ${value}`);
  console.log('MR field force ready.\n');
  console.log('Sign in to AadyaPlus Professional with any of these:\n');
  for (const person of PEOPLE) {
    const { user, profile } = byKey[person.key];
    const tag = person.primary ? '   <- start here' : '';
    console.log(`  ${profile.designation.padEnd(4)} ${user.email.padEnd(30)} ${user.phone}  ${profile.employeeCode}${tag}`);
  }
  console.log(`\n  password       ${PASSWORD}   (same for all five)`);
  console.log('\nReporting chain: MR -> ABM -> RBM -> ZSM. A manager sees everyone below them.\n');
  line('month', MONTH);
  line('territories', await MRTerritory.countDocuments({ code: new RegExp(`^${CODE_PREFIX}-`) }));
  line('accounts', accounts.length);
  line('visits', await MRVisit.countDocuments({ profileId: mr1._id }));
  line('attendance', `${attendanceDays} day(s)`);
  line('POB orders', await MRPOB.countDocuments({ orderNumber: new RegExp(`^${POB_PREFIX}`) }));
  line('expenses', await MRExpense.countDocuments({ profileId: mr1._id }));
  line('tour plans', await MRTourPlan.countDocuments({ profileId: { $in: [mr1._id, mr2._id] } }));
  line('samples', await MRSampleLedger.countDocuments({ profileId: mr1._id }));

  console.log('\nWhat to try:');
  console.log(`  as the MR  (${byKey.mr1.user.email})`);
  console.log('     punch in, open the planned call on Dr. Meenakshi Rao, check in,');
  console.log('     record products and samples, then check out and submit the DCR.');
  console.log(`  as the ABM (${byKey.abm.user.email})`);
  console.log('     the Team tab lists both MRs; two DCRs, two expenses and one tour');
  console.log('     plan are waiting for approval.');
  console.log('\nRun with --purge to remove everything this script created.');

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('\n' + error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
