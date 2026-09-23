const PharmacyStore = require('../models/PharmacyStore');
const Organization = require('../models/Organization');
const { provisionPharmacyTenant } = require('../services/pharmacyTenant.service');

const requestedStoreId = (req) => (
  req.headers['x-pharmacy-store-id'] ||
  req.query.storeId || req.query.store_id ||
  req.body?.storeId || req.body?.store_id ||
  null
);

const requestedOrganizationId = (req) => (
  req.headers['x-organization-id'] ||
  req.query.organizationId || req.query.organization_id ||
  req.body?.organizationId || req.body?.organization_id ||
  null
);

async function resolvePharmacyTenant(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: 'Authentication required' });

    let organization = null;
    let store = null;
    const requestedStore = requestedStoreId(req);
    const requestedOrg = requestedOrganizationId(req);

    if (req.user.role === 'pharmacy') {
      const provisioned = await provisionPharmacyTenant(req.user);
      organization = provisioned.organization;

      const allowedIds = new Set((req.user.pharmacyStoreIds || []).map(String));
      const selectedStoreId = requestedStore || req.user.defaultPharmacyStoreId || provisioned.store._id;
      if (!allowedIds.has(String(selectedStoreId))) {
        return res.status(403).json({ success: false, error: 'You do not have access to the selected pharmacy store' });
      }

      store = await PharmacyStore.findOne({
        _id: selectedStoreId,
        organizationId: organization._id,
        status: 'active'
      });
    } else if (req.user.role === 'admin') {
      if (!requestedStore) {
        return res.status(400).json({
          success: false,
          error: 'Admin requests to pharmacy operational APIs must include X-Pharmacy-Store-Id'
        });
      }
      store = await PharmacyStore.findOne({ _id: requestedStore, status: 'active' });
      if (store) organization = await Organization.findById(store.organizationId);
      if (requestedOrg && organization && String(requestedOrg) !== String(organization._id)) {
        return res.status(403).json({ success: false, error: 'Store does not belong to the requested organization' });
      }
    } else {
      // Every route that mounts this middleware today gates on
      // authorize('admin', 'pharmacy') first, so this branch is currently
      // unreachable — but fail closed rather than trusting any other
      // authenticated role to access an arbitrary store by guessing its ID.
      return res.status(403).json({ success: false, error: 'Not authorized to access pharmacy store data' });
    }

    if (!organization || organization.status !== 'active') {
      return res.status(403).json({ success: false, error: 'Pharmacy organization is inactive or unavailable' });
    }
    if (!store) {
      return res.status(404).json({ success: false, error: 'Selected pharmacy store was not found or is inactive' });
    }

    req.tenant = {
      organizationId: organization._id,
      storeId: store._id,
      organization,
      store
    };
    next();
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('Pharmacy tenant middleware error:', error);
    return res.status(status).json({ success: false, error: error.message || 'Failed to resolve pharmacy tenant' });
  }
}

async function resolvePharmacyTenantIfApplicable(req, res, next) {
  if (req.user?.role !== 'pharmacy') return next();
  return resolvePharmacyTenant(req, res, next);
}

module.exports = { resolvePharmacyTenant, resolvePharmacyTenantIfApplicable };
