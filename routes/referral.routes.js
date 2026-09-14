const express = require('express');
const router = express.Router();
const referralController = require('../controllers/referral.controller');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect);

router.post('/', authorize('patient'), referralController.createReferral);
router.get('/', authorize('patient'), referralController.getReferrals);

// Must come before the generic '/:id' route below, or '/doctor/me' would be
// matched as if "doctor" were an :id.
router.get('/doctor/me', authorize('doctor'), referralController.getReferralsForProfessional);
router.get('/physio/me', authorize('physio'), referralController.getReferralsForProfessional);
router.put('/:id/accept', authorize('doctor', 'physio'), referralController.acceptReferralSuggestion);
router.put('/:id/decline', authorize('doctor', 'physio'), referralController.declineReferralSuggestion);

router.get('/:id', referralController.getReferralById);
router.post('/:id/select', authorize('patient'), referralController.selectProfessional);

module.exports = router;