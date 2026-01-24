const express = require('express');
const router = express.Router();
const commissionController = require('../controllers/commission.controller');
const { protect } = require('../middlewares/auth');

router.use(protect);

router.get('/', commissionController.getCommissions);
router.get('/report', commissionController.getCommissionReport);
router.post('/payout', authorize('admin'), commissionController.processPayout);

module.exports = router;