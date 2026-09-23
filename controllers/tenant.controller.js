const Organization = require('../models/Organization');
const PharmacyStore = require('../models/PharmacyStore');
const { provisionPharmacyTenant, getAllowedStores, ensureDefaultStoreAssignment } = require('../services/pharmacyTenant.service');

const sanitizeCode = (value = '') => String(value).trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);

exports.getContext = async (req, res) => {
  try {
    if (req.user.role !== 'pharmacy') {
      return res.status(403).json({ success: false, error: 'Tenant context is currently available for pharmacy users only' });
    }

    const { organization, store } = await provisionPharmacyTenant(req.user);
    const stores = await getAllowedStores(req.user);
    const defaultStoreId = req.user.defaultPharmacyStoreId || store._id;

    res.json({
      success: true,
      organization,
      stores,
      defaultStoreId,
      organizationRole: req.user.organizationRole || 'owner'
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

exports.getOrganization = async (req, res) => {
  try {
    const { organization } = await provisionPharmacyTenant(req.user);
    res.json({ success: true, organization });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

exports.updateOrganization = async (req, res) => {
  try {
    const { organization } = await provisionPharmacyTenant(req.user);
    if (!['owner', 'admin'].includes(req.user.organizationRole || 'owner')) {
      return res.status(403).json({ success: false, error: 'Only organization owners/admins can update organization settings' });
    }

    const allowed = ['name', 'contact', 'address', 'settings'];
    const updates = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => allowed.includes(key)));
    updates.updatedBy = req.user._id;

    const updated = await Organization.findOneAndUpdate(
      { _id: organization._id, status: { $ne: 'suspended' } },
      { $set: updates },
      { new: true, runValidators: true }
    );
    res.json({ success: true, organization: updated });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

exports.listStores = async (req, res) => {
  try {
    await provisionPharmacyTenant(req.user);
    const stores = await getAllowedStores(req.user);
    res.json({ success: true, stores, defaultStoreId: req.user.defaultPharmacyStoreId });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

exports.createStore = async (req, res) => {
  try {
    const { organization, profile } = await provisionPharmacyTenant(req.user);
    if (!['owner', 'admin'].includes(req.user.organizationRole || 'owner')) {
      return res.status(403).json({ success: false, error: 'Only organization owners/admins can create stores' });
    }

    const name = String(req.body.name || '').trim();
    const code = sanitizeCode(req.body.code || name);
    if (!name || !code) return res.status(400).json({ success: false, error: 'Store name and code are required' });

    const exists = await PharmacyStore.exists({ organizationId: organization._id, code });
    if (exists) return res.status(409).json({ success: false, error: 'A store with this code already exists in the organization' });

    const store = await PharmacyStore.create({
      organizationId: organization._id,
      pharmacyProfileId: profile._id,
      name,
      code,
      licenseNumber: req.body.licenseNumber || profile.licenseNumber,
      drugLicenseNumber: req.body.drugLicenseNumber || req.body.licenseNumber || profile.licenseNumber,
      gstin: req.body.gstin,
      email: req.body.email || profile.email || req.user.email,
      phone: req.body.phone || profile.phone || req.user.phone,
      address: req.body.address || {},
      operatingHours: req.body.operatingHours,
      settings: req.body.settings,
      isDefault: false,
      createdBy: req.user._id
    });

    req.user.pharmacyStoreIds = Array.from(new Set([...(req.user.pharmacyStoreIds || []).map(String), String(store._id)]));
    await req.user.save();

    res.status(201).json({ success: true, store });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, error: 'Store code already exists' });
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

exports.updateStore = async (req, res) => {
  try {
    const { organization, profile } = await provisionPharmacyTenant(req.user);
    if (!['owner', 'admin', 'manager'].includes(req.user.organizationRole || 'owner')) {
      return res.status(403).json({ success: false, error: 'You cannot update pharmacy stores' });
    }

    const allowedStoreIds = new Set((req.user.pharmacyStoreIds || []).map(String));
    if (!allowedStoreIds.has(String(req.params.id))) {
      return res.status(403).json({ success: false, error: 'You do not have access to this pharmacy store' });
    }

    const allowed = ['name', 'licenseNumber', 'drugLicenseNumber', 'gstin', 'email', 'phone', 'address', 'operatingHours', 'settings', 'status'];
    const updates = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => allowed.includes(key)));
    updates.updatedBy = req.user._id;

    const existing = await PharmacyStore.findOne({ _id: req.params.id, organizationId: organization._id });
    if (!existing) return res.status(404).json({ success: false, error: 'Store not found' });

    // The default store is the registered pharmacy — the one verification
    // looked at — so its trading name, licences and GSTIN are frozen once the
    // profile is approved. Additional branches were never verified on their
    // own, so theirs stay editable.
    if (existing.isDefault && ['approved', 'suspended'].includes(profile.verificationStatus)) {
      const lockedFields = ['name', 'licenseNumber', 'drugLicenseNumber', 'gstin'];
      const changed = lockedFields.filter((field) => {
        if (updates[field] === undefined || updates[field] === null) return false;
        const current = existing[field];
        const currentText = String(current === undefined || current === null ? '' : current).trim();
        // A blank field was never verified — first-time entry stays allowed.
        if (currentText === '') return false;
        return String(updates[field]).trim() !== currentText;
      });
      if (changed.length > 0) {
        return res.status(403).json({
          success: false,
          message: `Your pharmacy is verified, so ${changed.join(', ')} can no longer be changed here. Contact support to update ${changed.length > 1 ? 'them' : 'it'}.`,
          lockedFields: changed
        });
      }
    }

    const store = await PharmacyStore.findOneAndUpdate(
      { _id: req.params.id, organizationId: organization._id },
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!store) return res.status(404).json({ success: false, error: 'Store not found' });
    res.json({ success: true, store });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

exports.selectDefaultStore = async (req, res) => {
  try {
    await provisionPharmacyTenant(req.user);
    const store = await ensureDefaultStoreAssignment(req.user, req.params.id);
    res.json({ success: true, defaultStoreId: store._id, store });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};
