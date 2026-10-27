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
const MRLeave = require('../models/MRLeave');
const DoctorProfile = require('../models/DoctorProfile');
const PharmacyStore = require('../models/PharmacyStore');
const fs = require('fs');
const path = require('path');

// ============================================
// Constants
// ============================================

const LEVEL = { MR: 1, ABM: 2, RBM: 3, ZSM: 4 };
const DIRECT_REPORT = { ZSM: 'RBM', RBM: 'ABM', ABM: 'MR' };
const REQUIRED_MANAGER = { MR: 'ABM', ABM: 'RBM', RBM: 'ZSM', ZSM: null };
const GEOFENCE_METERS = Number(process.env.MR_GEOFENCE_METERS || 250);

// What a field user may set on each record. Everything else (owners,
// approvals, timestamps) is the server's to decide.
const TERRITORY_FIELDS = ['code', 'name', 'headquarters', 'city', 'state', 'pincodes', 'isActive'];
const ACCOUNT_FIELDS = [
  'type', 'name', 'specialty', 'registrationNumber', 'phone', 'email', 'organizationName',
  'address', 'location', 'territoryId', 'classification', 'visitFrequencyPerMonth',
  'potentialValue', 'isActive',
];
const EXPENSE_FIELDS = ['expenseDate', 'category', 'amount', 'description'];
const DETAILING_FIELDS = ['title', 'productName', 'contentType', 'url', 'description', 'tags', 'isActive'];
// A DCR may be logged up to this many days after the call.
const DCR_BACKDATE_DAYS = Number(process.env.MR_DCR_BACKDATE_DAYS || 3);

