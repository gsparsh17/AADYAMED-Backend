const admin = require('firebase-admin');
const DeviceRegistration = require('../models/DeviceRegistration');

let firebaseInitAttempted = false;
let firebaseReady = false;

function initializeFirebase() {
  if (firebaseInitAttempted) return firebaseReady;
  firebaseInitAttempted = true;

  try {
    if (admin.apps.length > 0) {
      firebaseReady = true;
      return true;
    }

    const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
    if (inlineJson) {
      const serviceAccount = JSON.parse(inlineJson);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      firebaseReady = true;
      return true;
    }

    // GOOGLE_APPLICATION_CREDENTIALS is supported automatically by
    // applicationDefault() and is the preferred production configuration.
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
      firebaseReady = true;
      return true;
    }

    console.warn('FCM disabled: configure GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON');
    return false;
  } catch (error) {
    console.error('FCM initialization failed:', error.message);
    return false;
  }
}

function invalidTokenCode(code = '') {
  return [
    'messaging/invalid-registration-token',
    'messaging/registration-token-not-registered',
  ].includes(code);
}

async function sendPushToUser(userId, payload) {
  const registrations = await DeviceRegistration.find({ userId, active: true })
    .select('_id token')
    .lean();

  if (!registrations.length) {
    return { attempted: 0, successCount: 0, failureCount: 0, skipped: 'no_active_tokens' };
  }

  if (!initializeFirebase()) {
    return { attempted: registrations.length, successCount: 0, failureCount: 0, skipped: 'fcm_not_configured' };
  }

  const tokens = registrations.map((item) => item.token);
  const data = {};
  for (const [key, value] of Object.entries(payload.data || {})) {
    if (value !== undefined && value !== null) data[key] = String(value);
  }

  const message = {
    tokens,
    notification: {
      title: String(payload.title || 'AADYAMED'),
      body: String(payload.body || ''),
    },
    data,
    android: { priority: payload.priority === 'urgent' ? 'high' : 'normal' },
    apns: {
      headers: { 'apns-priority': payload.priority === 'urgent' ? '10' : '5' },
      payload: { aps: { sound: 'default' } },
    },
  };

  const messaging = admin.messaging();
  const result = typeof messaging.sendEachForMulticast === 'function'
    ? await messaging.sendEachForMulticast(message)
    : await messaging.sendMulticast(message);

  const invalidIds = [];
  result.responses.forEach((response, index) => {
    if (!response.success && invalidTokenCode(response.error?.code)) {
      invalidIds.push(registrations[index]._id);
    }
  });

  if (invalidIds.length) {
    await DeviceRegistration.updateMany(
      { _id: { $in: invalidIds } },
      { $set: { active: false, lastSeenAt: new Date() } },
    );
  }

  return {
    attempted: registrations.length,
    successCount: result.successCount,
    failureCount: result.failureCount,
    invalidated: invalidIds.length,
  };
}

module.exports = { sendPushToUser };
