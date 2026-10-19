const { randomBytes, randomUUID, createHash, timingSafeEqual } = require('node:crypto');

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET = /^[0-9a-f]{64}$/;
const digest = (value) => createHash('sha256').update(value).digest();
const dummy = digest('missing credential');
const error = (status, message) => Object.assign(new Error(message), { status });

function createWorkspaceAuth({ now = Date.now } = {}) {
  // Credentials and approval state are deliberately process-local: restart revokes all access.
  const invitations = new Map(), joins = new Map(), sessions = new Map();
  const bootstrapToken = randomBytes(32).toString('hex');
  const bootstrapDigest = digest(bootstrapToken);
  const invitationMs = 2 * 60 * 1000, joinMs = 10 * 60 * 1000, sessionMs = 8 * 60 * 60 * 1000;

  function prune() {
    for (const map of [invitations, joins, sessions]) {
      for (const [id, record] of map) if (record.expiresAt <= now()) map.delete(id);
    }
  }
  function issue(map, ttl, fields) {
    prune();
    if (map.size >= 256) throw error(429, 'Workspace capacity reached.');
    const id = randomUUID(), secret = randomBytes(32).toString('hex');
    const record = { id, secretHash: digest(secret), expiresAt: now() + ttl, ...fields };
    map.set(id, record);
    return { credential: `${id}.${secret}`, record };
  }
  function lookup(map, credential) {
    if (typeof credential !== 'string' || credential.length !== 101) return null;
    const [id, secret] = credential.split('.');
    if (!ID.test(id) || !SECRET.test(secret)) return null;
    const record = map.get(id);
    const matches = timingSafeEqual(digest(secret), record ? record.secretHash : dummy);
    if (!record || !matches || record.expiresAt <= now()) return null;
    return record;
  }
  function session(role, deviceName) {
    return issue(sessions, sessionMs, { role, deviceName, deviceId: randomUUID() });
  }
  function host(credential) {
    const record = lookup(sessions, credential);
    if (!record || record.role !== 'host') throw error(403, 'Host access required.');
    return record;
  }
  function pending(credential) {
    const record = lookup(joins, credential);
    if (!record) throw error(401, 'Join request expired or invalid.');
    return record;
  }

  return {
    bootstrapToken,
    hostLogin(token) {
      const valid = typeof token === 'string' && SECRET.test(token);
      if (!timingSafeEqual(valid ? digest(token) : dummy, bootstrapDigest)) throw error(401, 'Invalid host code.');
      return session('host', 'Host');
    },
    authenticate(credential) {
      const record = lookup(sessions, credential);
      if (!record) throw error(401, 'Join and obtain host approval to access this workspace.');
      return { id: record.id, role: record.role, deviceId: record.deviceId, expiresAt: record.expiresAt };
    },
    invite(hostCredential) {
      host(hostCredential);
      const { credential, record } = issue(invitations, invitationMs, {});
      return { token: credential, expiresAt: record.expiresAt };
    },
    join(token, deviceName) {
      if (typeof deviceName !== 'string' || deviceName.trim() !== deviceName || !deviceName
        || deviceName.length > 64 || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(deviceName)) {
        throw error(400, 'Use a device label of 1 to 64 characters without control characters.');
      }
      prune();
      const invitation = lookup(invitations, token);
      if (!invitation) throw error(401, 'Invitation expired, used, or invalid.');
      // Synchronous consume before issuing a request prevents concurrent invitation replay.
      invitations.delete(invitation.id);
      return issue(joins, joinMs, { deviceName, state: 'pending', createdAt: now() });
    },
    joinStatus(credential) {
      const record = pending(credential);
      return { id: record.id, state: record.state, expiresAt: record.expiresAt };
    },
    manage(hostCredential) {
      host(hostCredential);
      prune();
      return {
        requests: [...joins.values()].filter((record) => record.state === 'pending').map((record) => ({
          id: record.id, deviceName: record.deviceName, createdAt: record.createdAt, expiresAt: record.expiresAt,
        })),
        devices: [...sessions.values()].filter((record) => record.role === 'member').map((record) => ({
          id: record.id, deviceName: record.deviceName, expiresAt: record.expiresAt,
        })),
      };
    },
    decide(hostCredential, id, decision) {
      host(hostCredential);
      if (!ID.test(id) || !['approve', 'reject'].includes(decision)) throw error(400, 'Invalid join decision.');
      const record = joins.get(id);
      if (!record || record.expiresAt <= now()) throw error(404, 'Join request expired or unavailable.');
      if (record.state !== 'pending') throw error(409, 'Join request already decided.');
      record.state = decision === 'approve' ? 'approved' : 'rejected';
      return { id, state: record.state };
    },
    claim(credential) {
      const record = pending(credential);
      if (record.state !== 'approved') throw error(403, 'Join request is not approved.');
      const result = session('member', record.deviceName);
      joins.delete(record.id); // The pending browser secret is single-use too.
      return result;
    },
    revoke(hostCredential, id) {
      host(hostCredential);
      if (!ID.test(id)) throw error(400, 'Invalid session ID.');
      const record = sessions.get(id);
      if (!record || record.role !== 'member') throw error(404, 'Session unavailable.');
      sessions.delete(id);
    },
    logout(credential) {
      const record = lookup(sessions, credential);
      if (record) sessions.delete(record.id);
    },
  };
}

module.exports = { createWorkspaceAuth };
