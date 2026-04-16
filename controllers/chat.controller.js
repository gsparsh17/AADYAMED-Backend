const ChatSession = require('../models/ChatSession');
const ChatMessage = require('../models/ChatMessage');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const PathologyProfile = require('../models/PathologyProfile');
const PharmacyProfile = require('../models/PharmacyProfile');
const PatientProfile = require('../models/PatientProfile');

// Create or Get Chat Session
exports.getOrCreateSession = async (req, res) => {
  try {
    const { patientId, professionalId, professionalType } = req.body;
    
    if (!patientId || !professionalId || !professionalType) {
      return res.status(400).json({ success: false, error: 'patientId, professionalId, and professionalType are required' });
    }

    let session = await ChatSession.findOne({
      patientId,
      professionalId,
      professionalType
    }).populate('lastMessage');

    if (!session) {
      session = await ChatSession.create({
        patientId,
        professionalId,
        professionalType
      });
    }

    res.json({ success: true, session });
  } catch (error) {
    console.error('Error in getOrCreateSession:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};

// Fetch Professional's Chat List
exports.getProfessionalSessions = async (req, res) => {
  try {
    const professionalId = req.user.profileId; // Requires authentication middleware to attach profileId
    if (!professionalId) return res.status(403).json({ success: false, error: 'Profile ID not found in user context' });

    const sessions = await ChatSession.find({ professionalId })
      .populate('patientId', 'name profileImage phone')
      .populate('lastMessage')
      .sort({ updatedAt: -1 });

    res.json({ success: true, sessions });
  } catch (error) {
    console.error('Error fetching professional sessions:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};

// Fetch Patient's Chat List
exports.getPatientSessions = async (req, res) => {
  try {
    const patientId = req.user.profileId;
    if (!patientId) return res.status(403).json({ success: false, error: 'Profile ID not found' });

    const sessions = await ChatSession.find({ patientId })
      .populate('lastMessage')
      .sort({ updatedAt: -1 });

    // Since professionalId can point to different models, we load them manually here
    const populatedSessions = await Promise.all(sessions.map(async (session) => {
      let doc = session.toObject();
      if (doc.professionalType === 'doctor') {
        doc.professional = await DoctorProfile.findById(doc.professionalId).select('name profileImage specialization');
      } else if (doc.professionalType === 'physio') {
        doc.professional = await PhysiotherapistProfile.findById(doc.professionalId).select('name profileImage specialization');
      } else if (doc.professionalType === 'pathology') {
        doc.professional = await PathologyProfile.findById(doc.professionalId).select('name profileImage');
      } else if (doc.professionalType === 'pharmacy') {
        doc.professional = await PharmacyProfile.findById(doc.professionalId).select('name profileImage');
      }
      return doc;
    }));

    res.json({ success: true, sessions: populatedSessions });
  } catch (error) {
    console.error('Error fetching patient sessions:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};

// Fetch Chat History
exports.getChatHistory = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const skip = parseInt(req.query.skip) || 0;

    const messages = await ChatMessage.find({ sessionId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // Mark messages as read based on who is querying (basic implementation)
    await ChatMessage.updateMany(
      { sessionId, isRead: false, senderId: { $ne: req.user.profileId } },
      { $set: { isRead: true } }
    );

    res.json({ success: true, messages: messages.reverse() });
  } catch (error) {
    console.error('Error fetching chat history:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};
