const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { protect, authorize } = require('../middlewares/auth');
const { auditLogger } = require('../middlewares/auditLogger');

router.use(protect, authorize('admin'));

// ========== DASHBOARD ==========
router.get('/dashboard', adminController.getDashboardStats);
router.get('/recent-activities', adminController.getRecentActivities);
router.get('/analytics/chart', adminController.getChartData);

// ========== USERS MANAGEMENT ==========
router.get('/users', adminController.getUsers);
router.get('/users/:id', adminController.getUserById);
router.put('/users/:id/toggle-active', auditLogger('ADMIN_TOGGLE_USER_ACTIVE', 'user'), adminController.toggleUserActive);
router.put('/users/:id/force-verify', auditLogger('ADMIN_FORCE_VERIFY_USER', 'user'), adminController.forceVerifyUser);

// ========== PROFESSIONALS MANAGEMENT ==========
router.get('/professionals', adminController.getProfessionals);
router.get('/professionals/:type/:id', adminController.getProfessionalById);
router.post('/professionals/:type/:id/verify', auditLogger('ADMIN_VERIFY_PROFESSIONAL', 'professional'), adminController.verifyProfessional);
router.put('/professionals/:type/:id/notes', auditLogger('ADMIN_UPDATE_PROFESSIONAL_NOTES', 'professional'), adminController.updateProfessionalNotes);

// ========== APPOINTMENTS MANAGEMENT ==========
router.get('/appointments', adminController.getAppointments);
router.get('/appointments/:id', adminController.getAppointmentById);
router.put('/appointments/:id/status', auditLogger('ADMIN_UPDATE_APPOINTMENT_STATUS', 'appointment'), adminController.updateAppointmentStatus);
router.put('/appointments/:id/payment', auditLogger('ADMIN_UPDATE_APPOINTMENT_PAYMENT', 'appointment'), adminController.updateAppointmentPayment);

// ========== PAYMENTS & COMMISSIONS ==========
router.get('/payments', adminController.getPayments);
router.get('/payments/commissions', adminController.getCommissionReport);
router.post('/payments/payout', auditLogger('ADMIN_PROCESS_PAYOUT', 'payment'), adminController.processPayout);
router.get('/payments/cycles', adminController.getCommissionCycles);
router.get('/payments/summary', adminController.getCommissionSummary);
router.post('/payments/payout/generate-report', auditLogger('ADMIN_GENERATE_PAYOUT_REPORT', 'payment'), adminController.generatePayoutReport);
router.post('/payments/payout/:payoutId/mark-paid', auditLogger('ADMIN_MARK_PAYOUT_PAID', 'payment'), adminController.markPayoutAsPaid);

// ========== COMMISSION SETTINGS ==========
router.get('/commission-settings', adminController.getCommissionSettings);
router.put('/commission-settings', auditLogger('ADMIN_UPDATE_COMMISSION_SETTINGS', 'commission_settings'), adminController.updateCommissionSettings);

// ========== VERIFICATIONS ==========
router.get('/verifications', adminController.getPendingVerifications);
router.get('/verifications/stats', adminController.getVerificationStats);

// ========== PATHOLOGY MANAGEMENT ==========
router.get('/pathology', adminController.getPathologyLabs);
router.get('/pathology/:id', adminController.getPathologyById);
router.put('/pathology/:id', auditLogger('ADMIN_UPDATE_PATHOLOGY', 'pathology'), adminController.updatePathologyLab);
router.delete('/pathology/:id', auditLogger('ADMIN_DELETE_PATHOLOGY', 'pathology'), adminController.deletePathologyLab);

// ========== PHARMACY MANAGEMENT ==========
router.get('/pharmacy', adminController.getPharmacies);
router.get('/pharmacy/:id', adminController.getPharmacyById);
router.put('/pharmacy/:id', auditLogger('ADMIN_UPDATE_PHARMACY', 'pharmacy'), adminController.updatePharmacy);
router.delete('/pharmacy/:id', auditLogger('ADMIN_DELETE_PHARMACY', 'pharmacy'), adminController.deletePharmacy);

// ========== REPORTS & ANALYTICS ==========
router.get('/reports', adminController.getReports);
router.post('/reports/generate', auditLogger('ADMIN_GENERATE_REPORT', 'report'), adminController.generateReport);
router.get('/reports/scheduled', adminController.getScheduledReports);
router.post('/reports/schedule', auditLogger('ADMIN_SCHEDULE_REPORT', 'report'), adminController.scheduleReport);
router.delete('/reports/schedule/:id', auditLogger('ADMIN_DELETE_SCHEDULED_REPORT', 'report'), adminController.deleteScheduledReport);
router.delete('/reports/:id', auditLogger('ADMIN_DELETE_REPORT', 'report'), adminController.deleteReport);

// ========== KPI ENDPOINTS ==========
router.get('/kpis/users', adminController.getUserKpis);
router.get('/kpis/funnel', adminController.getFunnelKpis);
router.get('/kpis/appointments', adminController.getAppointmentKpis);
router.get('/kpis/labtests', adminController.getLabTestKpis);
router.get('/kpis/pharmacy', adminController.getPharmacyKpis);
router.get('/kpis/revenue', adminController.getRevenueKpis);
router.get('/kpis/top-medicines', adminController.getTopMedicinesKpi);

// ========== ANALYTICS ENDPOINTS ==========
router.get('/analytics/devices', adminController.getDeviceAnalytics);
router.get('/analytics/geographic', adminController.getGeographicAnalytics);
router.get('/analytics/traffic', adminController.getTrafficAnalytics);
router.get('/analytics/performance', adminController.getPerformanceAnalytics);

// ========== INVENTORY ALERTS ==========
// router.get('/inventory/alerts', adminController.getInventoryAlerts);

// ========== AUDIT LOGS ==========
router.delete('/audit-logs/clear', auditLogger('ADMIN_CLEAR_AUDIT_LOGS', 'audit'), adminController.clearAuditLogs);

// ========== SYSTEM & AUDIT ==========
router.get('/audit-logs', adminController.getAuditLogs);
router.get('/system-metrics', adminController.getSystemMetrics);
router.get('/export/report', adminController.exportReport);

module.exports = router;