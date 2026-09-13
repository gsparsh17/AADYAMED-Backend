const express = require('express');
const router = express.Router();
const controller = require('../controllers/prescription.controller');
const { protect } = require('../middlewares/auth');

router.use(protect);

router.post('/', controller.createPrescription);
router.get('/', controller.getPrescriptions);
router.get('/patient/:id', controller.getPrescriptionsByPatientId);
router.get('/appointment/:appointmentId', controller.getByAppointment);
router.get('/:id/pdf', controller.downloadPdf);
router.post('/:id/issue', controller.issuePrescription);
router.post('/:id/cancel', controller.cancelPrescription);
router.get('/:id', controller.getPrescriptionById);
router.patch('/:id', controller.updatePrescription);
router.put('/:id', controller.updatePrescription); // backward-compatible alias

module.exports = router;
