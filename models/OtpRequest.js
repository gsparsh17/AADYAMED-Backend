const mongoose = require('mongoose');

/**
 * One OTP challenge issued to a phone number.
 *
 * The OTP itself is never stored — 2Factor generates and verifies it, and we
 * only keep the session id it hands back. That means a database dump cannot
 * be used to log in as anybody, and there is no hashing scheme of ours to get
 * wrong.
 */
const otpRequestSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true, trim: true },

  // 2Factor's session id for this challenge.
  sessionId: { type: String, required: true },

  purpose: {
    type: String,
    enum: ['login', 'signup'],
    required: true,
  },

  // Rate limiting and brute-force defence live on the row, not in memory, so
  // they survive a restart and work across multiple server processes.
  attempts: { type: Number, default: 0 },
  verified: { type: Boolean, default: false },
  verifiedAt: Date,

  // Set once verified, and cleared when redeemed: this is what lets the
  // signup call prove the phone was checked without re-sending an OTP.
  verificationToken: { type: String, index: true, sparse: true },

  expiresAt: { type: Date, required: true },
  ip: String,
}, { timestamps: true });

// Challenges clean themselves up rather than accumulating forever. The TTL is
// on a field that is already indexed for lookups, so this costs nothing extra.
otpRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpRequestSchema.index({ phone: 1, createdAt: -1 });

module.exports = mongoose.model('OtpRequest', otpRequestSchema);
