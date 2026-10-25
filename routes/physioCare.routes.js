const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const controller = require('../controllers/physioCare.controller');
const { protect, authorize } = require('../middlewares/auth');

// Reject malformed ids with 400 instead of a Mongoose CastError (500).
['id', 'patientId', 'physioId', 'appointmentId'].forEach(name => {
  router.param(name, (req, res, next, value) => {
    if (!mongoose.Types.ObjectId.isValid(String(value || ''))) {
      return res.status(400).json({ success: false, error: `Invalid ${name}` });
    }
    return next();
  });
});

const physio = [protect, authorize('physio')];
const patient = [protect, authorize('patient')];

// Public: active treatment packages offered by a physiotherapist.
router.get('/physios/:physioId/packages', controller.listPublicPackages);

// Physiotherapist packages.
router.get('/me/packages', physio, controller.listMyPackages);
router.post('/me/packages', physio, controller.createPackage);
router.patch('/me/packages/:id', physio, controller.updatePackage);
router.delete('/me/packages/:id', physio, controller.archivePackage);

// Physiotherapist treatment courses.
router.get('/me/courses', physio, controller.listMyCourses);
router.post('/me/patients/:patientId/courses', physio, controller.createCourse);
router.get('/me/courses/:id', physio, controller.getCourse);
router.patch('/me/courses/:id', physio, controller.updateCourse);
router.post('/me/courses/:id/appointments/:appointmentId', physio, controller.linkAppointment);

// Physiotherapist assessments and progress trends.
router.get('/me/patients/:patientId/assessments', physio, controller.listPatientAssessments);
router.post('/me/patients/:patientId/assessments', physio, controller.createAssessment);
router.get('/me/patients/:patientId/progress', physio, controller.getPatientProgress);
router.get('/me/assessments/:id', physio, controller.getAssessment);
router.patch('/me/assessments/:id', physio, controller.updateAssessment);

// Patient read-only views.
router.get('/my-courses', patient, controller.listMyCoursesAsPatient);
router.get('/my-assessments', patient, controller.listMyAssessments);

module.exports = router;
