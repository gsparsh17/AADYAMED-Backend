/**
 * Store-level operational role guard.
 * Platform administrators bypass organization roles because they are already
 * authenticated through the platform admin role and must explicitly select a store.
 */
const requireOrganizationRole = (...allowedRoles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  if (req.user.role === 'admin') return next();

  const role = req.user.organizationRole || 'viewer';
  if (!allowedRoles.includes(role)) {
    return res.status(403).json({
      success: false,
      error: `Organization role '${role}' cannot perform this operation`
    });
  }

  next();
};

module.exports = { requireOrganizationRole };