function pick(body = {}, fields) {
  const out = {};
  for (const key of fields) {
    if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  return out;
}

// ============================================
// Helper Functions
// ============================================

const asyncHandler = (fn) => (req, res, next) => {
  return Promise.resolve(fn(req, res, next)).catch(next);
};

const id = (value) => (value ? String(value._id || value) : null);

function monthKey(value) {
  const raw = String(value || '').trim();

  if (/^\d{4}-\d{2}$/.test(raw)) {
    return raw;
  }

  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthRange(month) {
  const [year, m] = monthKey(month).split('-').map(Number);

  return {
    start: new Date(Date.UTC(year, m - 1, 1, 0, 0, 0)),
    end: new Date(Date.UTC(year, m, 1, 0, 0, 0))
  };
}

function dateKeyInAppTimezone(date = new Date()) {
  const timezone = process.env.APP_TIMEZONE || 'Asia/Kolkata';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
    .formatToParts(date)
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function geoFromBody(body = {}) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const accuracy = Number(body.accuracy || 0);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }

  return {
    lat,
    lng,
    accuracy: Number.isFinite(accuracy) ? accuracy : 0,
    capturedAt: new Date()
  };
}

function haversineMeters(a, b) {
  if (![a?.lat, a?.lng, b?.lat, b?.lng].every(Number.isFinite)) {
    return null;
  }

  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function ledgerDelta(row) {
  const quantity = Number(row.quantity || 0);

  if (row.transactionType === 'issue') return quantity;
  if (row.transactionType === 'consume' || row.transactionType === 'return') return -quantity;
  if (row.transactionType === 'adjustment') {
    return row.adjustmentDirection === 'out' ? -quantity : quantity;
  }

  return 0;
}

async function itemBalance(profileId, itemType, productName, batchNumber) {
  const filter = { profileId, itemType, productName };

  if (batchNumber) {
    filter.batchNumber = batchNumber;
  }

  const rows = await MRSampleLedger
    .find(filter)
    .select('transactionType adjustmentDirection quantity')
    .lean();

  return rows.reduce((sum, row) => sum + ledgerDelta(row), 0);
}

function inventoryItemsFromVisit(visit) {
  const items = [];

  (visit.samples || []).forEach((sample, index) => {
    if (sample?.productName && Number(sample.quantity) > 0) {
      items.push({
        itemType: 'sample',
        productName: sample.productName,
        batchNumber: sample.batchNumber || undefined,
        quantity: Number(sample.quantity),
        sourceKey: `visit:${visit._id}:sample:${index}`
      });
    }
  });

  (visit.gifts || []).forEach((gift, index) => {
    if (gift?.itemName && Number(gift.quantity) > 0) {
      items.push({
        itemType: 'gift',
        productName: gift.itemName,
        quantity: Number(gift.quantity),
        sourceKey: `visit:${visit._id}:gift:${index}`
      });
    }
  });

  return items;
}

async function postVisitInventory(visit, actorProfileId) {
  if (visit.inventoryPostedAt) {
    return;
  }

  const items = inventoryItemsFromVisit(visit);
  const pending = [];

  for (const item of items) {
    const existing = await MRSampleLedger.exists({ sourceKey: item.sourceKey });

    if (!existing) {
      pending.push(item);
    }
  }

  const requiredByKey = new Map();

  for (const item of pending) {
    const key = `${item.itemType}:${item.productName}:${item.batchNumber || ''}`;
    const current = requiredByKey.get(key) || { ...item, quantity: 0 };
    current.quantity += item.quantity;
    requiredByKey.set(key, current);
  }

  for (const required of requiredByKey.values()) {
    const balance = await itemBalance(
      visit.profileId,
      required.itemType,
      required.productName,
      required.batchNumber
    );

    if (balance < required.quantity) {
      const error = new Error(
        `Insufficient ${required.itemType} balance for ${required.productName}. ` +
        `Available ${balance}, required ${required.quantity}`
      );
      error.statusCode = 409;
      throw error;
    }
  }

  for (const item of pending) {
    await MRSampleLedger.findOneAndUpdate(
      { sourceKey: item.sourceKey },
      {
        $setOnInsert: {
          profileId: visit.profileId,
          transactionDate: visit.visitDate,
          itemType: item.itemType,
          productName: item.productName,
          batchNumber: item.batchNumber,
          transactionType: 'consume',
          quantity: item.quantity,
          visitId: visit._id,
          accountId: visit.accountId,
          createdBy: actorProfileId || visit.profileId,
          notes: 'Auto-posted from approved DCR',
          sourceKey: item.sourceKey
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  visit.inventoryPostedAt = new Date();
}

async function actorProfile(req) {
  if (req.user.role === 'admin') {
    return null;
  }

  const profile = await MRProfile.findOne({ userId: req.user._id, isActive: true });

  if (!profile) {
    const error = new Error('MR profile is not provisioned for this account');
    error.statusCode = 403;
    throw error;
  }

  return profile;
}

async function allProfilesWithUsers() {
  return MRProfile
    .find({ isActive: true })
    .populate('userId', 'name email phone isActive')
    .populate('territoryIds', 'code name city state')
    .lean();
}

function descendantIdsFromProfiles(rootId, profiles) {
  const root = String(rootId);
  const childrenByManager = new Map();

  profiles.forEach((profile) => {
    const manager = id(profile.managerId);

    if (!manager) return;

    if (!childrenByManager.has(manager)) {
      childrenByManager.set(manager, []);
    }

    childrenByManager.get(manager).push(String(profile._id));
  });

  const seen = new Set();
  const queue = [...(childrenByManager.get(root) || [])];

  while (queue.length) {
    const current = queue.shift();

    if (seen.has(current)) continue;

    seen.add(current);
    queue.push(...(childrenByManager.get(current) || []));
  }

  return [...seen];
}

async function accessibleProfileIds(req, { includeSelf = true, includeInactive = false } = {}) {
  if (req.user.role === 'admin') {
    return (await MRProfile.find({ isActive: true }).select('_id').lean())
      .map((profile) => String(profile._id));
  }

  const actor = await actorProfile(req);
  // Walk the whole tree — a deactivated manager must not hide the active
  // team below them — then keep the people who are active, unless the
  // caller is managing the team (and may need to reactivate someone).
  const profiles = await MRProfile.find({}).select('_id managerId isActive').lean();
  const active = new Set(profiles.filter((p) => p.isActive).map((p) => String(p._id)));
  const descendants = descendantIdsFromProfiles(actor._id, profiles)
    .filter((profileId) => includeInactive || active.has(profileId));

  return includeSelf ? [String(actor._id), ...descendants] : descendants;
}

async function ensureCanManage(req, targetProfileId, { allowSelf = false } = {}) {
  if (req.user.role === 'admin') {
    return null;
  }

  const actor = await actorProfile(req);

  if (allowSelf && String(actor._id) === String(targetProfileId)) {
    return actor;
  }

  const allowed = await accessibleProfileIds(req, { includeSelf: false, includeInactive: true });

  if (!allowed.includes(String(targetProfileId))) {
    const error = new Error('This field user is outside your reporting hierarchy');
    error.statusCode = 403;
    throw error;
  }

  return actor;
}

// Territories a manager may hand out: their own, plus (for RBM/ZSM) every
// territory already held by someone in their team.
async function assignableTerritoryIds(req) {
  if (req.user.role === 'admin') return null;
  const actor = await actorProfile(req);
  if (LEVEL[actor.designation] >= LEVEL.RBM) {
    const team = await MRProfile.find({ _id: { $in: await accessibleProfileIds(req) } }).select('territoryIds').lean();
    return new Set(team.flatMap((p) => (p.territoryIds || []).map(String)));
  }
  return new Set((actor.territoryIds || []).map(String));
}

async function filterTerritories(req, ids) {
  if (!Array.isArray(ids)) return [];
  const allowed = await assignableTerritoryIds(req);
  const wanted = ids.map(String).filter((tid) => mongoose.isValidObjectId(tid));
  return allowed ? wanted.filter((tid) => allowed.has(tid)) : wanted;
}

// Who a field user may take on a joint call: their own team and the
// managers above them.
async function jointPartnerIds(actor, req) {
  const ids = new Set(await accessibleProfileIds(req, { includeSelf: false }));
  let cursor = actor.managerId;
  for (let hops = 0; cursor && hops < 4; hops += 1) {
    const manager = await MRProfile.findById(cursor).select('_id managerId isActive').lean();
    if (!manager) break;
    if (manager.isActive) ids.add(String(manager._id));
    cursor = manager.managerId;
  }
  return ids;
}

function profileSummary(profile) {
  if (!profile) return null;

  const user = profile.userId || {};

  return {
    id: String(profile._id),
    employeeCode: profile.employeeCode,
    designation: profile.designation,
    managerId: id(profile.managerId),
    headquarters: profile.headquarters,
    division: profile.division,
    state: profile.state,
    zone: profile.zone,
    territories: profile.territoryIds || [],
    name: user.name,
    email: user.email,
    phone: user.phone,
    productLine: profile.productLine,
    isActive: profile.isActive !== false
  };
}

function buildHierarchy(profiles) {
  const byId = new Map(
    profiles.map((profile) => [
      String(profile._id),
      { ...profileSummary(profile), children: [] }
    ])
  );

  const roots = [];

  profiles.forEach((profile) => {
    const node = byId.get(String(profile._id));
    const manager = id(profile.managerId);

    if (manager && byId.has(manager)) {
      byId.get(manager).children.push(node);
    } else {
      roots.push(node);
    }
  });

  return roots;
}

function publicAccount(account) {
  return account;
}

// ============================================
// Controllers
// ============================================

exports.getMe = asyncHandler(async (req, res) => {
  if (req.user.role === 'admin') {
    return res.json({
      success: true,
      profile: null,
      isAdmin: true
    });
  }

  const profile = await MRProfile
    .findOne({ userId: req.user._id })
    .populate('userId', 'name email phone isActive')
    .populate({ path: 'managerId', select: 'employeeCode designation headquarters userId', populate: { path: 'userId', select: 'name phone email' } })
    .populate('territoryIds', 'code name headquarters city state pincodes');

  res.json({ success: true, profile });
});

// A field user fixes the spelling of their own name; everything else on the
// profile (designation, HQ, territories, manager) is set by their manager.
exports.updateMe = asyncHandler(async (req, res) => {
  if (req.user.role === 'admin') {
    return res.status(403).json({ success: false, error: 'Admin has no field profile' });
  }

  await actorProfile(req);
  const name = typeof req.body.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 80) {
    return res.status(400).json({ success: false, error: 'Name must be 2 to 80 characters' });
  }

  await User.updateOne({ _id: req.user._id }, { $set: { name } });
  res.json({ success: true, name });
});

exports.getHierarchy = asyncHandler(async (req, res) => {
  const profiles = await allProfilesWithUsers();
  let visible = profiles;

  if (req.user.role !== 'admin') {
    const actor = await actorProfile(req);
    const allowed = new Set(await accessibleProfileIds(req));
    visible = profiles.filter((profile) => allowed.has(String(profile._id)));

    res.json({
      success: true,
      hierarchy: buildHierarchy(visible),
      profiles: visible.map(profileSummary)
    });
    return;
  }

  res.json({
    success: true,
    hierarchy: buildHierarchy(visible),
    profiles: visible.map(profileSummary)
  });
});

exports.getTeam = asyncHandler(async (req, res) => {
  // A manager also sees people they deactivated, so they can bring them back.
  const includeInactive = req.query.includeInactive === 'true';
  const allowed = new Set(await accessibleProfileIds(req, { includeInactive }));
  const profiles = (await MRProfile
    .find(includeInactive ? {} : { isActive: true })
    .populate('userId', 'name email phone isActive')
    .populate('territoryIds', 'code name city state')
    .lean())
    .filter((profile) => allowed.has(String(profile._id)));

  res.json({
    success: true,
    profiles: profiles.map(profileSummary)
  });
});

// ============================================
// Field User Provisioning
// ============================================

async function provisionFieldUser(req, res, managerMode = false) {
  const {
    email,
    password,
    name,
    phone,
    employeeCode,
    designation,
    managerId,
    headquarters,
    division,
    state,
    zone,
    territoryIds = [],
    productLine,
    dateOfJoining
  } = req.body;

  if (!email || !password || !name || !phone || !employeeCode || !designation) {
    return res.status(400).json({
      success: false,
      error: 'email, password, name, phone, employeeCode and designation are required'
    });
  }

  if (!LEVEL[designation]) {
    return res.status(400).json({
      success: false,
      error: 'Invalid MR designation'
    });
  }

  if (!/^[0-9]{10}$/.test(String(phone))) {
    return res.status(400).json({
      success: false,
      error: 'Phone must be a 10-digit number'
    });
  }

  if (String(password).length < 6) {
    return res.status(400).json({
      success: false,
      error: 'Password must be at least 6 characters'
    });
  }

  let effectiveManagerId = managerId || null;

  if (managerMode) {
    const manager = await actorProfile(req);
    const requiredDesignation = DIRECT_REPORT[manager.designation];

    if (!requiredDesignation || designation !== requiredDesignation) {
      return res.status(403).json({
        success: false,
        error: `${manager.designation} can directly create only ${requiredDesignation || 'no'} users`
      });
    }

    effectiveManagerId = manager._id;
  } else {
    const requiredManager = REQUIRED_MANAGER[designation];

    if (requiredManager && !effectiveManagerId) {
      return res.status(400).json({
        success: false,
        error: `${designation} must report to a ${requiredManager}`
      });
    }

    if (!requiredManager && effectiveManagerId) {
      return res.status(400).json({
        success: false,
        error: 'ZSM is the top field-force level and should not have an MR-platform manager'
      });
    }

    if (effectiveManagerId) {
      const manager = await MRProfile.findById(effectiveManagerId);

      if (!manager || manager.designation !== requiredManager || !manager.isActive) {
        return res.status(400).json({
          success: false,
          error: `${designation} must report directly to an active ${requiredManager}`
        });
      }
    }
  }

  if (await User.exists({ email: String(email).toLowerCase() })) {
    return res.status(409).json({
      success: false,
      error: 'Email is already in use'
    });
  }

  // OTP sign-in finds the account by phone, so a phone must be unique.
  if (await User.exists({ phone: String(phone) })) {
    return res.status(409).json({
      success: false,
      error: 'This phone number already has an account'
    });
  }

  if (await MRProfile.exists({ employeeCode: String(employeeCode).toUpperCase() })) {
    return res.status(409).json({
      success: false,
      error: 'Employee code is already in use'
    });
  }

  let user;
  let createdProfile;

  try {
    user = await User.create({
      email: String(email).toLowerCase(),
      password,
      name: String(name).trim(),
      phone: String(phone),
      role: 'mr',
      isVerified: true,
      profileCompleted: false,
      registrationSource: 'admin'
    });

    const profile = await MRProfile.create({
      userId: user._id,
      employeeCode,
      designation,
      managerId: effectiveManagerId,
      headquarters,
      division,
      state,
      zone,
      territoryIds: managerMode ? await filterTerritories(req, territoryIds) : territoryIds,
      productLine,
      dateOfJoining: dateOfJoining || undefined
    });

    createdProfile = profile;

    user.profileCompleted = true;
    user.profileId = profile._id;
    user.profileModel = 'MRProfile';
    await user.save();

    const populated = await MRProfile
      .findById(profile._id)
      .populate('userId', 'name email phone');

    res.status(201).json({
      success: true,
      profile: populated
    });
  } catch (error) {
    if (createdProfile?._id) {
      await MRProfile.deleteOne({ _id: createdProfile._id }).catch(() => {});
    }

    if (user?._id) {
      await User.deleteOne({ _id: user._id }).catch(() => {});
    }

    throw error;
  }
}

exports.adminCreateUser = asyncHandler((req, res) => provisionFieldUser(req, res, false));
exports.managerCreateUser = asyncHandler((req, res) => provisionFieldUser(req, res, true));

exports.updateTeamMember = asyncHandler(async (req, res) => {
  await ensureCanManage(req, req.params.id);

  const allowed = [
    'headquarters',
    'division',
    'state',
    'zone',
    'territoryIds',
    'productLine',
    'isActive',
    'notes'
  ];

  const updates = {};

  allowed.forEach((key) => {
    if (req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  });

  if (updates.territoryIds !== undefined) {
    updates.territoryIds = await filterTerritories(req, updates.territoryIds);
  }

  const profile = await MRProfile
    .findByIdAndUpdate(req.params.id, { $set: updates }, {
      new: true,
      runValidators: true
    })
    .populate('userId', 'name email phone');

  if (!profile) {
    return res.status(404).json({
      success: false,
      error: 'Field user not found'
    });
  }

  if (req.body.isActive !== undefined) {
    await User.updateOne(
      { _id: profile.userId._id },
      { $set: { isActive: Boolean(req.body.isActive) } }
    );
  }

  res.json({
    success: true,
    profile
  });
});

// ============================================
// Territory Management
// ============================================

exports.listTerritories = asyncHandler(async (req, res) => {
  const base = req.query.includeInactive === 'true' ? {} : { isActive: true };

  if (req.user.role === 'admin') {
    const territories = await MRTerritory.find(base).sort({ state: 1, city: 1, name: 1 });
    return res.json({ success: true, territories });
  }

  const actor = await actorProfile(req);

  if (LEVEL[actor.designation] >= LEVEL.RBM) {
    const allowedProfiles = await MRProfile
      .find({ _id: { $in: await accessibleProfileIds(req) } })
      .select('territoryIds')
      .lean();

    const ids = [
      ...new Set(
        allowedProfiles.flatMap((profile) =>
          (profile.territoryIds || []).map(String)
        )
      )
    ];

    const filter = { ...base, _id: { $in: ids } };
    const territories = await MRTerritory.find(filter).sort({ state: 1, city: 1, name: 1 });
    return res.json({ success: true, territories });
  }

  const filter = { ...base, _id: { $in: actor.territoryIds || [] } };
  const territories = await MRTerritory.find(filter).sort({ state: 1, city: 1, name: 1 });

  res.json({ success: true, territories });
});

exports.createTerritory = asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') {
    const actor = await actorProfile(req);

    if (LEVEL[actor.designation] < LEVEL.RBM) {
      return res.status(403).json({
        success: false,
        error: 'Only RBM/ZSM or admin can create territories'
      });
    }
  }

  const { code, name } = req.body;

  if (!code || !name) {
    return res.status(400).json({
      success: false,
      error: 'Territory code and name are required'
    });
  }

  const actor = req.user.role === 'admin' ? null : await actorProfile(req);

  const territory = await MRTerritory.create({
    ...pick(req.body, TERRITORY_FIELDS),
    managerProfileId: req.user.role === 'admin'
      ? (req.body.managerProfileId || null)
      : actor._id
  });

  if (actor && !actor.territoryIds.some((territoryId) =>
    String(territoryId) === String(territory._id))) {
    actor.territoryIds.push(territory._id);
    await actor.save();
  }

  res.status(201).json({
    success: true,
    territory
  });
});

exports.updateTerritory = asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') {
    const actor = await actorProfile(req);

    if (LEVEL[actor.designation] < LEVEL.RBM) {
      return res.status(403).json({
        success: false,
        error: 'Only RBM/ZSM or admin can update territories'
      });
    }
  }

  const territoryUpdates = pick(req.body, TERRITORY_FIELDS);
  if (req.user.role === 'admin' && req.body.managerProfileId !== undefined) {
    territoryUpdates.managerProfileId = req.body.managerProfileId || null;
  }

  if (req.user.role !== 'admin') {
    const actor = await actorProfile(req);
    const existing = await MRTerritory.findById(req.params.id).select('managerProfileId');
    const owns = existing && (
      String(existing.managerProfileId) === String(actor._id) ||
      actor.territoryIds.some((id) => String(id) === String(existing._id))
    );
    if (existing && !owns) {
      return res.status(403).json({
        success: false,
        error: 'You can only edit territories you manage'
      });
    }
  }

  const territory = await MRTerritory.findByIdAndUpdate(
    req.params.id,
    { $set: territoryUpdates },
    { new: true, runValidators: true }
  );

  if (!territory) {
    return res.status(404).json({
      success: false,
      error: 'Territory not found'
    });
  }

  res.json({
    success: true,
    territory
  });
});

