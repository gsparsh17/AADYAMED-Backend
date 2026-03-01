const AuditLog = require('../models/AuditLog');
// Optional: npm i geoip-lite
let geoip = null;
try {
  geoip = require('geoip-lite');
} catch (_) {}

function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return body;
  const clone = { ...body };
  if (clone.password) clone.password = '***';
  if (clone.newPassword) clone.newPassword = '***';
  if (clone.confirmPassword) clone.confirmPassword = '***';
  if (clone.token) clone.token = '***';
  return clone;
}

exports.auditLogger = (action, entity) => {
  return (req, res, next) => {
    const start = Date.now();

    res.on('finish', async () => {
      try {
        if (!req.user) return;

        const log = {
          userId: req.user.id,
          userRole: req.user.role,
          action,
          entity,
          entityId: req.params.id || req.body?.id,
          endpoint: req.originalUrl,
          method: req.method,
          statusCode: res.statusCode,
          requestBody: sanitizeBody(req.body),
          queryParams: req.query,
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
          responseTime: Date.now() - start,
          timestamp: new Date(),
        };

        // ✅ Add geo ONLY if we can resolve coords (GeoJSON requires [lng, lat])
        const rawIp = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
        if (geoip) {
          const geo = geoip.lookup(rawIp);
          if (geo?.ll && geo.ll.length === 2) {
            const [lat, lng] = geo.ll;
            log.location = { type: 'Point', coordinates: [lng, lat] };
          }
        }

        await AuditLog.create(log);
      } catch (e) {
        console.error('Audit logging error:', e.message);
      }
    });

    next();
  };
};