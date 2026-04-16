const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ChatSession',
      required: true,
      index: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    senderType: {
      type: String,
      enum: ['patient', 'doctor', 'physio', 'pathology', 'pharmacy', 'system'],
      required: true,
    },
    messageType: {
      type: String,
      enum: ['text', 'image', 'document'],
      default: 'text',
    },
    content: {
      type: String,
      required: true,
    },
    fileUrl: {
      type: String, // Valid if messageType is image/document
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