// ============================================
// Account Management
// ============================================

exports.listAccounts = asyncHandler(async (req, res) => {
  const allowedIds = await accessibleProfileIds(req);
  const filter = {};

  if (req.user.role !== 'admin') {
    filter.assignedProfileIds = { $in: allowedIds };
  }

  if (req.query.type) {
    filter.type = req.query.type;
  }

  if (req.query.territoryId) {
    filter.territoryId = req.query.territoryId;
  }

  if (req.query.q) {
    const rx = new RegExp(
      String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'i'
    );

    filter.$or = [
      { name: rx },
      { organizationName: rx },
      { specialty: rx },
      { 'address.city': rx }
    ];
  }

  const accounts = await MRAccount
    .find(filter)
    .populate('territoryId', 'code name city state')
    .sort({ name: 1 })
    .limit(500);

  res.json({
    success: true,
    accounts: accounts.map(publicAccount)
  });
});

exports.createAccount = asyncHandler(async (req, res) => {
  const actor = req.user.role === 'admin' ? null : await actorProfile(req);
  let assignedProfileIds = Array.isArray(req.body.assignedProfileIds)
    ? req.body.assignedProfileIds
    : [];

  if (req.user.role !== 'admin') {
    const allowed = new Set(await accessibleProfileIds(req));
    assignedProfileIds = assignedProfileIds.filter((profileId) =>
      allowed.has(String(profileId))
    );

    if (!assignedProfileIds.length) {
      assignedProfileIds = [actor._id];
    }
  }

  const linkedEntity = await resolveLinkedEntity(req.body.linkedEntity);
  const account = await MRAccount.create({
    ...pick(req.body, ACCOUNT_FIELDS),
    ...(linkedEntity ? { linkedEntity } : {}),
    assignedProfileIds,
    createdBy: actor?._id || null
  });

  res.status(201).json({
    success: true,
    account
  });
});

exports.updateAccount = asyncHandler(async (req, res) => {
  const account = await MRAccount.findById(req.params.id);

  if (!account) {
    return res.status(404).json({
      success: false,
      error: 'Account not found'
    });
  }

  if (req.user.role !== 'admin') {
    const allowed = new Set(await accessibleProfileIds(req));

    if (!account.assignedProfileIds.some((profileId) =>
      allowed.has(String(profileId)))) {
      return res.status(403).json({
        success: false,
        error: 'Account is outside your reporting hierarchy'
      });
    }

    if (Array.isArray(req.body.assignedProfileIds)) {
      // The editor decides assignments within their own team only; reps
      // from other teams on a shared account stay assigned.
      const mine = req.body.assignedProfileIds.filter((profileId) => allowed.has(String(profileId)));
      const others = account.assignedProfileIds.filter((profileId) => !allowed.has(String(profileId)));
      account.assignedProfileIds = [...others, ...mine];
    }
  } else if (Array.isArray(req.body.assignedProfileIds)) {
    account.assignedProfileIds = req.body.assignedProfileIds;
  }

  Object.assign(account, pick(req.body, ACCOUNT_FIELDS));
  if (req.body.linkedEntity === null) {
    account.linkedEntity = undefined;
  } else if (req.body.linkedEntity) {
    account.linkedEntity = await resolveLinkedEntity(req.body.linkedEntity);
  }
  await account.save();

  res.json({
    success: true,
    account
  });
});

// ============================================
// Visit Management
// ============================================

