const express = require('express');
const router = express.Router();
const controller = require('../controllers/mr.controller');
const { protect, authorize } = require('../middlewares/auth');
const receiptUpload = require('../middlewares/mrReceiptUpload');

router.use(protect);

// Initial field-force provisioning is admin-controlled. Managers can then create
// only the next designation in their own reporting chain.
router.post('/admin/users', authorize('admin'), controller.adminCreateUser);

router.use(authorize('mr', 'admin'));

router.get('/me', controller.getMe);
router.get('/dashboard', controller.getDashboard);
router.get('/analytics', controller.getAnalytics);
router.get('/hierarchy', controller.getHierarchy);
router.get('/team', controller.getTeam);
router.post('/team/users', authorize('mr'), controller.managerCreateUser);
router.patch('/team/:id', controller.updateTeamMember);

router.get('/territories', controller.listTerritories);
router.post('/territories', controller.createTerritory);
router.patch('/territories/:id', controller.updateTerritory);

router.get('/accounts', controller.listAccounts);
router.post('/accounts', controller.createAccount);
router.patch('/accounts/:id', controller.updateAccount);
router.get('/directory', controller.searchDirectory);

router.get('/visits', controller.listVisits);
router.get('/dcr', controller.listVisits);
router.post('/visits', controller.createVisit);
router.post('/visits/:id/check-in', controller.checkInVisit);
router.post('/visits/:id/check-out', controller.checkOutVisit);
router.post('/visits/:id/submit', controller.submitVisit);
router.post('/visits/:id/review', controller.approveVisit);

router.get('/attendance', controller.getAttendance);
router.post('/attendance/punch-in', controller.punchIn);
router.post('/attendance/punch-out', controller.punchOut);

router.get('/leaves', controller.listLeaves);
router.post('/leaves', controller.applyLeave);
router.post('/leaves/:id/review', controller.reviewLeave);
router.post('/leaves/:id/cancel', controller.cancelLeave);

router.get('/tour-plans', controller.listTourPlans);
router.put('/tour-plans', controller.saveTourPlan);
router.post('/tour-plans/:id/submit', controller.submitTourPlan);
router.post('/tour-plans/:id/review', controller.approveTourPlan);

router.get('/expenses', controller.listExpenses);
router.post('/expenses', controller.createExpense);
router.post('/expenses/:id/submit', controller.submitExpense);
router.post('/expenses/:id/review', controller.approveExpense);
router.post('/expenses/:id/pay', controller.payExpense);
router.post('/expenses/:id/receipt', receiptUpload.single('receipt'), controller.uploadExpenseReceipt);
router.get('/expenses/:id/receipt', controller.downloadExpenseReceipt);

router.get('/targets', controller.getTargets);
router.put('/targets', controller.setTarget);

router.get('/pob', controller.listPOB);
router.post('/pob', controller.createPOB);
router.patch('/pob/:id/status', controller.updatePOBStatus);

router.get('/samples', controller.listSamples);
router.post('/samples', controller.createSampleTransaction);

router.get('/detailing', controller.listDetailing);
router.post('/detailing', controller.createDetailing);
router.patch('/detailing/:id', controller.updateDetailing);

router.use(controller.errorHandler);
module.exports = router;
