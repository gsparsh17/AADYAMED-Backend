const crypto = require('crypto');
const Organization = require('../models/Organization');
const PharmacyStore = require('../models/PharmacyStore');
const PharmacyProfile = require('../models/PharmacyProfile');
const User = require('../models/User');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const Supplier = require('../models/Supplier');
const PurchaseOrder = require('../models/PurchaseOrder');
const PharmacySale = require('../models/PharmacySale');
const StockAdjustment = require('../models/StockAdjustment');
const PharmacyInvoice = require('../models/pharmacyInvoiceModel');
const Invoice = require('../models/Invoice');

const slug = (value = '') => String(value)
  .toUpperCase()
  .replace(/[^A-Z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 24);

const uniqueSuffix = () => crypto.randomBytes(3).toString('hex').toUpperCase();

async function backfillOwnedPharmacyData(userId, organizationId, storeId) {
  const operations = [
    Medicine.updateMany(
      { createdBy: userId, $or: [
        { organizationId: { $exists: false } }, { organizationId: null },
        { storeId: { $exists: false } }, { storeId: null }
      ] },
      { $set: { organizationId, storeId } }
    ),
    MedicineBatch.updateMany(
      { addedBy: userId, $or: [
        { organizationId: { $exists: false } }, { organizationId: null },
        { storeId: { $exists: false } }, { storeId: null }
      ] },
      { $set: { organizationId, storeId } }
    ),
    Supplier.updateMany(
      { addedBy: userId, $or: [
        { organizationId: { $exists: false } }, { organizationId: null },
        { storeId: { $exists: false } }, { storeId: null }
      ] },
      { $set: { organizationId, storeId } }
    ),
    PurchaseOrder.updateMany(
      { createdBy: userId, $or: [
        { organizationId: { $exists: false } }, { organizationId: null },
        { storeId: { $exists: false } }, { storeId: null }
      ] },
      { $set: { organizationId, storeId } }
    ),
    PharmacySale.updateMany(
      { createdBy: userId, $or: [
        { organizationId: { $exists: false } }, { organizationId: null },
        { storeId: { $exists: false } }, { storeId: null }
      ] },
      { $set: { organizationId, storeId } }
    ),
    StockAdjustment.updateMany(
      { adjustedBy: userId, $or: [
        { organizationId: { $exists: false } }, { organizationId: null },
        { storeId: { $exists: false } }, { storeId: null }
      ] },
      { $set: { organizationId, storeId } }
    ),
    PharmacyInvoice.updateMany(
      { created_by: userId, $or: [
        { organizationId: { $exists: false } }, { organizationId: null },
        { storeId: { $exists: false } }, { storeId: null }
      ] },
      { $set: { organizationId, storeId } }
    ),
    Invoice.updateMany(
      { invoiceType: 'pharmacy', createdBy: userId, $or: [
        { organizationId: { $exists: false } }, { organizationId: null },
        { storeId: { $exists: false } }, { storeId: null }
      ] },
      { $set: { organizationId, storeId } }
    )
  ];

  await Promise.all(operations);
}

async function provisionPharmacyTenant(user, profile = null) {
  if (!user || user.role !== 'pharmacy') {
    throw new Error('Pharmacy user is required for tenant provisioning');
  }

  const pharmacyProfile = profile || await PharmacyProfile.findOne({ userId: user._id });
  if (!pharmacyProfile) {
    const error = new Error('Complete the pharmacy profile before using inventory or sales modules');
    error.statusCode = 409;
    throw error;
  }

  // Lazy provisioning should only run the potentially expensive legacy-data backfill
  // when this user/profile has not yet been tenant-initialized. Full reconciliation is
  // available through scripts/migrate-pharmacy-tenancy.js.
  const shouldBackfill = !user.organizationId || !user.defaultPharmacyStoreId ||
    !pharmacyProfile.organizationId || !pharmacyProfile.defaultStoreId;

  let organization = null;
  if (user.organizationId) {
    organization = await Organization.findById(user.organizationId);
  }
  if (!organization && pharmacyProfile.organizationId) {
    organization = await Organization.findById(pharmacyProfile.organizationId);
  }
  if (!organization) {
    organization = await Organization.findOne({ ownerUserId: user._id, status: { $ne: 'suspended' } });
  }

  if (!organization) {
    const baseCode = slug(pharmacyProfile.pharmacyName || user.name || 'PHARMACY') || 'PHARMACY';
    let code = `${baseCode}-${uniqueSuffix()}`;
    while (await Organization.exists({ code })) code = `${baseCode}-${uniqueSuffix()}`;

    organization = await Organization.create({
      name: pharmacyProfile.pharmacyName || user.name,
      code,
      type: 'independent_pharmacy',
      ownerUserId: user._id,
      contact: { email: pharmacyProfile.email || user.email, phone: pharmacyProfile.phone || user.phone },
      address: {
        street: pharmacyProfile.address?.street,
        city: pharmacyProfile.address?.city,
        state: pharmacyProfile.address?.state,
        pincode: pharmacyProfile.address?.pincode,
        country: 'India'
      },
      createdBy: user._id
    });
  }

  let store = null;
  const candidateStoreId = user.defaultPharmacyStoreId || pharmacyProfile.defaultStoreId;
  if (candidateStoreId) {
    store = await PharmacyStore.findOne({ _id: candidateStoreId, organizationId: organization._id });
  }
  if (!store) {
    store = await PharmacyStore.findOne({ organizationId: organization._id, pharmacyProfileId: pharmacyProfile._id });
  }
  if (!store) {
    store = await PharmacyStore.findOne({ organizationId: organization._id, isDefault: true });
  }

  if (!store) {
    store = await PharmacyStore.create({
      organizationId: organization._id,
      pharmacyProfileId: pharmacyProfile._id,
      name: pharmacyProfile.pharmacyName || user.name,
      code: 'MAIN',
      licenseNumber: pharmacyProfile.licenseNumber,
      email: pharmacyProfile.email || user.email,
      phone: pharmacyProfile.phone || user.phone,
      address: pharmacyProfile.address || {},
      operatingHours: pharmacyProfile.operatingHours,
      isDefault: true,
      createdBy: user._id
    });
  }

  const storeIds = Array.from(new Set([
    ...(user.pharmacyStoreIds || []).map(String),
    String(store._id)
  ]));

  user.organizationId = organization._id;
  user.organizationRole = user.organizationRole || 'owner';
  user.pharmacyStoreIds = storeIds;
  user.defaultPharmacyStoreId = user.defaultPharmacyStoreId || store._id;
  await user.save();

  pharmacyProfile.organizationId = organization._id;
  pharmacyProfile.defaultStoreId = pharmacyProfile.defaultStoreId || store._id;
  await pharmacyProfile.save();

  if (shouldBackfill) {
    await backfillOwnedPharmacyData(user._id, organization._id, store._id);
  }

  return { organization, store, profile: pharmacyProfile, user };
}

async function getAllowedStores(user) {
  if (!user.organizationId) return [];
  const filter = { organizationId: user.organizationId, status: { $ne: 'suspended' } };
  if (user.role === 'pharmacy' && user.pharmacyStoreIds?.length) {
    filter._id = { $in: user.pharmacyStoreIds };
  }
  return PharmacyStore.find(filter).sort({ isDefault: -1, name: 1 });
}

async function ensureDefaultStoreAssignment(user, storeId) {
  const store = await PharmacyStore.findOne({ _id: storeId, organizationId: user.organizationId, status: 'active' });
  if (!store) {
    const error = new Error('Store not found or not available to this organization');
    error.statusCode = 404;
    throw error;
  }

  if (user.role === 'pharmacy' && user.pharmacyStoreIds?.length && !user.pharmacyStoreIds.some(id => String(id) === String(store._id))) {
    const error = new Error('You do not have access to this pharmacy store');
    error.statusCode = 403;
    throw error;
  }

  user.defaultPharmacyStoreId = store._id;
  await user.save();
  return store;
}

module.exports = {
  provisionPharmacyTenant,
  backfillOwnedPharmacyData,
  getAllowedStores,
  ensureDefaultStoreAssignment
};
