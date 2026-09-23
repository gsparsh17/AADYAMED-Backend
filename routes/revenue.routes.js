const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const {
  calculateHospitalRevenue,
  getDailyRevenueReport,
  getMonthlyRevenueReport
} = require('../controllers/revenue.controller');

// Revenue routes — platform-wide financial figures, admin only. This router
// was never mounted in app.js and had no auth at all; the admin web
// dashboard (Reports/Analytics/IncomePage) already calls these paths, so it
// was a live 404, not dead code.
router.use(protect, authorize('admin'));

router.get('/', calculateHospitalRevenue);
router.get('/daily', getDailyRevenueReport);
router.get('/monthly', getMonthlyRevenueReport);

module.exports = router;