const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const controller = require('../controllers/labreport.controller');

// Was never mounted (a live 404) and had no auth at all — getAllLabReports
// would have returned every patient's lab reports platform-wide to anyone.
// The controller now scopes every query to the requesting doctor/patient.
router.use(protect);

router.post('/', controller.createLabReport);
router.get('/', controller.getAllLabReports);
router.get('/:id', controller.getReportById);
router.delete('/:id', controller.deleteReport);

module.exports = router;
