const mongoose = require('mongoose');

const normalizeId = (value) => {
  if (!value) return null;
  return String(value);
};

const assertObjectId = (value, fieldName) => {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) {
    const error = new Error(`${fieldName} is invalid or missing`);
    error.statusCode = 400;
    throw error;
  }
  return value;
};

const getTenantIds = (req) => {
  const organizationId = req.tenant?.organizationId;
  const storeId = req.tenant?.storeId;
  if (!organizationId || !storeId) {
    const error = new Error('Pharmacy tenant context is required');
    error.statusCode = 400;
    throw error;
  }
  return { organizationId, storeId };
};

const scopedFilter = (req, extra = {}) => {
  const { organizationId, storeId } = getTenantIds(req);
  return { ...extra, organizationId, storeId };
};

const scopedPayload = (req, payload = {}) => {
  const { organizationId, storeId } = getTenantIds(req);
  return { ...payload, organizationId, storeId };
};

const sameId = (a, b) => normalizeId(a) && normalizeId(a) === normalizeId(b);

module.exports = {
  assertObjectId,
  getTenantIds,
  scopedFilter,
  scopedPayload,
  sameId
};