exports.listVisits = asyncHandler(async (req, res) => {
  const allowed = await accessibleProfileIds(req);
  const filter = { profileId: { $in: allowed } };

  if (req.query.profileId) {
    if (!allowed.includes(String(req.query.profileId))) {
      return res.status(403).json({
        success: false,
        error: 'Field user is outside your hierarchy'
      });
    }

    filter.profileId = req.query.profileId;
  }

  if (req.query.status) {
    filter.status = { $in: String(req.query.status).split(',') };
  }

  if (req.query.date) {
    const start = new Date(`${req.query.date}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    filter.visitDate = { $gte: start, $lt: end };
  } else if (req.query.month) {
    const range = monthRange(req.query.month);
    filter.visitDate = { $gte: range.start, $lt: range.end };
  }

  const visits = await MRVisit
    .find(filter)
    .populate({ path: 'profileId', select: 'employeeCode designation headquarters userId', populate: { path: 'userId', select: 'name' } })
    .populate('accountId', 'name type specialty organizationName address location classification')
    .populate('approvedBy', 'employeeCode designation')
    .sort({ visitDate: -1, createdAt: -1 })
    .limit(1000);

  res.json({
    success: true,
    visits
  });
});

exports.createVisit = asyncHandler(async (req, res) => {
  if (req.user.role === 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Admin cannot create field calls'
    });
  }

  const actor = await actorProfile(req);
  const account = await MRAccount.findById(req.body.accountId);

  if (!account || !account.isActive) {
    return res.status(404).json({
      success: false,
      error: 'Doctor/chemist account not found'
    });
  }

  const allowed = new Set(await accessibleProfileIds(req));

  if (account.assignedProfileIds.length &&
      !account.assignedProfileIds.some((profileId) =>
        allowed.has(String(profileId)))) {
    return res.status(403).json({
      success: false,
      error: 'Account is outside your territory/hierarchy'
    });
  }

  const visitDate = req.body.visitDate ? new Date(req.body.visitDate) : new Date();
  if (Number.isNaN(visitDate.getTime())) {
    return res.status(400).json({ success: false, error: 'Invalid visit date' });
  }
  const earliest = new Date(Date.now() - DCR_BACKDATE_DAYS * 24 * 60 * 60 * 1000);
  earliest.setHours(0, 0, 0, 0);
  if (visitDate < earliest) {
    return res.status(400).json({
      success: false,
      error: `Calls can be logged up to ${DCR_BACKDATE_DAYS} days back`
    });
  }

  let jointWithProfileIds = [];
  if (Array.isArray(req.body.jointWithProfileIds) && req.body.jointWithProfileIds.length) {
    const allowedPartners = await jointPartnerIds(actor, req);
    const partners = await MRProfile.find({
      _id: { $in: req.body.jointWithProfileIds.filter((pid) => allowedPartners.has(String(pid))) },
      isActive: true
    }).select('_id');
    jointWithProfileIds = partners.map((p) => p._id);
  }

  const visit = await MRVisit.create({
    profileId: actor._id,
    accountId: account._id,
    visitDate,
    callType: jointWithProfileIds.length ? 'joint' : (req.body.callType === 'joint' ? 'joint' : 'solo'),
    jointWithProfileIds,
    productsDiscussed: req.body.productsDiscussed || [],
    samples: req.body.samples || [],
    gifts: req.body.gifts || [],
    discussionNotes: req.body.discussionNotes,
    doctorFeedback: req.body.doctorFeedback,
    nextVisitDate: req.body.nextVisitDate,
    pobAmount: Number(req.body.pobAmount || 0)
  });

  res.status(201).json({
    success: true,
    visit
  });
});

async function ownedVisit(req, visitId) {
  if (req.user.role === 'admin') {
    return MRVisit.findById(visitId);
  }

  const actor = await actorProfile(req);
  return MRVisit.findOne({ _id: visitId, profileId: actor._id });
}

exports.checkInVisit = asyncHandler(async (req, res) => {
  const visit = await ownedVisit(req, req.params.id);

  if (!visit) {
    return res.status(404).json({
      success: false,
      error: 'Call not found or not owned by you'
    });
  }

  if (!['planned', 'checked_in'].includes(visit.status)) {
    return res.status(409).json({
      success: false,
      error: 'Call cannot be checked in at its current status'
    });
  }

  const geo = geoFromBody(req.body);

  if (!geo) {
    return res.status(400).json({
      success: false,
      error: 'Valid GPS latitude/longitude are required for check-in'
    });
  }

  const account = await MRAccount.findById(visit.accountId);
  const distance = haversineMeters(geo, account?.location);

  visit.checkIn = geo;
  visit.checkInDistanceMeters = distance;
  visit.geofenceStatus = distance === null
    ? 'unknown'
    : distance <= GEOFENCE_METERS
      ? 'inside'
      : 'outside';
  visit.status = 'checked_in';

  await visit.save();

  res.json({
    success: true,
    visit,
    geofenceMeters: GEOFENCE_METERS
  });
});

exports.checkOutVisit = asyncHandler(async (req, res) => {
  const visit = await ownedVisit(req, req.params.id);

  if (!visit) {
    return res.status(404).json({
      success: false,
      error: 'Call not found or not owned by you'
    });
  }

  if (visit.status !== 'checked_in') {
    return res.status(409).json({
      success: false,
      error: 'Check in before checking out'
    });
  }

  const geo = geoFromBody(req.body);

  if (!geo) {
    return res.status(400).json({
      success: false,
      error: 'Valid GPS latitude/longitude are required for check-out'
    });
  }

  visit.checkOut = geo;
  visit.status = 'completed';

  if (req.body.discussionNotes !== undefined) {
    visit.discussionNotes = req.body.discussionNotes;
  }

  if (req.body.doctorFeedback !== undefined) {
    visit.doctorFeedback = req.body.doctorFeedback;
  }

  if (req.body.nextVisitDate !== undefined) {
    visit.nextVisitDate = req.body.nextVisitDate || undefined;
  }

  if (req.body.productsDiscussed !== undefined) {
    visit.productsDiscussed = req.body.productsDiscussed;
  }

  if (req.body.samples !== undefined) {
    visit.samples = req.body.samples;
  }

  if (req.body.gifts !== undefined) {
    visit.gifts = req.body.gifts;
  }

  if (req.body.pobAmount !== undefined) {
    visit.pobAmount = Number(req.body.pobAmount || 0);
  }

  await visit.save();

  res.json({
    success: true,
    visit
  });
});

exports.submitVisit = asyncHandler(async (req, res) => {
  const visit = await ownedVisit(req, req.params.id);

  if (!visit) {
    return res.status(404).json({
      success: false,
      error: 'Call not found or not owned by you'
    });
  }

  if (['submitted', 'approved'].includes(visit.status)) {
    return res.json({
      success: true,
      visit,
      idempotent: true
    });
  }

  if (!['completed', 'rejected'].includes(visit.status)) {
    return res.status(409).json({
      success: false,
      error: 'Complete the call before submitting the DCR'
    });
  }

  if (req.body.discussionNotes !== undefined) {
    visit.discussionNotes = req.body.discussionNotes;
  }

  if (req.body.doctorFeedback !== undefined) {
    visit.doctorFeedback = req.body.doctorFeedback;
  }

  if (req.body.nextVisitDate !== undefined) {
    visit.nextVisitDate = req.body.nextVisitDate || undefined;
  }

  if (req.body.productsDiscussed !== undefined) {
    visit.productsDiscussed = req.body.productsDiscussed;
  }

  if (req.body.samples !== undefined) {
    visit.samples = req.body.samples;
  }

  if (req.body.gifts !== undefined) {
    visit.gifts = req.body.gifts;
  }

  visit.status = 'submitted';
  visit.submittedAt = new Date();
  visit.managerComment = undefined;

  await visit.save();

  res.json({
    success: true,
    visit
  });
});

exports.approveVisit = asyncHandler(async (req, res) => {
  const visit = await MRVisit.findById(req.params.id);

  if (!visit) {
    return res.status(404).json({
      success: false,
      error: 'DCR not found'
    });
  }

  await ensureCanManage(req, visit.profileId);

  if (visit.status !== 'submitted') {
    return res.status(409).json({
      success: false,
      error: 'Only submitted DCRs can be reviewed'
    });
  }

  const decision = req.body.decision;

  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({
      success: false,
      error: 'decision must be approve or reject'
    });
  }

  const actor = req.user.role === 'admin' ? null : await actorProfile(req);

  if (decision === 'approve') {
    await postVisitInventory(visit, actor?._id || null);
  }

  visit.status = decision === 'approve' ? 'approved' : 'rejected';
  visit.managerComment = req.body.comment || '';
  visit.approvedBy = actor?._id || null;
  visit.approvedAt = new Date();

  await visit.save();

  res.json({
    success: true,
    visit
  });
});

// ============================================
// Attendance Management
// ============================================

exports.getAttendance = asyncHandler(async (req, res) => {
  const allowed = await accessibleProfileIds(req);
  const filter = { profileId: { $in: allowed } };

  if (req.query.profileId) {
    if (!allowed.includes(String(req.query.profileId))) {
      return res.status(403).json({
        success: false,
        error: 'Field user is outside your hierarchy'
      });
    }

    filter.profileId = req.query.profileId;
  }

  if (req.query.month) {
    filter.dateKey = new RegExp(`^${monthKey(req.query.month)}`);
  }

  const rows = await MRAttendance
    .find(filter)
    .populate({ path: 'profileId', select: 'employeeCode designation headquarters userId', populate: { path: 'userId', select: 'name' } })
    .sort({ dateKey: -1 })
    .limit(1000);

  res.json({
    success: true,
    attendance: rows
  });
});

exports.punchIn = asyncHandler(async (req, res) => {
  if (req.user.role === 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Admin does not use field attendance'
    });
  }

  const actor = await actorProfile(req);
  const geo = geoFromBody(req.body);

  if (!geo) {
    return res.status(400).json({
      success: false,
      error: 'Valid GPS location is required'
    });
  }

  // Always today on the server's clock — a client-chosen day would let
  // attendance be backdated.
  const dateKey = dateKeyInAppTimezone();

  let row = await MRAttendance.findOne({ profileId: actor._id, dateKey });

  if (row?.punchIn?.at) {
    return res.json({
      success: true,
      attendance: row,
      idempotent: true
    });
  }

  if (!row) {
    row = new MRAttendance({ profileId: actor._id, dateKey });
  }

  if (req.body.workType === 'leave') {
    return res.status(400).json({
      success: false,
      error: 'Apply for leave instead of starting the day'
    });
  }

  // An approved half-day leave keeps the day at half.
  const halfDay = row.status === 'half_day' && row.workType === 'leave';
  row.punchIn = { ...geo, at: new Date() };
  row.workType = ['field', 'office', 'meeting', 'training'].includes(req.body.workType) ? req.body.workType : 'field';
  row.status = halfDay ? 'half_day' : 'present';
  row.notes = req.body.notes || row.notes;

  await row.save();

  res.json({
    success: true,
    attendance: row
  });
});

exports.punchOut = asyncHandler(async (req, res) => {
  if (req.user.role === 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Admin does not use field attendance'
    });
  }

  const actor = await actorProfile(req);
  const geo = geoFromBody(req.body);

  if (!geo) {
    return res.status(400).json({
      success: false,
      error: 'Valid GPS location is required'
    });
  }

  const today = dateKeyInAppTimezone();
  const yesterday = dateKeyInAppTimezone(new Date(Date.now() - 24 * 60 * 60 * 1000));
  let row = await MRAttendance.findOne({ profileId: actor._id, dateKey: today });
  if (!row?.punchIn?.at) {
    const open = await MRAttendance.findOne({ profileId: actor._id, dateKey: yesterday });
    if (open?.punchIn?.at && !open.punchOut?.at) row = open;
  }

  if (!row?.punchIn?.at) {
    return res.status(409).json({
      success: false,
      error: 'Punch in first'
    });
  }

  if (row.punchOut?.at) {
    return res.json({
      success: true,
      attendance: row,
      idempotent: true
    });
  }

  row.punchOut = { ...geo, at: new Date() };

  await row.save();

  res.json({
    success: true,
    attendance: row
  });
});

// ============================================
// Tour Plan Management
// ============================================

exports.listTourPlans = asyncHandler(async (req, res) => {
  const allowed = await accessibleProfileIds(req);
  const filter = { profileId: { $in: allowed } };

  if (req.query.month) {
    filter.month = monthKey(req.query.month);
  }

  if (req.query.profileId) {
    if (!allowed.includes(String(req.query.profileId))) {
      return res.status(403).json({
        success: false,
        error: 'Field user is outside your hierarchy'
      });
    }

    filter.profileId = req.query.profileId;
  }

  const plans = await MRTourPlan
    .find(filter)
    .populate({ path: 'profileId', select: 'employeeCode designation headquarters userId', populate: { path: 'userId', select: 'name' } })
    .populate('days.accountIds', 'name type address')
    .sort({ month: -1 });

  res.json({
    success: true,
    plans
  });
});

exports.saveTourPlan = asyncHandler(async (req, res) => {
  if (req.user.role === 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Admin cannot create tour plans'
    });
  }

  const actor = await actorProfile(req);
  const month = monthKey(req.body.month);

  let plan = await MRTourPlan.findOne({ profileId: actor._id, month });

  if (plan && !['draft', 'rejected'].includes(plan.status)) {
    return res.status(409).json({
      success: false,
      error: 'Submitted/approved tour plan cannot be edited'
    });
  }

  if (!plan) {
    plan = new MRTourPlan({ profileId: actor._id, month });
  }

  plan.days = Array.isArray(req.body.days) ? req.body.days : plan.days;
  plan.status = 'draft';
  plan.managerComment = undefined;

  await plan.save();

  res.json({
    success: true,
    plan
  });
});

exports.submitTourPlan = asyncHandler(async (req, res) => {
  if (req.user.role === 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Admin cannot submit tour plans'
    });
  }

  const actor = await actorProfile(req);

  const plan = await MRTourPlan.findOne({
    _id: req.params.id,
    profileId: actor._id
  });

  if (!plan) {
    return res.status(404).json({
      success: false,
      error: 'Tour plan not found'
    });
  }

  if (plan.status === 'approved') {
    return res.status(409).json({
      success: false,
      error: 'Approved tour plan cannot be resubmitted'
    });
  }

  plan.status = 'submitted';
  plan.submittedAt = new Date();
  plan.managerComment = undefined;

  await plan.save();

  res.json({
    success: true,
    plan
  });
});

exports.approveTourPlan = asyncHandler(async (req, res) => {
  const plan = await MRTourPlan.findById(req.params.id);

  if (!plan) {
    return res.status(404).json({
      success: false,
      error: 'Tour plan not found'
    });
  }

  await ensureCanManage(req, plan.profileId);

  if (plan.status !== 'submitted') {
    return res.status(409).json({
      success: false,
      error: `This plan is ${plan.status}, not waiting for review`
    });
  }

  const decision = req.body.decision;

  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({
      success: false,
      error: 'decision must be approve or reject'
    });
  }

  const actor = req.user.role === 'admin' ? null : await actorProfile(req);

  plan.status = decision === 'approve' ? 'approved' : 'rejected';
  plan.managerComment = req.body.comment || '';
  plan.approvedBy = actor?._id || null;
  plan.approvedAt = new Date();

  await plan.save();

  res.json({
    success: true,
    plan
  });
});

// ============================================
// Expense Management
// ============================================

exports.listExpenses = asyncHandler(async (req, res) => {
  const allowed = await accessibleProfileIds(req);
  const filter = { profileId: { $in: allowed } };

  if (req.query.month) {
    const range = monthRange(req.query.month);
    filter.expenseDate = { $gte: range.start, $lt: range.end };
  }

  if (req.query.status) {
    filter.status = req.query.status;
  }

  if (req.query.profileId) {
    if (!allowed.includes(String(req.query.profileId))) {
      return res.status(403).json({
        success: false,
        error: 'Field user is outside your hierarchy'
      });
    }

    filter.profileId = req.query.profileId;
  }

  const expenses = await MRExpense
    .find(filter)
    .populate({ path: 'profileId', select: 'employeeCode designation headquarters userId', populate: { path: 'userId', select: 'name' } })
    .sort({ expenseDate: -1 });

  res.json({
    success: true,
    expenses
  });
});

exports.createExpense = asyncHandler(async (req, res) => {
  if (req.user.role === 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Admin cannot create field expenses'
    });
  }

  const actor = await actorProfile(req);

  const fields = pick(req.body, EXPENSE_FIELDS);
  if (fields.expenseDate && new Date(fields.expenseDate) > new Date()) {
    return res.status(400).json({ success: false, error: 'Expense date cannot be in the future' });
  }

  const expense = await MRExpense.create({
    ...fields,
    profileId: actor._id,
    status: 'draft'
  });

  res.status(201).json({
    success: true,
    expense
  });
});

exports.submitExpense = asyncHandler(async (req, res) => {
  if (req.user.role === 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Admin cannot submit field expenses'
    });
  }

  const actor = await actorProfile(req);

  const expense = await MRExpense.findOne({
    _id: req.params.id,
    profileId: actor._id
  });

  if (!expense) {
    return res.status(404).json({
      success: false,
      error: 'Expense not found'
    });
  }

  if (!['draft', 'rejected'].includes(expense.status)) {
    return res.status(409).json({
      success: false,
      error: 'Expense is already submitted'
    });
  }

  expense.status = 'submitted';
  expense.submittedAt = new Date();
  expense.managerComment = undefined;

  await expense.save();

  res.json({
    success: true,
    expense
  });
});

exports.approveExpense = asyncHandler(async (req, res) => {
  const expense = await MRExpense.findById(req.params.id);

  if (!expense) {
    return res.status(404).json({
      success: false,
      error: 'Expense not found'
    });
  }

  await ensureCanManage(req, expense.profileId);

  if (expense.status !== 'submitted') {
    return res.status(409).json({
      success: false,
      error: 'Only submitted expenses can be reviewed'
    });
  }

  const decision = req.body.decision;

  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({
      success: false,
      error: 'decision must be approve or reject'
    });
  }

  const actor = req.user.role === 'admin' ? null : await actorProfile(req);

  expense.status = decision === 'approve' ? 'approved' : 'rejected';
  expense.managerComment = req.body.comment || '';
  expense.approvedBy = actor?._id || null;
  expense.approvedAt = new Date();

  await expense.save();

  res.json({
    success: true,
    expense
  });
});

// ============================================
// Target Management
// ============================================

exports.getTargets = asyncHandler(async (req, res) => {
  const allowed = await accessibleProfileIds(req);
  const month = monthKey(req.query.month);

  const targets = await MRTarget
    .find({ profileId: { $in: allowed }, month })
    .populate({ path: 'profileId', select: 'employeeCode designation headquarters userId', populate: { path: 'userId', select: 'name' } })
    .lean();

  const range = monthRange(month);

  const [visits, pobs, attendance] = await Promise.all([
    MRVisit
      .find({
        profileId: { $in: allowed },
        visitDate: { $gte: range.start, $lt: range.end },
        status: { $in: ['completed', 'submitted', 'approved'] }
      })
      .populate('accountId', 'type')
      .lean(),
    MRPOB
      .find({
        profileId: { $in: allowed },
        orderDate: { $gte: range.start, $lt: range.end },
        status: { $ne: 'cancelled' }
      })
      .lean(),
    MRAttendance
      .find({
        profileId: { $in: allowed },
        dateKey: new RegExp(`^${month}`),
        status: { $in: ['present', 'half_day'] }
      })
      .lean()
  ]);

  const byProfile = {};

  allowed.forEach((profileId) => {
    byProfile[profileId] = {
      calls: 0,
      doctorCalls: 0,
      chemistCalls: 0,
      pob: 0,
      workingDays: 0
    };
  });

  visits.forEach((visit) => {
    const key = String(visit.profileId);
    if (!byProfile[key]) return;
    byProfile[key].calls += 1;
    if (visit.accountId?.type === 'doctor') byProfile[key].doctorCalls += 1;
    if (visit.accountId?.type === 'chemist') byProfile[key].chemistCalls += 1;
  });

  pobs.forEach((order) => {
    const key = String(order.profileId);
    if (byProfile[key]) byProfile[key].pob += Number(order.totalAmount || 0);
  });

  attendance.forEach((record) => {
    const key = String(record.profileId);
    if (byProfile[key]) {
      byProfile[key].workingDays += record.status === 'half_day' ? 0.5 : 1;
    }
  });

  const targetMap = new Map(
    targets.map((target) => [String(target.profileId._id || target.profileId), target])
  );

  const profiles = await MRProfile
    .find({ _id: { $in: allowed } })
    .populate('userId', 'name')
    .lean();

  const rows = profiles.map((profile) => ({
    profile: profileSummary(profile),
    target: targetMap.get(String(profile._id)) || { month },
    achievement: byProfile[String(profile._id)]
  }));

  res.json({
    success: true,
    month,
    rows
  });
});

exports.setTarget = asyncHandler(async (req, res) => {
  const targetProfileId = req.body.profileId;

  if (!targetProfileId) {
    return res.status(400).json({
      success: false,
      error: 'profileId is required'
    });
  }

  await ensureCanManage(req, targetProfileId);

  const actor = req.user.role === 'admin' ? null : await actorProfile(req);
  const month = monthKey(req.body.month);

  const target = await MRTarget.findOneAndUpdate(
    { profileId: targetProfileId, month },
    {
      $set: {
        callTarget: Number(req.body.callTarget || 0),
        doctorCallTarget: Number(req.body.doctorCallTarget || 0),
        chemistCallTarget: Number(req.body.chemistCallTarget || 0),
        pobTarget: Number(req.body.pobTarget || 0),
        salesTarget: Number(req.body.salesTarget || 0),
        workingDaysTarget: Number(req.body.workingDaysTarget || 0),
        setBy: actor?._id || null
      }
    },
    { new: true, upsert: true, runValidators: true }
  );

  res.json({
    success: true,
    target
  });
});

// ============================================
// POB Management
// ============================================

exports.listPOB = asyncHandler(async (req, res) => {
  const allowed = await accessibleProfileIds(req);
  const filter = { profileId: { $in: allowed } };

  if (req.query.month) {
    const range = monthRange(req.query.month);
    filter.orderDate = { $gte: range.start, $lt: range.end };
  }

  const orders = await MRPOB
    .find(filter)
    .populate({ path: 'profileId', select: 'employeeCode designation userId', populate: { path: 'userId', select: 'name' } })
    .populate('accountId', 'name type organizationName address')
    .sort({ orderDate: -1 });

  res.json({
    success: true,
    orders
  });
});

exports.createPOB = asyncHandler(async (req, res) => {
  if (req.user.role === 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Admin cannot create POB orders'
    });
  }

  const actor = await actorProfile(req);
  const account = await MRAccount.findById(req.body.accountId);

  if (!account || !['chemist', 'stockist', 'hospital'].includes(account.type)) {
    return res.status(400).json({
      success: false,
      error: 'POB must be placed against a chemist/stockist/hospital account'
    });
  }

  const allowedForPob = new Set(await accessibleProfileIds(req));
  if (account.assignedProfileIds.length &&
      !account.assignedProfileIds.some((profileId) => allowedForPob.has(String(profileId)))) {
    return res.status(403).json({
      success: false,
      error: 'Account is outside your territory/hierarchy'
    });
  }

  const items = (req.body.items || [])
    .filter((item) =>
      item.productName &&
      Number(item.quantity) > 0 &&
      Number(item.rate) >= 0
    )
    .map((item) => ({
      productName: item.productName,
      sku: item.sku,
      quantity: Number(item.quantity),
      rate: Number(item.rate),
      amount: Number(item.quantity) * Number(item.rate)
    }));

  if (!items.length) {
    return res.status(400).json({
      success: false,
      error: 'At least one valid POB item is required'
    });
  }

  const totalAmount = items.reduce((sum, item) => sum + item.amount, 0);

  const orderNumber = `POB-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const order = await MRPOB.create({
    orderNumber,
    profileId: actor._id,
    accountId: account._id,
    items,
    totalAmount,
    notes: req.body.notes
  });

  res.status(201).json({
    success: true,
    order
  });
});

exports.updatePOBStatus = asyncHandler(async (req, res) => {
  const order = await MRPOB.findById(req.params.id);

  if (!order) {
    return res.status(404).json({
      success: false,
      error: 'POB order not found'
    });
  }

  const actor = req.user.role === 'admin' ? null : await actorProfile(req);
  const isOwner = actor && String(order.profileId) === String(actor._id);

  if (req.body.status === 'cancelled' && isOwner && order.status === 'placed') {
    order.status = 'cancelled';
    await order.save();
    return res.json({
      success: true,
      order
    });
  }

  await ensureCanManage(req, order.profileId);

  const NEXT = { placed: ['accepted', 'cancelled'], accepted: ['fulfilled', 'cancelled'] };
  if (!(NEXT[order.status] || []).includes(req.body.status)) {
    return res.status(409).json({
      success: false,
      error: `A ${order.status} order cannot become ${req.body.status}`
    });
  }

  order.status = req.body.status;
  await order.save();

  res.json({
    success: true,
    order
  });
});

// ============================================
// Sample Ledger
// ============================================

exports.listSamples = asyncHandler(async (req, res) => {
  const allowed = await accessibleProfileIds(req);
  const filter = { profileId: { $in: allowed } };

  if (req.query.profileId) {
    if (!allowed.includes(String(req.query.profileId))) {
      return res.status(403).json({
        success: false,
        error: 'Field user is outside your hierarchy'
      });
    }

    filter.profileId = req.query.profileId;
  }

  if (req.query.itemType) {
    filter.itemType = req.query.itemType;
  }

  const transactions = await MRSampleLedger
    .find(filter)
    .populate({ path: 'profileId', select: 'employeeCode designation userId', populate: { path: 'userId', select: 'name' } })
    .populate('accountId', 'name type')
    .sort({ transactionDate: -1, createdAt: -1 })
    .limit(1500)
    .lean();

  const balances = {};

  transactions.forEach((row) => {
    const itemType = row.itemType || 'sample';
    const key = `${row.profileId?._id || row.profileId}:${itemType}:${row.productName}:${row.batchNumber || ''}`;

    if (!balances[key]) {
      balances[key] = {
        profileId: row.profileId,
        itemType,
        productName: row.productName,
        batchNumber: row.batchNumber || '',
        balance: 0
      };
    }

    balances[key].balance += ledgerDelta(row);
  });

  res.json({
    success: true,
    transactions,
    balances: Object.values(balances)
  });
});

exports.createSampleTransaction = asyncHandler(async (req, res) => {
  const targetProfileId = req.body.profileId;
  const itemType = req.body.itemType === 'gift' ? 'gift' : 'sample';
  const transactionType = req.body.transactionType;
  const quantity = Number(req.body.quantity);

  if (!targetProfileId) {
    return res.status(400).json({
      success: false,
      error: 'profileId is required'
    });
  }

  if (!req.body.productName || !Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({
      success: false,
      error: 'productName and positive quantity are required'
    });
  }

  if (!['issue', 'return', 'adjustment'].includes(transactionType)) {
    return res.status(400).json({
      success: false,
      error: 'transactionType must be issue, return or adjustment'
    });
  }

  const actor = req.user.role === 'admin' ? null : await actorProfile(req);
  const isSelf = actor && String(actor._id) === String(targetProfileId);

  if (!isSelf) {
    await ensureCanManage(req, targetProfileId);
  }

  if (isSelf && transactionType !== 'return') {
    return res.status(403).json({
      success: false,
      error: 'Field users can directly record only returns; issues/adjustments are manager-controlled'
    });
  }

  const adjustmentDirection = transactionType === 'adjustment'
    ? (req.body.adjustmentDirection === 'out' ? 'out' : 'in')
    : undefined;

  if (transactionType === 'return' || adjustmentDirection === 'out') {
    const balance = await itemBalance(
      targetProfileId,
      itemType,
      req.body.productName,
      req.body.batchNumber
    );

    if (balance < quantity) {
      return res.status(409).json({
        success: false,
        error: `Insufficient ${itemType} balance. Available ${balance}, requested ${quantity}`
      });
    }
  }

  const transaction = await MRSampleLedger.create({
    profileId: targetProfileId,
    itemType,
    productName: req.body.productName,
    batchNumber: req.body.batchNumber,
    transactionType,
    adjustmentDirection,
    quantity,
    notes: req.body.notes,
    createdBy: actor?._id || null
  });

  res.status(201).json({
    success: true,
    transaction
  });
});

// ============================================
// E-Detailing
// ============================================

exports.listDetailing = asyncHandler(async (req, res) => {
  const filter = req.user.role === 'admin' && req.query.includeInactive === 'true'
    ? {}
    : { isActive: true };

  if (req.query.q) {
    const rx = new RegExp(
      String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'i'
    );

    filter.$or = [
      { title: rx },
      { productName: rx },
      { tags: rx }
    ];
  }

  const content = await MRDetailingContent
    .find(filter)
    .sort({ productName: 1, title: 1 });

  res.json({
    success: true,
    content
  });
});

exports.createDetailing = asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') {
    const actor = await actorProfile(req);

    if (LEVEL[actor.designation] < LEVEL.ZSM) {
      return res.status(403).json({
        success: false,
        error: 'Only ZSM or admin can publish e-detailing content'
      });
    }
  }

  const fields = pick(req.body, DETAILING_FIELDS);
  if (!/^https?:\/\//i.test(String(fields.url || ''))) {
    return res.status(400).json({ success: false, error: 'Add a link that starts with http:// or https://' });
  }

  const content = await MRDetailingContent.create({
    ...fields,
    createdByUserId: req.user._id
  });

  res.status(201).json({
    success: true,
    content
  });
});

