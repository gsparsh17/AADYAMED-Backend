const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { protect } = require('../middlewares/auth');

// ========== PUBLIC ROUTES ==========

// Registration & Verification
router.post('/register', authController.register);
router.get('/verify-email/:token', authController.verifyEmail);
router.post('/resend-verification', authController.resendVerification);

// Login
router.post('/login', authController.login);

// Phone + OTP. One challenge flow serves both signing in and signing up: the
// send call reports which of the two the number is in, so the app can route
// straight to registration for a new number.
router.post('/otp/send', authController.sendLoginOtp);
router.post('/otp/verify', authController.verifyLoginOtp);

// Password Management
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password/:token', authController.resetPassword);

// ========== PROTECTED ROUTES ==========
router.use(protect);

// User Profile Management
router.get('/me', authController.getCurrentUser);
router.get('/profile-status', authController.getProfileStatus);
router.post('/complete-profile', authController.completeProfile);
router.put('/profile', authController.updateProfile);

// Password Management (authenticated)
router.put('/change-password', authController.changePassword);
router.put('/preferences', authController.updatePreferences);

// Session Management
router.post('/logout', authController.logout);

module.exports = router;