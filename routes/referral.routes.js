const express = require('express');
const router = express.Router();
const referralController = require('../controllers/referral.controller');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect);

router.post('/', authorize('patient'), referralController.createReferral);
router.get('/', authorize('patient'), referralController.getReferrals);
router.get('/:id', referralController.getReferralById);
router.post('/:id/select', authorize('patient'), referralController.selectProfessional);

module.exports = router;