const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chat.controller');
const { protect } = require('../middlewares/auth');

router.use(protect); // Require authentication for all chat routes

// Create or Get a chat session between a patient and professional
router.post('/session', chatController.getOrCreateSession);

// Get list of chat sessions for a professional
router.get('/professional/sessions', chatController.getProfessionalSessions);

// Get list of chat sessions for a patient
router.get('/patient/sessions', chatController.getPatientSessions);

// Get chat history for a specific session
router.get('/session/:sessionId/messages', chatController.getChatHistory);

module.exports = router;
