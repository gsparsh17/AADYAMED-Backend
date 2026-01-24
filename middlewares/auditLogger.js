const AuditLog = require('../models/AuditLog');

exports.auditLogger = (action, entity) => {
  return async (req, res, next) => {
    const oldSend = res.send;
    
    res.send = function(data) {
      // Log after response is sent
      try {
        if (req.user) {
          const auditLog = new AuditLog({
            userId: req.user.id,
            userRole: req.user.role,
            action,
            entity,
            entityId: req.params.id || req.body.id,
            endpoint: req.originalUrl,
            method: req.method,
            statusCode: res.statusCode,
            requestBody: req.body,
            queryParams: req.query,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
            responseTime: Date.now() - req.startTime
          });
          
          auditLog.save().catch(console.error);
        }
      } catch (error) {
        console.error('Audit logging error:', error);
      }
      
      oldSend.call(this, data);
    };
    
    req.startTime = Date.now();
    next();
  };
};