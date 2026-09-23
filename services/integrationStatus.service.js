/**
 * Reports which optional integrations are actually configured.
 *
 * These all fail *quietly* by design — a missing Firebase key does not stop
 * the server, it just means `sendPushToUser` returns `skipped` and no phone
 * ever rings. That is the right runtime behaviour and the wrong operational
 * behaviour: the warning only appeared on the first push attempt, buried in
 * request logs, so an install could run for weeks silently sending nothing.
 *
 * Printing the state once at boot makes each gap a decision rather than a
 * discovery.
 */
const CHECKS = [
  {
    name: 'Push notifications (OneSignal)',
    ready: () => Boolean(process.env.ONE_SIGNAL_APP_ID?.trim() && process.env.ONE_SIGNAL_REST_API_KEY?.trim()),
    impact: 'Falls back to FCM if that is configured; otherwise no device receives '
      + 'a new-order alert. In-app notifications still appear.',
    fix: 'Set ONE_SIGNAL_APP_ID and ONE_SIGNAL_REST_API_KEY.',
  },
  {
    name: 'Push fallback (FCM)',
    ready: () => Boolean(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()
      || process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
    ),
    impact: 'Only matters if OneSignal is unconfigured — then nothing is delivered.',
    fix: 'Set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.',
  },
  {
    name: 'Razorpay payments',
    ready: () => Boolean(process.env.RAZORPAY_KEY_ID?.trim() && process.env.RAZORPAY_KEY_SECRET?.trim()),
    impact: 'Online payment, counter QR collection and refunds are all unavailable.',
    fix: 'Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.',
  },
  {
    name: 'Razorpay webhook',
    ready: () => Boolean(process.env.RAZORPAY_WEBHOOK_SECRET?.trim()),
    impact: 'Payments only confirm when the payer\'s app reports back. A customer who '
      + 'closes the app mid-payment may leave an order stuck unpaid. Counter QR still '
      + 'settles by polling.',
    fix: 'Set RAZORPAY_WEBHOOK_SECRET and point a webhook at /api/payments/webhook '
      + '(events: payment.captured, payment.failed, refund.processed, qr_code.credited).',
  },
  {
    name: 'Phone OTP (2Factor)',
    ready: () => Boolean(process.env.TWO_FACTOR_API_KEY?.trim()),
    impact: 'Login and signup by mobile number are unavailable; password login still works.',
    fix: 'Set TWO_FACTOR_API_KEY.',
  },
  {
    name: 'Email (nodemailer)',
    ready: () => Boolean(process.env.EMAIL_USER?.trim() && process.env.EMAIL_PASS?.trim()),
    impact: 'Email notifications are not sent.',
    fix: 'Set EMAIL_USER and EMAIL_PASS.',
  },
  {
    name: 'Cloudinary uploads',
    ready: () => Boolean(process.env.CLOUDINARY_CLOUD_NAME?.trim() && process.env.CLOUDINARY_API_SECRET?.trim()),
    impact: 'Image uploads that route through Cloudinary will fail.',
    fix: 'Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.',
  },
];

function integrationStatus() {
  return CHECKS.map(({ name, ready, impact, fix }) => ({
    name,
    ready: Boolean(ready()),
    impact,
    fix,
  }));
}

function logIntegrationStatus() {
  const rows = integrationStatus();
  const missing = rows.filter((r) => !r.ready);

  console.log('\n── Integrations ' + '─'.repeat(48));
  for (const row of rows) {
    console.log(`  ${row.ready ? '✅' : '⚠️ '} ${row.name}`);
  }

  if (missing.length === 0) {
    console.log('  Everything configured.\n');
    return;
  }

  console.log('');
  for (const row of missing) {
    console.log(`  ⚠️  ${row.name} is NOT configured`);
    console.log(`      Effect : ${row.impact}`);
    console.log(`      Fix    : ${row.fix}`);
  }
  console.log('');
}

module.exports = { integrationStatus, logIntegrationStatus };
