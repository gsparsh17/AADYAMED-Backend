// Video rooms for consultations, joined with a signed token so nobody is
// asked to sign in. The public meet.jit.si server makes the first person in a
// room log in with Google/GitHub before a meeting starts, which fails inside
// the apps; a token from one of the hosts below skips that.
//
//   Jitsi as a Service (8x8.vc)   JAAS_APP_ID, JAAS_API_KEY_ID and
//                                 JAAS_PRIVATE_KEY (PEM text, "\n" escapes
//                                 allowed) or JAAS_PRIVATE_KEY_PATH
//   Self-hosted Jitsi (JWT auth)  JITSI_BASE_URL, JITSI_APP_ID, JITSI_APP_SECRET
//
// With neither set, rooms fall back to JITSI_BASE_URL without a token.
const fs = require('fs');
const jwt = require('jsonwebtoken');

const JITSI_BASE_URL = String(process.env.JITSI_BASE_URL || 'https://meet.jit.si').replace(/\/+$/, '');
const TOKEN_TTL_SECONDS = 4 * 60 * 60;

let cachedKey;
function jaasPrivateKey() {
  if (cachedKey !== undefined) return cachedKey;
  if (process.env.JAAS_PRIVATE_KEY) {
    cachedKey = process.env.JAAS_PRIVATE_KEY.replace(/\n/g, '\n');
  } else if (process.env.JAAS_PRIVATE_KEY_PATH) {
    cachedKey = fs.readFileSync(process.env.JAAS_PRIVATE_KEY_PATH, 'utf8');
  } else {
    cachedKey = null;
  }
  return cachedKey;
}

function provider() {
  const appId = process.env.JAAS_APP_ID;
  if (appId && process.env.JAAS_API_KEY_ID && jaasPrivateKey()) {
    const keyId = String(process.env.JAAS_API_KEY_ID);
    return {
      mode: 'jaas',
      serverUrl: 'https://8x8.vc',
      appId,
      // The console shows the key id either alone or as "<appId>/<key>".
      kid: keyId.includes('/') ? keyId : `${appId}/${keyId}`
    };
  }
  if (process.env.JITSI_APP_ID && process.env.JITSI_APP_SECRET) {
    return {
      mode: 'self_hosted',
      serverUrl: JITSI_BASE_URL,
      appId: process.env.JITSI_APP_ID,
      secret: process.env.JITSI_APP_SECRET
    };
  }
  return { mode: 'public', serverUrl: JITSI_BASE_URL };
}

function userClaim(participant) {
  return {
    id: String(participant.id),
    name: participant.name,
    email: participant.email || undefined,
    avatar: participant.avatar || undefined,
    moderator: participant.moderator ? 'true' : 'false'
  };
}

// What an app needs to put one participant in [roomId]: the server, the
// room name as that server expects it, and the token (null when public).
function joinDetails(roomId, participant) {
  const p = provider();
  const now = Math.floor(Date.now() / 1000);
  let room = roomId;
  let token = null;

  if (p.mode === 'jaas') {
    room = `${p.appId}/${roomId}`;
    token = jwt.sign({
      aud: 'jitsi',
      iss: 'chat',
      sub: p.appId,
      room: roomId,
      nbf: now - 60,
      exp: now + TOKEN_TTL_SECONDS,
      context: {
        user: userClaim(participant),
        features: {
          livestreaming: 'false',
          recording: 'false',
          transcription: 'false',
          'outbound-call': 'false',
          'sip-outbound-call': 'false'
        }
      }
    }, jaasPrivateKey(), { algorithm: 'RS256', header: { kid: p.kid, typ: 'JWT' } });
  } else if (p.mode === 'self_hosted') {
    token = jwt.sign({
      aud: p.appId,
      iss: p.appId,
      sub: new URL(p.serverUrl).host,
      room: roomId,
      nbf: now - 60,
      exp: now + TOKEN_TTL_SECONDS,
      moderator: Boolean(participant.moderator),
      context: { user: userClaim(participant) }
    }, p.secret, { algorithm: 'HS256' });
  }

  // Browser fallback: skip the pre-join screen and the "open the app" page.
  const hash = [
    'config.prejoinConfig.enabled=false',
    'config.disableDeepLinking=true',
    `userInfo.displayName=${encodeURIComponent(JSON.stringify(participant.name))}`
  ].join('&');
  const joinUrl = `${p.serverUrl}/${room}${token ? `?jwt=${token}` : ''}#${hash}`;

  return { mode: p.mode, serverUrl: p.serverUrl, room, token, joinUrl };
}

module.exports = { JITSI_BASE_URL, joinDetails, provider };