exports.updateDetailing = asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') {
    const actor = await actorProfile(req);

    if (LEVEL[actor.designation] < LEVEL.ZSM) {
      return res.status(403).json({
        success: false,
        error: 'Only ZSM or admin can update e-detailing content'
      });
    }
  }

  const detailingUpdates = pick(req.body, DETAILING_FIELDS);
  if (detailingUpdates.url !== undefined && !/^https?:\/\//i.test(String(detailingUpdates.url))) {
    return res.status(400).json({ success: false, error: 'Add a link that starts with http:// or https://' });
  }

  const content = await MRDetailingContent.findByIdAndUpdate(
    req.params.id,
    { $set: detailingUpdates },
    { new: true, runValidators: true }
  );

  if (!content) {
    return res.status(404).json({
      success: false,
      error: 'Detailing content not found'
    });
  }

  res.json({
    success: true,
    content
  });
});

// ============================================
// Performance & Dashboard
// ============================================

async function performanceForProfiles(profileIds, month) {
  const range = monthRange(month);

  const [profiles, visits, pobs, attendance, targets] = await Promise.all([
    MRProfile
      .find({ _id: { $in: profileIds } })
      .populate('userId', 'name')
      .populate('territoryIds', 'code name city state')
      .lean(),
    MRVisit
      .find({
        profileId: { $in: profileIds },
        visitDate: { $gte: range.start, $lt: range.end },
        status: { $in: ['completed', 'submitted', 'approved'] }
      })
      .populate('accountId', 'type territoryId')
      .lean(),
    MRPOB
      .find({
        profileId: { $in: profileIds },
        orderDate: { $gte: range.start, $lt: range.end },
        status: { $ne: 'cancelled' }
      })
      .lean(),
    MRAttendance
      .find({
        profileId: { $in: profileIds },
        dateKey: new RegExp(`^${month}`),
        status: { $in: ['present', 'half_day'] }
      })
      .lean(),
    MRTarget.find({ profileId: { $in: profileIds }, month }).lean()
  ]);

  const rows = new Map();

  profiles.forEach((profile) => {
    rows.set(String(profile._id), {
      profile: profileSummary(profile),
      calls: 0,
      doctorCalls: 0,
      chemistCalls: 0,
      pobAmount: 0,
      workingDays: 0,
      target: {
        callTarget: 0,
        doctorCallTarget: 0,
        chemistCallTarget: 0,
        pobTarget: 0,
        workingDaysTarget: 0
      }
    });
  });

  visits.forEach((visit) => {
    const row = rows.get(String(visit.profileId));
    if (!row) return;

    row.calls += 1;
    if (visit.accountId?.type === 'doctor') row.doctorCalls += 1;
    if (visit.accountId?.type === 'chemist') row.chemistCalls += 1;
  });

  pobs.forEach((order) => {
    const row = rows.get(String(order.profileId));
    if (row) row.pobAmount += Number(order.totalAmount || 0);
  });

  attendance.forEach((record) => {
    const row = rows.get(String(record.profileId));
    if (row) row.workingDays += record.status === 'half_day' ? 0.5 : 1;
  });

  targets.forEach((target) => {
    const row = rows.get(String(target.profileId));
    if (row) row.target = target;
  });

  return [...rows.values()].map((row) => ({
    ...row,
    achievementPercent: row.target?.pobTarget > 0
      ? Math.round((row.pobAmount / row.target.pobTarget) * 1000) / 10
      : row.target?.callTarget > 0
        ? Math.round((row.calls / row.target.callTarget) * 1000) / 10
        : null
  }));
}

