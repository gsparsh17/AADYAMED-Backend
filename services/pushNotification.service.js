const admin = require('firebase-admin');
const DeviceRegistration = require('../models/DeviceRegistration');
const oneSignal = require('./oneSignalPush.service');

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
  // OneSignal is the provider when it is configured. FCM is kept as the
  // fallback rather than deleted: the two use different device registries, so
  // an install mid-migration — or one where OneSignal is not set up — keeps
  // delivering instead of going silent.
  if (oneSignal.isConfigured()) {
    const result = await oneSignal.sendToExternalIds(userId, {
      title: payload.title,
      body: payload.body,
      data: payload.data,
      priority: payload.priority,
    });
    return {
      attempted: result.attempted || 0,
      successCount: result.successCount || 0,
      failureCount: (result.attempted || 0) - (result.successCount || 0),
      provider: 'onesignal',
      skipped: result.skipped,
    };
  }

  const registrations = await DeviceRegistration.find({ userId, active: true })
    .select('_id token')
    .lean();

  if (!registrations.length) {
    // Worth logging: a user with no device token receives nothing, and the
    // symptom (no alert) is identical to FCM being misconfigured.
    console.warn(`Push skipped for user ${userId}: no active device tokens registered`);
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
