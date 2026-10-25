const express = require('express');
const router = express.Router();
const controller = require('../controllers/physioExercise.controller');
const mongoose = require('mongoose');
const { protect, authorize } = require('../middlewares/auth');

// Reject malformed ids with 400 instead of letting Mongoose throw a CastError (500).
['id', 'patientId'].forEach(name => {
  router.param(name, (req, res, next, value) => {
    if (!mongoose.Types.ObjectId.isValid(String(value || ''))) {
      return res.status(400).json({ success: false, error: `Invalid ${name}` });
    }
    return next();
  });
});

router.use(protect);

// Physiotherapist-owned exercise catalogue.
router.get('/catalog', authorize('physio'), controller.listExercises);
router.post('/catalog', authorize('physio'), controller.createExercise);
router.patch('/catalog/:id', authorize('physio'), controller.updateExercise);
router.delete('/catalog/:id', authorize('physio'), controller.archiveExercise);

// Physiotherapist -> patient plan management.
router.get('/patients/:patientId/plans', authorize('physio'), controller.listPatientPlans);
router.post('/patients/:patientId/plans', authorize('physio'), controller.createPatientPlan);
router.get('/plans/:id', authorize('physio'), controller.getPlan);
router.patch('/plans/:id', authorize('physio'), controller.updatePlan);
router.delete('/plans/:id', authorize('physio'), controller.cancelPlan);
router.get('/plans/:id/progress', authorize('physio'), controller.getPlanProgress);
router.post('/plans/:id/progress', authorize('physio'), controller.logPhysioProgress);
// Adherence is readable by the owning physio and the owning patient.
router.get('/plans/:id/adherence', authorize('physio', 'patient'), controller.getPlanAdherence);

// Patient-facing assigned plans and adherence logging.
router.get('/my-plans', authorize('patient'), controller.listMyPlans);
router.get('/my-plans/:id', authorize('patient'), controller.getMyPlan);
router.get('/my-plans/:id/progress', authorize('patient'), controller.getMyPlanProgress);
router.post('/my-plans/:id/progress', authorize('patient'), controller.logMyProgress);
router.get('/my-plans/:id/adherence', authorize('patient'), controller.getPlanAdherence);

module.exports = router;
