const express = require('express');
const router = express.Router();
const prescriptionController = require('../controllers/prescription.controller');
const { protect } = require('../middlewares/auth');

router.use(protect);

router.post('/', prescriptionController.createPrescription);
router.get('/', prescriptionController.getPrescriptions);
router.get('/:id', prescriptionController.getPrescriptionById);
router.put('/:id', prescriptionController.updatePrescription);

module.exports = router;