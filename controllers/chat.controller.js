const ChatSession = require('../models/ChatSession');
const ChatMessage = require('../models/ChatMessage');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const PathologyProfile = require('../models/PathologyProfile');
const PharmacyProfile = require('../models/PharmacyProfile');
const {
  canUserAccessSession,
  hasVerifiedRelationship,
  deriveParticipants,
} = require('../services/chatAuthorization.service');

exports.getOrCreateSession = async (req, res) => {
  try {
    const participants = deriveParticipants(req.user, req.body);
    if (participants.error) {
      return res.status(participants.status).json({ success: false, error: participants.error });
    }

    const relationshipOk = await hasVerifiedRelationship(participants);
    if (!relationshipOk) {
      return res.status(403).json({
        success: false,
        error: 'A verified appointment, diagnostic order, or pharmacy order relationship is required for chat',
      });
    }

    const query = {
      patientId: participants.patientId,
      professionalId: participants.professionalId,
      professionalType: participants.professionalType,
    };
    if (participants.appointmentId) query.appointmentId = participants.appointmentId;

    let session = await ChatSession.findOne(query).populate('lastMessage');
    if (!session) session = await ChatSession.create(query);

    res.json({ success: true, session });
  } catch (error) {
    console.error('Error in getOrCreateSession:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};

exports.getProfessionalSessions = async (req, res) => {
  try {
    if (!['doctor', 'physio', 'pathology', 'pharmacy'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Professional role required' });
    }
    const professionalId = req.user.profileId;
    if (!professionalId) return res.status(403).json({ success: false, error: 'Profile ID not found in user context' });

    const sessions = await ChatSession.find({ professionalId, professionalType: req.user.role })
      .populate('patientId', 'name profileImage phone')
      .populate('lastMessage')
      .sort({ updatedAt: -1 });

    res.json({ success: true, sessions });
  } catch (error) {
    console.error('Error fetching professional sessions:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};

exports.getPatientSessions = async (req, res) => {
  try {
    if (req.user.role !== 'patient') {
      return res.status(403).json({ success: false, error: 'Patient role required' });
    }
    const patientId = req.user.profileId;
    if (!patientId) return res.status(403).json({ success: false, error: 'Profile ID not found' });

    const sessions = await ChatSession.find({ patientId })
      .populate('lastMessage')
      .sort({ updatedAt: -1 });

    const populatedSessions = await Promise.all(sessions.map(async (session) => {
      const doc = session.toObject();
      if (doc.professionalType === 'doctor') {
        doc.professional = await DoctorProfile.findById(doc.professionalId).select('name profileImage specialization');
      } else if (doc.professionalType === 'physio') {
        doc.professional = await PhysiotherapistProfile.findById(doc.professionalId).select('name profileImage specialization');
      } else if (doc.professionalType === 'pathology') {
        doc.professional = await PathologyProfile.findById(doc.professionalId).select('name profileImage');
      } else if (doc.professionalType === 'pharmacy') {
        doc.professional = await PharmacyProfile.findById(doc.professionalId).select('pharmacyName profileImage');
      }
      return doc;
    }));

    res.json({ success: true, sessions: populatedSessions });
  } catch (error) {
    console.error('Error fetching patient sessions:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};

exports.getChatHistory = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);

    const session = await ChatSession.findById(sessionId).lean();
    if (!session) return res.status(404).json({ success: false, error: 'Chat session not found' });
    if (!canUserAccessSession(req.user, session)) {
      return res.status(403).json({ success: false, error: 'Not authorized for this chat session' });
    }

    const messages = await ChatMessage.find({ sessionId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    await ChatMessage.updateMany(
      { sessionId, isRead: false, senderId: { $ne: req.user.profileId } },
      { $set: { isRead: true } },
    );

    res.json({ success: true, messages: messages.reverse() });
  } catch (error) {
    console.error('Error fetching chat history:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};