exports.getDashboard = asyncHandler(async (req, res) => {
  const month = monthKey(req.query.month);
  const range = monthRange(month);
  const allowed = await accessibleProfileIds(req);

  let ownProfile = null;

  if (req.user.role !== 'admin') {
    ownProfile = await MRProfile
      .findOne({ userId: req.user._id })
      .populate('userId', 'name email phone')
      .populate('territoryIds', 'code name city state')
      .lean();
  }

  const ownId = ownProfile ? String(ownProfile._id) : null;
  const teamIds = allowed.filter((profileId) => profileId !== ownId);

  const [
    visits,
    expenses,
    pobs,
    attendance,
    accounts,
    pendingVisits,
    pendingExpenses,
    pendingPlans,
    pendingLeaves,
    performance
  ] = await Promise.all([
    MRVisit
      .find({
        profileId: { $in: allowed },
        visitDate: { $gte: range.start, $lt: range.end }
      })
      .populate('accountId', 'type')
      .lean(),
    MRExpense
      .find({
        profileId: { $in: allowed },
        expenseDate: { $gte: range.start, $lt: range.end }
      })
      .lean(),
    MRPOB
      .find({
        profileId: { $in: allowed },
        orderDate: { $gte: range.start, $lt: range.end },
        status: { $ne: 'cancelled' }
      })
      .lean(),
    MRAttendance
      .find({
        profileId: { $in: allowed },
        dateKey: new RegExp(`^${month}`)
      })
      .lean(),
    req.user.role === 'admin'
      ? MRAccount.countDocuments({ isActive: true })
      : MRAccount.countDocuments({
          assignedProfileIds: { $in: allowed },
          isActive: true
        }),
    MRVisit.countDocuments({
      profileId: { $in: teamIds },
      status: 'submitted'
    }),
    MRExpense.countDocuments({
      profileId: { $in: teamIds },
      status: 'submitted'
    }),
    MRTourPlan.countDocuments({
      profileId: { $in: teamIds },
      status: 'submitted'
    }),
    MRLeave.countDocuments({
      profileId: { $in: teamIds },
      status: 'pending'
    }),
    performanceForProfiles(allowed, month)
  ]);

  const completedStatuses = new Set(['completed', 'submitted', 'approved']);
  const completed = visits.filter((visit) => completedStatuses.has(visit.status));

  const metrics = {
    calls: completed.length,
    doctorCalls: completed.filter((visit) => visit.accountId?.type === 'doctor').length,
    chemistCalls: completed.filter((visit) => visit.accountId?.type === 'chemist').length,
    approvedCalls: visits.filter((visit) => visit.status === 'approved').length,
    geofenceExceptions: completed.filter((visit) => visit.geofenceStatus === 'outside').length,
    pobAmount: pobs.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0),
    expensesSubmitted: expenses
      .filter((expense) => ['submitted', 'approved', 'paid'].includes(expense.status))
      .reduce((sum, expense) => sum + Number(expense.amount || 0), 0),
    workingDays: attendance
      .filter((row) => ['present', 'half_day'].includes(row.status))
      .reduce((sum, row) => sum + (row.status === 'half_day' ? 0.5 : 1), 0),
    accounts,
    teamSize: teamIds.length,
    pendingLeaves,
    pendingApprovals: pendingVisits + pendingExpenses + pendingPlans + pendingLeaves
  };

  const selfPerformance = ownId
    ? performance.find((row) => row.profile?.id === ownId) || null
    : null;

  const teamPerformance = performance
    .filter((row) => row.profile?.id !== ownId)
    .sort((a, b) => (b.achievementPercent ?? -1) - (a.achievementPercent ?? -1));

  const recentVisits = await MRVisit
    .find({ profileId: { $in: allowed } })
    .populate({ path: 'profileId', select: 'employeeCode designation userId', populate: { path: 'userId', select: 'name' } })
    .populate('accountId', 'name type')
    .sort({ visitDate: -1 })
    .limit(8);

  res.json({
    success: true,
    month,
    experience: req.user.role === 'admin'
      ? 'ADMIN'
      : ownProfile?.designation || 'MR',
    profile: ownProfile ? profileSummary(ownProfile) : null,
    metrics,
    selfPerformance,
    teamPerformance: teamPerformance.slice(0, 12),
    recentVisits
  });
});

