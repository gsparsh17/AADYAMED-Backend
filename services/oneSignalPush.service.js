/**
 * OneSignal push delivery.
 *
 * Targets users by **external id** — the Mongo user `_id`, which the app sets
 * via `OneSignal.login()`. That means the backend never stores or syncs a
 * OneSignal player/subscription id: one user can sign in on several devices
 * and all of them resolve from the same external id, and a device that is
 * reinstalled re-registers itself without the server knowing.
 *
 * Node 20 has global fetch, so this needs no HTTP dependency.
 */
const ONE_SIGNAL_API = 'https://api.onesignal.com/notifications';

function credentials() {
  const appId = process.env.ONE_SIGNAL_APP_ID?.trim();
  const apiKey = process.env.ONE_SIGNAL_REST_API_KEY?.trim();
  if (!appId || !apiKey) return null;
  return { appId, apiKey };
}

const isConfigured = () => Boolean(credentials());

/**
 * OneSignal only accepts string values in `data`, and silently drops anything
 * else — which would quietly break deep linking, since that is exactly where
 * the order id travels.
 */
function stringifyData(data = {}) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  );
}

/**
 * Sends one notification to one or more users.
 *
 * Returns a result rather than throwing: a failed push must never take down
 * the order, payment or notification write that triggered it.
 */
async function sendToExternalIds(
  userIds,
  { title, body, data = {}, priority, androidChannel, ttlSeconds } = {},
) {
  const creds = credentials();
  if (!creds) return { attempted: 0, skipped: 'onesignal_not_configured' };

  const ids = (Array.isArray(userIds) ? userIds : [userIds])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  if (ids.length === 0) return { attempted: 0, skipped: 'no_recipients' };

  const payload = {
    app_id: creds.appId,
    target_channel: 'push',
    include_aliases: { external_id: ids },
    headings: { en: title },
    contents: { en: body },
    data: stringifyData(data),
    // Android needs an explicit high priority for the notification to arrive
    // promptly while the device is dozing — which is the whole point of a
    // new-order alert.
    priority: priority === 'high' || priority === 'urgent' ? 10 : 5,
    // A channel the app itself creates (see the professional app's push
    // service). This was `android_channel_name`, which is not a OneSignal
    // field and was ignored — so order alerts played as ordinary
    // notifications instead of on the loud "New orders" channel.
    existing_android_channel_id: androidChannel || 'aadya_pro_high_importance',
    ...(priority === 'high' || priority === 'urgent'
      ? { ios_interruption_level: 'time_sensitive', ios_sound: 'default' }
      : {}),
    ...(ttlSeconds ? { ttl: ttlSeconds } : {}),
  };

  try {
    const response = await fetch(ONE_SIGNAL_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Key ${creds.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('OneSignal push failed:', response.status, JSON.stringify(result.errors || result));
      return { attempted: ids.length, successCount: 0, error: result.errors || result };
    }

    // A 200 with zero recipients means nobody matched the external ids — the
    // user has never opened the app, or never granted permission. That is a
    // different problem from a rejected request and worth saying so.
    const recipients = Number(result.recipients || 0);
    if (recipients === 0) {
      console.warn('OneSignal accepted the push but matched 0 devices for:', ids.join(', '));
    }
    return { attempted: ids.length, successCount: recipients, id: result.id };
  } catch (error) {
    console.error('OneSignal push failed:', error.message);
    return { attempted: ids.length, successCount: 0, error: error.message };
  }
}

module.exports = { sendToExternalIds, isConfigured };
