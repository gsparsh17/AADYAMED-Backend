const crypto = require('crypto');
const OtpRequest = require('../models/OtpRequest');

/**
 * Phone OTP via 2Factor.
 *
 * 2Factor both generates and verifies the code, so nothing secret is stored
 * here — only the session id it returns. The rules this file adds on top are
 * the ones 2Factor does not enforce for us: how often a number may request a
 * code, how many guesses a challenge allows, and how long it stays valid.
 */
const BASE_URL = 'https://2factor.in/API/V1';
const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_PER_HOUR = 5;

const apiKey = () => process.env.TWO_FACTOR_API_KEY?.trim();
const isConfigured = () => Boolean(apiKey());

/** Indian mobile numbers, with or without +91 / 0 prefixes. */
function normalisePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  if (!/^[6-9]\d{9}$/.test(local)) return null;
  return local;
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

/**
 * Issues a code, subject to a per-number cooldown and hourly cap.
 *
 * Both limits are deliberately on the *phone number* rather than the IP: the
 * cost being defended against is SMS spend and harassment of a real person,
 * neither of which an attacker's IP changes.
 */
async function sendOtp({ phone, purpose, ip }) {
  if (!isConfigured()) throw httpError('OTP service is not configured on the server', 503);

  const normalised = normalisePhone(phone);
  if (!normalised) throw httpError('Enter a valid 10-digit Indian mobile number');

  const now = Date.now();
  const recent = await OtpRequest.findOne({ phone: normalised }).sort({ createdAt: -1 }).lean();
  if (recent && now - new Date(recent.createdAt).getTime() < RESEND_COOLDOWN_SECONDS * 1000) {
    const wait = Math.ceil((RESEND_COOLDOWN_SECONDS * 1000 - (now - new Date(recent.createdAt).getTime())) / 1000);
    throw httpError(`Please wait ${wait} seconds before requesting another code`, 429);
  }

  const hourAgo = new Date(now - 60 * 60 * 1000);
  const sentThisHour = await OtpRequest.countDocuments({ phone: normalised, createdAt: { $gte: hourAgo } });
  if (sentThisHour >= MAX_PER_HOUR) {
    throw httpError('Too many codes requested for this number. Try again later.', 429);
  }

  const response = await fetch(`${BASE_URL}/${apiKey()}/SMS/${normalised}/AUTOGEN/OTP1`);
  const result = await response.json().catch(() => ({}));
  if (result.Status !== 'Success' || !result.Details) {
    throw httpError(result.Details || 'Could not send the verification code', 502);
  }

  await OtpRequest.create({
    phone: normalised,
    sessionId: result.Details,
    purpose,
    expiresAt: new Date(now + OTP_TTL_MINUTES * 60 * 1000),
    ip,
  });

  return { phone: normalised, expiresInSeconds: OTP_TTL_MINUTES * 60, resendAfterSeconds: RESEND_COOLDOWN_SECONDS };
}

/**
 * Checks a code against the newest unverified challenge for that number.
 *
 * On success the challenge is marked verified and given a single-use token.
 * Signup uses that token to prove the phone was checked, so the caller never
 * has to hold an OTP across two requests.
 */
async function verifyOtp({ phone, code, purpose }) {
  if (!isConfigured()) throw httpError('OTP service is not configured on the server', 503);

  const normalised = normalisePhone(phone);
  if (!normalised) throw httpError('Enter a valid 10-digit Indian mobile number');
  if (!/^\d{4,8}$/.test(String(code || '').trim())) throw httpError('Enter the code from the SMS');

  const challenge = await OtpRequest.findOne({
    phone: normalised,
    purpose,
    verified: false,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });

  if (!challenge) throw httpError('This code has expired. Request a new one.', 410);
  if (challenge.attempts >= MAX_ATTEMPTS) {
    throw httpError('Too many incorrect attempts. Request a new code.', 429);
  }

  // Counted before the check, so a crash or a race cannot hand an attacker a
  // free guess.
  challenge.attempts += 1;
  await challenge.save();

  const response = await fetch(`${BASE_URL}/${apiKey()}/SMS/VERIFY/${challenge.sessionId}/${encodeURIComponent(String(code).trim())}`);
  const result = await response.json().catch(() => ({}));
  if (result.Status !== 'Success') {
    const left = Math.max(0, MAX_ATTEMPTS - challenge.attempts);
    throw httpError(left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Incorrect code. Request a new one.', 401);
  }

  challenge.verified = true;
  challenge.verifiedAt = new Date();
  challenge.verificationToken = crypto.randomBytes(24).toString('hex');
  await challenge.save();

  return { phone: normalised, verificationToken: challenge.verificationToken };
}

/**
 * Redeems a verification token exactly once.
 *
 * Clearing the token on use is what stops one verified phone from being used
 * to create an unlimited number of accounts.
 */
async function consumeVerification({ phone, verificationToken, purpose }) {
  const normalised = normalisePhone(phone);
  if (!normalised || !verificationToken) return false;

  const challenge = await OtpRequest.findOneAndUpdate(
    {
      phone: normalised,
      purpose,
      verificationToken,
      verified: true,
      expiresAt: { $gt: new Date() },
    },
    { $unset: { verificationToken: '' } },
  );
  return Boolean(challenge);
}

module.exports = { sendOtp, verifyOtp, consumeVerification, normalisePhone, isConfigured };
