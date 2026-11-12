export function presenceTtlSeconds(options) {
  return Math.ceil(options.presenceTtlMs / 1000);
}

export function normalizePresencePayload(body = {}) {
  const area = String(body.area || '').trim();
  const resourceType = String(body.resource_type || body.resourceType || '').trim();
  const resourceId = String(body.resource_id || body.resourceId || '').trim();
  const mode = String(body.mode || '').trim();
  if (!area || !resourceType || !resourceId || !['viewing', 'editing'].includes(mode)) return null;
  return {
    area,
    resource_type: resourceType,
    resource_id: resourceId,
    mode,
  };
}

export function presenceSessionEntry(session, payload, nowMs) {
  return {
    session_id: session.session_id,
    actor: {
      user_id: session.user.user_id,
      email: session.user.email,
      display_name: session.user.display_name,
    },
    area: payload.area,
    resource_type: payload.resource_type,
    resource_id: payload.resource_id,
    mode: payload.mode,
    last_activity_at: new Date(nowMs).toISOString(),
  };
}

export function presenceSnapshot(options) {
  const nowMs = options.now();
  options.presenceStore.cleanup(nowMs);
  const sessions = [...options.presenceStore.entries.values()].map((entry) => entry.value);
  const resourcesByKey = new Map();
  for (const session of sessions) {
    const key = `${session.area}\u0000${session.resource_type}\u0000${session.resource_id}`;
    const resource = resourcesByKey.get(key) || {
      area: session.area,
      resource_type: session.resource_type,
      resource_id: session.resource_id,
      sessions: [],
    };
    resource.sessions.push(session.session_id);
    resourcesByKey.set(key, resource);
  }
  for (const resource of resourcesByKey.values()) resource.sessions.sort();
  return {
    sessions: sessions.sort((left, right) => left.session_id.localeCompare(right.session_id)),
    resources: [...resourcesByKey.values()],
    ttl_seconds: presenceTtlSeconds(options),
  };
}
