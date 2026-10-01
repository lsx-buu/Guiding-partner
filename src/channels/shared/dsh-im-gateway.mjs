import { createHash } from 'node:crypto';

const SERVICE_NAME = 'dshImGateway';
const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_CAPACITY = 10_000;

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function listenerSet() {
  const listeners = new Set();
  return {
    add(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of [...listeners]) {
        try { listener(event); } catch { /* listeners must not break the gateway */ }
      }
    },
  };
}

function stableRouteId(route) {
  const fields = ['channel', 'botId', 'kind', 'conversationId'];
  if (fields.some((field) => typeof route[field] !== 'string' || route[field].trim() === '')) {
    throw new TypeError('direct route requires channel, botId, kind, and conversationId');
  }
  const canonical = JSON.stringify(fields.map((field) => route[field].trim()));
  return `dshim-route-v1-${createHash('sha256').update(canonical).digest('hex')}`;
}

function assertDirect(route) {
  if (route.kind !== 'direct') throw new TypeError('dsh-im gateway only supports direct routes');
}

function gatewayError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createDshImGateway(options = {}) {
  const routes = new Map();
  const adapters = new Map();
  const journal = [];
  const inboundListeners = listenerSet();
  const routeListeners = listenerSet();
  const conversationReplyListeners = listenerSet();
  const inboundHandlers = new Set();
  const retentionMs = Number.isFinite(options.retentionMs) ? Math.max(0, options.retentionMs) : DEFAULT_RETENTION_MS;
  const capacity = Number.isInteger(options.capacity) ? Math.max(1, options.capacity) : DEFAULT_CAPACITY;
  let sequence = 0;

  function prune(now = Date.now()) {
    const threshold = now - retentionMs;
    while (journal.length > capacity || (journal.length && journal[0].recordedAt < threshold)) journal.shift();
  }

  function routeSnapshot(route) {
    return clone({
      routeId: route.routeId,
      channel: route.channel,
      botId: route.botId,
      kind: route.kind,
      conversationId: route.conversationId,
      routeVersion: route.routeVersion,
      inboundVersion: route.inboundVersion,
      status: route.status,
      adapterId: route.adapterId,
      ownerId: route.ownerId,
      sessionId: route.sessionId ?? null,
      lastInboundAt: route.lastInboundAt ?? null,
      verification: route.verification ? {
        kind: route.verification.kind,
        verifiedAt: route.verification.verifiedAt,
      } : null,
      createdAt: route.createdAt,
      updatedAt: route.updatedAt,
    });
  }

  function getRoute(routeId) {
    const route = routes.get(String(routeId));
    return route ? routeSnapshot(route) : null;
  }

  function listRoutes() {
    return [...routes.values()]
      .sort((left, right) => left.routeId.localeCompare(right.routeId))
      .map(routeSnapshot);
  }

  async function getCapabilities(routeId) {
    const route = routes.get(String(routeId));
    if (!route) return null;
    const adapter = adapters.get(route.adapterId);
    const value = typeof adapter?.getCapabilities === 'function'
      ? await adapter.getCapabilities(routeSnapshot(route))
      : (adapter?.capabilities ?? {});
    return clone(value);
  }

  async function getHealth(routeId) {
    const route = routes.get(String(routeId));
    if (!route) return null;
    const adapter = adapters.get(route.adapterId);
    const value = typeof adapter?.getHealth === 'function'
      ? await adapter.getHealth(routeSnapshot(route))
      : (adapter?.health ?? { status: route.status === 'active' ? 'ok' : 'unavailable' });
    return clone(value);
  }

  async function send(routeId, message, sendOptions = {}) {
    const key = sendOptions.idempotencyKey;
    if (typeof key !== 'string' || !key.trim()) throw new TypeError('idempotencyKey must be a non-empty string');
    const route = routes.get(String(routeId));
    if (!route) throw gatewayError('unknown_route', `Unknown route: ${routeId}`);
    if (route.status !== 'active') throw gatewayError('inactive_route', `Route is not active: ${routeId}`);
    if (route.kind !== 'direct') throw new TypeError('dsh-im gateway only supports direct routes');
    const adapter = adapters.get(route.adapterId);
    if (!adapter || typeof adapter.send !== 'function') throw gatewayError('adapter_unavailable', `Adapter unavailable: ${route.adapterId}`);
    return clone(await adapter.send(routeSnapshot(route), clone(message), { ...sendOptions }));
  }

  function onInbound(listener) { return inboundListeners.add(listener); }
  function onRouteChanged(listener) { return routeListeners.add(listener); }
  function onConversationReply(listener) { return conversationReplyListeners.add(listener); }
  function onInboundHandler(handler) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    inboundHandlers.add(handler);
    return () => inboundHandlers.delete(handler);
  }

  async function dispatchInbound(routeId, inbound = {}) {
    const route = routes.get(String(routeId));
    if (!route || route.status !== 'active') return { handled: false, replies: [] };
    const event = {
      routeId: route.routeId,
      channel: route.channel,
      ownerId: route.ownerId,
      messageId: inbound.messageId ?? null,
      normalizedText: typeof inbound.normalizedText === 'string' ? inbound.normalizedText.trim() : '',
      images: Array.isArray(inbound.images) ? inbound.images : [],
    };
    for (const handler of [...inboundHandlers]) {
      try {
        const result = await handler(event);
        if (result?.handled) return { handled: true, replies: Array.isArray(result.replies) ? result.replies.filter(Boolean) : [] };
      } catch { /* an optional handler must not break the legacy message path */ }
    }
    return { handled: false, replies: [] };
  }

  function readInboundSince(cursor, limit = 100) {
    if (cursor === null || cursor === undefined || cursor === '') cursor = '0';
    if (!/^\d+$/.test(String(cursor))) throw gatewayError('invalid_cursor', 'Cursor must be a non-negative integer');
    const numericCursor = Number(cursor);
    if (!Number.isSafeInteger(numericCursor) || numericCursor < 0 || numericCursor > sequence) {
      throw gatewayError('invalid_cursor', 'Cursor is outside the available journal');
    }
    if (!Number.isInteger(limit) || limit <= 0) throw new TypeError('limit must be a positive integer');
    prune();
    const first = journal[0]?.sequence;
    if (first !== undefined && numericCursor < first - 1) throw gatewayError('cursor_expired', 'Cursor is older than the retained journal');
    const events = journal.filter((entry) => entry.sequence > numericCursor).slice(0, limit).map((entry) => clone(entry.event));
    const nextCursor = events.length ? events.at(-1).cursor : String(numericCursor);
    return { events, nextCursor };
  }

  function getJournalState() {
    prune();
    return clone({
      currentCursor: String(sequence),
      oldestCursor: journal[0]?.event.cursor ?? null,
      retentionMs,
      capacity,
    });
  }

  function registerAdapter(adapterId, adapter) {
    if (typeof adapterId === 'object' && adapter === undefined) {
      adapter = adapterId;
      adapterId = adapter?.adapterId ?? adapter?.id;
    }
    if (!adapterId) throw new TypeError('adapterId is required');
    if (!adapter || typeof adapter.send !== 'function') throw new TypeError('adapter.send is required');
    const id = String(adapterId);
    adapters.set(id, adapter);
    const unregister = () => {
      if (adapters.get(id) !== adapter) return false;
      adapters.delete(id);
      for (const route of routes.values()) {
        if (route.adapterId === id && route.status === 'active') revokeRoute(route.routeId, 'adapter_unregistered');
      }
      return true;
    };
    return unregister;
  }

  function unregisterAdapter(adapterId) {
    const id = String(adapterId);
    const adapter = adapters.get(id);
    if (!adapter) return false;
    adapters.delete(id);
    for (const route of routes.values()) {
      if (route.adapterId === id && route.status === 'active') revokeRoute(route.routeId, 'adapter_unregistered');
    }
    return true;
  }

  function upsertTrustedRoute(input) {
    if (!input || typeof input !== 'object') throw new TypeError('route input is required');
    const verification = input.verification;
    if (typeof input.ownerId !== 'string' || input.ownerId.trim() === '') throw new TypeError('ownerId is required');
    if (!verification || !['configured-owner', 'qr-bound-owner'].includes(verification.kind)
      || typeof verification.verifiedAt !== 'string' || verification.verifiedAt.trim() === '') {
      throw new TypeError('verification.kind and verification.verifiedAt are required');
    }
    const routeInput = {
      channel: typeof input.channel === 'string' ? input.channel.trim() : input.channel,
      botId: typeof input.botId === 'string' ? input.botId.trim() : input.botId,
      kind: typeof input.kind === 'string' ? input.kind.trim() : (input.kind ?? 'direct'),
      conversationId: typeof input.conversationId === 'string' ? input.conversationId.trim() : input.conversationId,
      adapterId: input.adapterId,
      ownerId: input.ownerId.trim(),
      sessionId: input.sessionId === undefined ? undefined : String(input.sessionId),
      verification: { kind: verification.kind, verifiedAt: verification.verifiedAt.trim() },
    };
    assertDirect(routeInput);
    const routeId = stableRouteId(routeInput);
    if (!routeInput.adapterId) throw new TypeError('adapterId is required');
    if (!adapters.has(String(routeInput.adapterId))) throw gatewayError('adapter_unavailable', `Adapter unavailable: ${routeInput.adapterId}`);
    const now = new Date().toISOString();
    const existing = routes.get(routeId);
    if (existing) {
      Object.assign(existing, routeInput, { routeId, status: 'active', routeVersion: existing.routeVersion + 1, updatedAt: now, adapterId: String(routeInput.adapterId) });
      routeListeners.emit({ type: 'route_changed', route: routeSnapshot(existing) });
      return routeSnapshot(existing);
    }
    const created = { ...routeInput, routeId, adapterId: String(routeInput.adapterId), status: 'active', routeVersion: 1, inboundVersion: 0, createdAt: now, updatedAt: now };
    routes.set(routeId, created);
    routeListeners.emit({ type: 'route_changed', route: routeSnapshot(created) });
    return routeSnapshot(created);
  }

  function revokeRoute(routeId, reason = 'revoked') {
    const route = routes.get(String(routeId));
    if (!route) return false;
    route.status = 'revoked';
    route.reason = reason;
    route.routeVersion += 1;
    route.updatedAt = new Date().toISOString();
    routeListeners.emit({ type: 'route_changed', reason, route: routeSnapshot(route) });
    return true;
  }

  function recordInbound(routeId, inbound = {}) {
    const route = routes.get(String(routeId));
    if (!route || route.status !== 'active') throw gatewayError('unknown_route', `Unknown or inactive route: ${routeId}`);
    route.inboundVersion += 1;
    route.updatedAt = new Date().toISOString();
    const rawText = inbound.normalizedText ?? inbound.text;
    const text = typeof rawText === 'string' ? rawText.trim() : rawText;
    route.lastInboundAt = inbound.occurredAt ?? new Date().toISOString();
    const controlIntent = text === '/companion pause' || text === '停止主动消息'
      || text === '别再催我' ? 'pause_proactive' : text === '/companion resume' ? 'resume_proactive' : undefined;
    const cursor = String(++sequence);
    const event = {
      cursor, routeId: route.routeId, messageId: inbound.messageId ?? null,
      occurredAt: inbound.occurredAt ?? new Date().toISOString(), routeVersion: route.routeVersion,
      inboundVersion: route.inboundVersion, ...(controlIntent ? { controlIntent } : {}),
    };
    journal.push({ sequence, recordedAt: Date.now(), event });
    prune();
    const live = { ...event, ...(text !== undefined ? { normalizedText: text } : {}) };
    inboundListeners.emit(clone(live));
    return clone(live);
  }

  function recordConversationReply(routeId, reply = {}) {
    const route = routes.get(String(routeId));
    if (!route || route.status !== 'active') throw gatewayError('unknown_route', `Unknown or inactive route: ${routeId}`);
    const inputText = typeof reply.inputText === 'string' ? reply.inputText.trim().slice(0, 4_000) : '';
    const outputText = typeof reply.outputText === 'string' ? reply.outputText.trim().slice(0, 4_000) : '';
    if (!outputText) throw new TypeError('conversation reply outputText is required');
    const event = {
      routeId: route.routeId,
      messageId: reply.messageId ?? null,
      occurredAt: reply.occurredAt ?? new Date().toISOString(),
      routeVersion: route.routeVersion,
      inboundVersion: route.inboundVersion,
      inputText,
      outputText,
    };
    conversationReplyListeners.emit(clone(event));
    return clone(event);
  }

  const publicGateway = Object.freeze({ listRoutes, getJournalState, getRoute, getCapabilities, getHealth, send, onInbound, onInboundHandler, onRouteChanged, onConversationReply, readInboundSince });
  const registry = Object.freeze({ registerAdapter, unregisterAdapter, upsertTrustedRoute, revokeRoute, recordInbound, recordConversationReply, dispatchInbound });
  return {
    gateway: publicGateway,
    registry,
    publicGateway,
    internalRegistry: registry,
    serviceName: SERVICE_NAME,
  };
}

export { SERVICE_NAME as dshImGatewayServiceName };