exports.getAnalytics = asyncHandler(async (req, res) => {
  const month = monthKey(req.query.month);
  const allowed = await accessibleProfileIds(req);

  if (req.user.role !== 'admin') {
    const actor = await actorProfile(req);

    if (LEVEL[actor.designation] < LEVEL.ABM) {
      return res.status(403).json({
        success: false,
        error: 'Management analytics are available to ABM/RBM/ZSM and admin'
      });
    }
  }

  const range = monthRange(month);

  const [performance, visits, pobs, expenses, plans] = await Promise.all([
    performanceForProfiles(allowed, month),
    MRVisit
      .find({
        profileId: { $in: allowed },
        visitDate: { $gte: range.start, $lt: range.end },
        status: { $in: ['completed', 'submitted', 'approved'] }
      })
      .populate('accountId', 'type territoryId')
      .lean(),
    MRPOB
      .find({
        profileId: { $in: allowed },
        orderDate: { $gte: range.start, $lt: range.end },
        status: { $ne: 'cancelled' }
      })
      .lean(),
    MRExpense
      .find({
        profileId: { $in: allowed },
        expenseDate: { $gte: range.start, $lt: range.end },
        status: { $in: ['submitted', 'approved', 'paid'] }
      })
      .lean(),
    MRTourPlan
      .find({
        profileId: { $in: allowed },
        month
      })
      .lean()
  ]);

  const totals = {
    fieldUsers: performance.length,
    calls: performance.reduce((sum, row) => sum + row.calls, 0),
    doctorCalls: performance.reduce((sum, row) => sum + row.doctorCalls, 0),
    chemistCalls: performance.reduce((sum, row) => sum + row.chemistCalls, 0),
    pobAmount: pobs.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0),
    expenses: expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0),
    approvedTourPlans: plans.filter((plan) => plan.status === 'approved').length,
    submittedTourPlans: plans.filter((plan) => plan.status === 'submitted').length,
    geofenceExceptions: visits.filter((visit) => visit.geofenceStatus === 'outside').length
  };

  const byDesignation = {};

  performance.forEach((row) => {
    const key = row.profile?.designation || 'UNKNOWN';

    if (!byDesignation[key]) {
      byDesignation[key] = {
        designation: key,
        headcount: 0,
        calls: 0,
        pobAmount: 0,
        workingDays: 0
      };
    }

    byDesignation[key].headcount += 1;
    byDesignation[key].calls += row.calls;
    byDesignation[key].pobAmount += row.pobAmount;
    byDesignation[key].workingDays += row.workingDays;
  });

  res.json({
    success: true,
    month,
    totals,
    performance: performance.sort((a, b) =>
      (b.achievementPercent ?? -1) - (a.achievementPercent ?? -1)
    ),
    byDesignation: Object.values(byDesignation)
  });
});

// ============================================
// Error Handler
// ============================================

// ============================================
// Expense receipts & payouts
// ============================================

function publicExpense(expense) {
  const out = expense.toObject ? expense.toObject() : { ...expense };
  if (out.receipt) delete out.receipt.path;
  return out;
}

function removeFile(filePath) {
  if (!filePath) return;
  fs.promises.unlink(filePath).catch(() => {});
}

exports.uploadExpenseReceipt = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'Attach the receipt as a photo or PDF' });
  }

  const actor = req.user.role === 'admin' ? null : await actorProfile(req);
  const expense = actor
    ? await MRExpense.findOne({ _id: req.params.id, profileId: actor._id }).select('+receipt.path')
    : null;

  if (!expense) {
    removeFile(req.file.path);
    return res.status(404).json({ success: false, error: 'Expense not found' });
  }

  if (!['draft', 'rejected'].includes(expense.status)) {
    removeFile(req.file.path);
    return res.status(409).json({ success: false, error: 'Receipts can only change before the claim is sent' });
  }

  const previous = expense.receipt?.path;
  expense.receipt = {
    path: req.file.path,
    mimeType: req.file.mimetype,
    originalName: req.file.originalname,
    size: req.file.size,
    uploadedAt: new Date()
  };
  await expense.save();
  if (previous && previous !== req.file.path) removeFile(previous);

  res.json({ success: true, expense: publicExpense(expense) });
});

