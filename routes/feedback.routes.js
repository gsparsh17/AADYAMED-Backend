const express = require('express');
const router = express.Router();
const feedbackController = require('../controllers/feedback.controller');
const { protect } = require('../middlewares/auth');

router.use(protect);

router.post('/', feedbackController.submitFeedback);
router.get('/', feedbackController.getFeedback);
router.get('/my', feedbackController.getMyFeedback);
router.put('/:id/status', feedbackController.updateFeedbackStatus);
router.put('/:id/response', feedbackController.addProfessionalResponse);

module.exports = router;