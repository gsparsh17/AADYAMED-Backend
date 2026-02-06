const express = require('express');
const router = express.Router();
const patientController = require('../controllers/patient.controller');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect, authorize('patient'));

router.post('/profile', patientController.createProfile);
router.get('/profile', patientController.getProfile);
router.put('/profile', patientController.updateProfile);

// Medical History
router.get('/medical-history', patientController.getMedicalHistory);
router.post('/medical-history', patientController.addMedicalRecord);

// Appointments
router.get('/appointments', patientController.getAppointments);

// Prescriptions
router.get('/prescriptions', patientController.getPrescriptions);

// Lab Reports
router.get('/lab-reports', patientController.getLabReports);

// Invoices
router.get('/invoices', patientController.getInvoices);

// Dashboard
router.get('/dashboard', patientController.getDashboardStats);

module.exports = router;