exports.downloadExpenseReceipt = asyncHandler(async (req, res) => {
  const expense = await MRExpense.findById(req.params.id).select('+receipt.path');

  if (!expense?.receipt?.path) {
    return res.status(404).json({ success: false, error: 'No receipt on this expense' });
  }

  if (req.user.role !== 'admin') {
    const actor = await actorProfile(req);
    if (String(actor._id) !== String(expense.profileId)) {
      await ensureCanManage(req, expense.profileId);
    }
  }

  const resolved = path.resolve(expense.receipt.path);
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ success: false, error: 'Receipt file is missing from storage' });
  }

  res.type(expense.receipt.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${String(expense.receipt.originalName || 'receipt').replace(/"/g, '')}"`);
  res.sendFile(resolved);
});

exports.payExpense = asyncHandler(async (req, res) => {
  const expense = await MRExpense.findById(req.params.id);

  if (!expense) {
    return res.status(404).json({ success: false, error: 'Expense not found' });
  }

  await ensureCanManage(req, expense.profileId);

  if (expense.status !== 'approved') {
    return res.status(409).json({ success: false, error: 'Only approved expenses can be marked paid' });
  }

  expense.status = 'paid';
  expense.paidAt = new Date();
  expense.paidBy = req.user._id;
  expense.paymentReference = String(req.body.reference || '').trim().slice(0, 80) || undefined;
  await expense.save();

  res.json({ success: true, expense: publicExpense(expense) });
});

// ============================================
// Leave
// ============================================

const LEAVE_BACKDATE_DAYS = Number(process.env.MR_LEAVE_BACKDATE_DAYS || 7);
const LEAVE_MAX_DAYS = 30;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function dayKeysBetween(fromKey, toKey) {
  const out = [];
  const cursor = new Date(`${fromKey}T00:00:00.000Z`);
  const end = new Date(`${toKey}T00:00:00.000Z`);
  while (cursor <= end && out.length <= LEAVE_MAX_DAYS * 2) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

// Sundays are off anyway, so they are neither counted nor marked.
function workingDayKeys(fromKey, toKey) {
  return dayKeysBetween(fromKey, toKey)
    .filter((key) => new Date(`${key}T00:00:00.000Z`).getUTCDay() !== 0);
}

async function markLeaveAttendance(leave) {
  const status = leave.halfDay ? 'half_day' : 'leave';
  for (const dateKey of workingDayKeys(leave.fromDate, leave.toDate)) {
    const row = await MRAttendance.findOne({ profileId: leave.profileId, dateKey });
    if (row?.punchIn?.at) {
      // Worked that day after all; a half-day leave still halves it.
      if (leave.halfDay && row.status === 'present') {
        row.status = 'half_day';
        await row.save();
      }
      continue;
    }
    await MRAttendance.updateOne(
      { profileId: leave.profileId, dateKey },
      { $set: { status, workType: 'leave', notes: `${leave.leaveType} leave` } },
      { upsert: true }
    );
  }
}

async function clearLeaveAttendance(leave) {
  await MRAttendance.deleteMany({
    profileId: leave.profileId,
    dateKey: { $gte: leave.fromDate, $lte: leave.toDate },
    workType: 'leave',
    'punchIn.at': { $exists: false }
  });
}

const leavePopulate = { path: 'profileId', select: 'employeeCode designation headquarters userId', populate: { path: 'userId', select: 'name' } };

exports.listLeaves = asyncHandler(async (req, res) => {
  const allowed = await accessibleProfileIds(req);
  const filter = { profileId: { $in: allowed } };

  if (req.query.profileId) {
    if (!allowed.includes(String(req.query.profileId))) {
      return res.status(403).json({ success: false, error: 'Field user is outside your hierarchy' });
    }
    filter.profileId = req.query.profileId;
  }

  if (req.query.status) filter.status = req.query.status;

  if (req.query.month) {
    const month = monthKey(req.query.month);
    filter.fromDate = { $lte: `${month}-31` };
    filter.toDate = { $gte: `${month}-01` };
  }

  const leaves = await MRLeave.find(filter).populate(leavePopulate).sort({ fromDate: -1 }).limit(500);
  res.json({ success: true, leaves });
});

exports.applyLeave = asyncHandler(async (req, res) => {
  if (req.user.role === 'admin') {
    return res.status(403).json({ success: false, error: 'Admin does not apply for field leave' });
  }

  const actor = await actorProfile(req);
  const fromDate = String(req.body.fromDate || '').slice(0, 10);
  const toDate = String(req.body.toDate || fromDate).slice(0, 10);

  if (!DAY_KEY.test(fromDate) || !DAY_KEY.test(toDate) || toDate < fromDate) {
    return res.status(400).json({ success: false, error: 'Choose a valid from and to date' });
  }

  const earliest = dateKeyInAppTimezone(new Date(Date.now() - LEAVE_BACKDATE_DAYS * 24 * 60 * 60 * 1000));
  if (fromDate < earliest) {
    return res.status(400).json({ success: false, error: `Leave can be applied at most ${LEAVE_BACKDATE_DAYS} days back` });
  }

  const halfDay = req.body.halfDay === true && fromDate === toDate;
  const working = workingDayKeys(fromDate, toDate);
  if (!working.length) {
    return res.status(400).json({ success: false, error: 'Those dates fall on Sundays' });
  }
  if (working.length > LEAVE_MAX_DAYS) {
    return res.status(400).json({ success: false, error: `A single request can cover up to ${LEAVE_MAX_DAYS} days` });
  }

  const overlap = await MRLeave.exists({
    profileId: actor._id,
    status: { $in: ['pending', 'approved'] },
    fromDate: { $lte: toDate },
    toDate: { $gte: fromDate }
  });
  if (overlap) {
    return res.status(409).json({ success: false, error: 'You already have leave on some of these days' });
  }

  const leaveType = ['casual', 'sick', 'earned', 'other'].includes(req.body.leaveType) ? req.body.leaveType : 'casual';
  const leave = await MRLeave.create({
    profileId: actor._id,
    fromDate,
    toDate,
    halfDay,
    days: halfDay ? 0.5 : working.length,
    leaveType,
    reason: String(req.body.reason || '').trim().slice(0, 500)
  });

  res.status(201).json({ success: true, leave });
});

exports.reviewLeave = asyncHandler(async (req, res) => {
  const leave = await MRLeave.findById(req.params.id);

  if (!leave) {
    return res.status(404).json({ success: false, error: 'Leave request not found' });
  }

  await ensureCanManage(req, leave.profileId);

  if (leave.status !== 'pending') {
    return res.status(409).json({ success: false, error: 'Only pending leave can be reviewed' });
  }

  const decision = req.body.decision;
  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ success: false, error: 'decision must be approve or reject' });
  }

  const actor = req.user.role === 'admin' ? null : await actorProfile(req);
  leave.status = decision === 'approve' ? 'approved' : 'rejected';
  leave.managerComment = String(req.body.comment || '').trim();
  leave.reviewedBy = actor?._id || null;
  leave.reviewedAt = new Date();
  await leave.save();

  if (leave.status === 'approved') await markLeaveAttendance(leave);

  res.json({ success: true, leave: await leave.populate(leavePopulate) });
});

exports.cancelLeave = asyncHandler(async (req, res) => {
  const actor = req.user.role === 'admin' ? null : await actorProfile(req);
  const leave = actor ? await MRLeave.findOne({ _id: req.params.id, profileId: actor._id }) : null;

  if (!leave) {
    return res.status(404).json({ success: false, error: 'Leave request not found' });
  }

  const today = dateKeyInAppTimezone();
  if (leave.status === 'approved' && leave.fromDate <= today) {
    return res.status(409).json({ success: false, error: 'Leave that has started cannot be cancelled; ask your manager' });
  }
  if (!['pending', 'approved'].includes(leave.status)) {
    return res.status(409).json({ success: false, error: 'This leave is already closed' });
  }

  const wasApproved = leave.status === 'approved';
  leave.status = 'cancelled';
  await leave.save();
  if (wasApproved) await clearLeaveAttendance(leave);

  res.json({ success: true, leave });
});

// ============================================
// Aadya Plus directory (link customers to their own accounts)
// ============================================

function coordinates(point) {
  const [lng, lat] = point?.coordinates || [];
  return Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0) ? { lat, lng } : null;
}

function directoryDoctor(doctor) {
  const a = doctor.clinicAddress || {};
  return {
    kind: 'doctor',
    refId: String(doctor._id),
    name: doctor.name,
    specialty: (doctor.specialization || []).join(', '),
    organizationName: doctor.clinicName || '',
    registrationNumber: doctor.licenseNumber || '',
    profileImage: doctor.profileImage || null,
    address: { line1: a.address || '', locality: a.locality || '', city: a.city || '', state: a.state || '', pincode: a.pincode || '' },
    location: coordinates(a.location)
  };
}

function directoryPharmacy(store) {
  const a = store.address || {};
  return {
    kind: 'pharmacy',
    refId: String(store._id),
    name: store.name,
    specialty: '',
    organizationName: '',
    registrationNumber: store.drugLicenseNumber || store.licenseNumber || '',
    phone: store.phone || '',
    address: { line1: a.street || '', locality: '', city: a.city || '', state: a.state || '', pincode: a.pincode || '' },
    location: coordinates(a.location)
  };
}

async function resolveLinkedEntity(input) {
  if (!input || !input.refId) return null;
  const kind = input.kind === 'pharmacy' ? 'pharmacy' : input.kind === 'doctor' ? 'doctor' : null;
  if (!kind || !mongoose.isValidObjectId(input.refId)) {
    const error = new Error('Choose a doctor or pharmacy from Aadya Plus to link');
    error.statusCode = 400;
    throw error;
  }
  const found = kind === 'doctor'
    ? await DoctorProfile.findOne({ _id: input.refId, verificationStatus: 'approved' }).select('name').lean()
    : await PharmacyStore.findOne({ _id: input.refId, status: 'active' }).select('name').lean();
  if (!found) {
    const error = new Error('That Aadya Plus account is not available to link');
    error.statusCode = 404;
    throw error;
  }
  return { kind, refId: found._id, name: found.name, linkedAt: new Date() };
}

exports.searchDirectory = asyncHandler(async (req, res) => {
  const kind = req.query.kind === 'pharmacy' ? 'pharmacy' : 'doctor';
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ success: true, results: [] });

  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const results = kind === 'doctor'
    ? (await DoctorProfile
        .find({ verificationStatus: 'approved', $or: [{ name: rx }, { clinicName: rx }, { specialization: rx }, { 'clinicAddress.city': rx }] })
        .select('name specialization clinicName licenseNumber profileImage clinicAddress')
        .limit(20)
        .lean()).map(directoryDoctor)
    : (await PharmacyStore
        .find({ status: 'active', $or: [{ name: rx }, { 'address.city': rx }] })
        .select('name phone licenseNumber drugLicenseNumber address')
        .limit(20)
        .lean()).map(directoryPharmacy);

  // Flag the ones already on the caller's customer list.
  const allowed = await accessibleProfileIds(req);
  const linked = await MRAccount.find({
    ...(req.user.role === 'admin' ? {} : { assignedProfileIds: { $in: allowed } }),
    'linkedEntity.refId': { $in: results.map((r) => r.refId) }
  }).select('_id linkedEntity.refId').lean();
  const byRef = new Map(linked.map((a) => [String(a.linkedEntity.refId), String(a._id)]));

  res.json({
    success: true,
    results: results.map((r) => ({ ...r, accountId: byRef.get(r.refId) || null }))
  });
});

exports.errorHandler = (err, req, res, next) => {
  console.error('MR module error:', err);

  if (res.headersSent) {
    return next(err);
  }

  const status = err.statusCode ||
    (err.name === 'ValidationError' || err.name === 'MulterError' ? 400 : err.code === 11000 ? 409 : 500);

  const message = err.code === 11000
    ? `Duplicate value for ${Object.keys(err.keyPattern || {})[0] || 'unique field'}`
    : err.message || 'MR operation failed';

  res.status(status).json({
    success: false,
    error: message
  });
};