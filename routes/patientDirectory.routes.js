const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const patientDirectoryController = require('../controllers/patientDirectory.controller');

router.use(protect);
router.use(authorize('admin', 'pharmacy', 'doctor', 'physio', 'pathology'));
router.get('/search', patientDirectoryController.listPatients);
router.get('/', patientDirectoryController.listPatients);

module.exports = router;
