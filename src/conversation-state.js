export const MAX_CONVERSATION_ACTIVITIES = 256;

const ACTIVE_CONVERSATION_STATUSES = new Set(['starting', 'running', 'stopping']);
// Rust accepts at most 8 MiB of decoded inline images. Base64 adds roughly one third.
const CONVERSATION_ATTACHMENT_DATA_URL_MAX_CHARS = 12 * 1024 * 1024;

function normalizedTool(value, fallback = '') {
  const tool = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return tool || fallback;
}

function ownsThread(state, providerId = state.providerId) {
  return Boolean(
    state.threadId
    && state.threadTool
    && state.threadTool === providerId,
  );
}

export function normalizeConversationAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((attachment, index) => {
    if (!attachment || attachment.kind !== 'image') return [];
    const dataUrl = typeof attachment.dataUrl === 'string' ? attachment.dataUrl : '';
    if (!/^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon|avif);base64,/i.test(dataUrl)
      || dataUrl.length > CONVERSATION_ATTACHMENT_DATA_URL_MAX_CHARS
      || /[\0\r\n]/.test(dataUrl)) return [];
    const alt = String(attachment.alt || `会话图片 ${index + 1}`)
      .replace(/[\0-\x1f\x7f]/g, '')
      .slice(0, 160);
    return [{
      kind: 'image',
      mimeType: String(attachment.mimeType || '').slice(0, 80),
      dataUrl,
      alt: alt || `会话图片 ${index + 1}`,
    }];
  });
}

export function conversationHasOpenSession(state) {
  return Boolean(
    (Array.isArray(state?.messages) && state.messages.length)
    || (typeof state?.threadId === 'string' && state.threadId)
    || (typeof state?.sourceSessionId === 'string' && state.sourceSessionId)
  );
}

export function createConversationState({
  projectId = '',
  providerId = 'codex',
  threadId = '',
  threadTool = '',
  sourceTool = '',
  sourceSessionId = '',
} = {}) {
  const provider = normalizedTool(providerId, 'codex');
  const thread = typeof threadId === 'string' ? threadId : '';
  const owner = thread ? normalizedTool(threadTool, provider) : '';
  const source = normalizedTool(sourceTool);
  return {
    projectId,
    providerId: provider,
    threadId: thread,
    threadTool: owner,
    sourceTool: source,
    sourceSessionId: typeof sourceSessionId === 'string' && sourceSessionId
      ? sourceSessionId
      : (source ? thread : ''),
    runId: '',
    runProviderId: '',
    turnId: '',
    status: 'idle',
    messages: [],
    activities: [],
    plan: [],
    notice: '',
    error: '',
    // Codex「请求批准」档下、正在等你拍板的那一条。同一时刻只会有一条：
    // 协议线程在等答复期间不会再发新的请求。
    approval: null,
  };
}

/**
 * Select the CLI for the next turn. When the current thread belongs to another
 * CLI, retain it as an explicit handoff source instead of passing its ID to the
 * newly selected provider. Selecting that source again restores its thread.
 */
export function selectConversationProvider(state, providerId) {
  const provider = normalizedTool(providerId);
  if (!provider
    || provider === state.providerId
    || ACTIVE_CONVERSATION_STATUSES.has(state.status)) return state;

  if (state.sourceTool === provider && state.sourceSessionId) {
    return {
      ...state,
      providerId: provider,
      threadId: state.sourceSessionId,
      threadTool: provider,
      sourceTool: '',
      sourceSessionId: '',
      notice: '',
      error: '',
    };
  }

  const currentOwnsThread = ownsThread(state);
  return {
    ...state,
    providerId: provider,
    threadId: '',
    threadTool: '',
    sourceTool: currentOwnsThread ? state.threadTool : state.sourceTool,
    sourceSessionId: currentOwnsThread ? state.threadId : state.sourceSessionId,
    notice: '',
    error: '',
  };
}

export const switchConversationProvider = selectConversationProvider;

/** Return the provider-scoped resume and optional cross-provider handoff IDs. */
export function conversationRunContext(state) {
  const providerId = normalizedTool(state?.providerId, 'codex');
  const resumable = ownsThread(state, providerId);
  const canHandoff = Boolean(
    state?.sourceTool
    && state?.sourceSessionId
    && state.sourceTool !== providerId,
  );
  return {
    providerId,
    threadId: resumable ? state.threadId : '',
    handoffProviderId: canHandoff ? state.sourceTool : '',
    handoffSessionId: canHandoff ? state.sourceSessionId : '',
  };
}

export function startConversationTurn(state, {
  runId,
  projectId,
  providerId = state.providerId,
  prompt,
  attachments = [],
}) {
  const provider = normalizedTool(providerId);
  if (!runId
    || !projectId
    || !provider
    || !String(prompt || '').trim()
    || ACTIVE_CONVERSATION_STATUSES.has(state.status)) {
    return state;
  }

  const sameProviderThread = ownsThread(state, provider);
  const currentThreadBecomesSource = Boolean(
    state.threadId
    && state.threadTool
    && state.threadTool !== provider,
  );
  const sourceTool = currentThreadBecomesSource ? state.threadTool : state.sourceTool;
  const sourceSessionId = currentThreadBecomesSource ? state.threadId : state.sourceSessionId;

  return {
    ...state,
    projectId,
    providerId: provider,
    threadId: sameProviderThread ? state.threadId : '',
    threadTool: sameProviderThread ? provider : '',
    sourceTool,
    sourceSessionId,
    runId,
    runProviderId: provider,
    turnId: '',
    status: 'starting',
    notice: '',
    error: '',
    activities: [],
    plan: [],
    messages: [
      ...state.messages,
      {
        id: `${runId}-user`,
        role: 'user',
        text: String(prompt).trim(),
        tool: provider,
        pending: false,
        attachments: Array.isArray(attachments) ? attachments : [],
      },
      {
        id: `${runId}-assistant`,
        role: 'assistant',
        text: '',
        tool: provider,
        pending: true,
      },
    ],
  };
}

function updateAssistant(state, updater) {
  const messages = [...state.messages];
  let index = messages.length - 1;
  while (index >= 0 && messages[index].role !== 'assistant') index -= 1;
  const tool = state.runProviderId || state.providerId;
  if (index < 0) {
    messages.push(updater({
      id: `${state.runId}-assistant`,
      role: 'assistant',
      text: '',
      tool,
      pending: true,
    }));
  } else {
    messages[index] = updater({ ...messages[index], tool: messages[index].tool || tool });
  }
  return { ...state, messages };
}

function upsertActivity(activities, next) {
  if (!next || typeof next !== 'object') return activities;
  const id = typeof next.id === 'string' && next.id ? next.id : `activity-${activities.length}`;
  const index = activities.findIndex(item => item.id === id);
  const clean = { ...next, id };
  if (index < 0) {
    const retained = activities.slice(-(MAX_CONVERSATION_ACTIVITIES - 1));
    return [...retained, clean];
  }
  const result = [...activities];
  result[index] = { ...result[index], ...clean };
  return result;
}

export function applyConversationChatEvent(state, envelope) {
  const eventProvider = normalizedTool(envelope?.providerId);
  const cancellationWinsTerminalRace = envelope?.kind === 'cancelled'
    && (state.status === 'completed' || state.status === 'failed');
  if (!envelope
    || envelope.runId !== state.runId
    || (eventProvider && eventProvider !== (state.runProviderId || state.providerId))
    || (!ACTIVE_CONVERSATION_STATUSES.has(state.status) && !cancellationWinsTerminalRace)) return state;
  const data = envelope.data && typeof envelope.data === 'object' ? envelope.data : {};
  switch (envelope.kind) {
    case 'thread': {
      if (typeof data.threadId !== 'string' || !data.threadId) return state;
      const provider = eventProvider || state.runProviderId || state.providerId;
      return {
        ...state,
        threadId: data.threadId,
        threadTool: provider,
        sourceTool: '',
        sourceSessionId: '',
      };
    }
    case 'turn':
      return {
        ...state,
        status: state.status === 'starting' ? 'running' : state.status,
        turnId: typeof data.turnId === 'string' ? data.turnId : state.turnId,
      };
    case 'assistant_delta': {
      if (typeof data.text !== 'string' || !data.text) return state;
      return updateAssistant(state, message => ({
        ...message,
        text: `${message.text || ''}${data.text}`,
        pending: true,
      }));
    }
    case 'assistant_message': {
      if (typeof data.text !== 'string') return state;
      return updateAssistant(state, message => ({ ...message, text: data.text, pending: false }));
    }
    case 'activity':
      return { ...state, activities: upsertActivity(state.activities, data) };
    case 'plan':
      return { ...state, plan: Array.isArray(data.items) ? data.items.slice(0, 32) : [] };
    case 'notice':
      return { ...state, notice: typeof data.message === 'string' ? data.message : '' };
    case 'approval': {
      const approvalId = typeof data.approvalId === 'string' ? data.approvalId : '';
      if (!approvalId) return state;
      return {
        ...state,
        approval: {
          id: approvalId,
          kind: data.kind === 'fileChange' ? 'fileChange' : 'command',
          reason: typeof data.reason === 'string' ? data.reason : '',
          command: typeof data.command === 'string' ? data.command : '',
          // 送出决定到后端确认之间按钮要立刻停下，避免连点成两次答复。
          submitting: false,
        },
      };
    }
    case 'approval_resolved': {
      // 只清掉正在等的那一条；迟到的答复事件不能把新的请求抹掉。
      if (!state.approval || state.approval.id !== data.approvalId) return state;
      return { ...state, approval: null };
    }
    case 'completed': {
      const failed = data.status !== 'completed';
      const next = updateAssistant(state, message => ({ ...message, pending: false }));
      return {
        ...next,
        status: failed ? 'failed' : 'completed',
        error: failed && typeof data.error === 'string' ? data.error : '',
        approval: null,
      };
    }
    case 'cancelled': {
      const next = updateAssistant(state, message => ({ ...message, pending: false }));
      return { ...next, status: 'cancelled', notice: '已停止这次处理', approval: null };
    }
    case 'error': {
      const next = updateAssistant(state, message => ({ ...message, pending: false }));
      return {
        ...next,
        status: 'failed',
        error: typeof data.message === 'string' ? data.message : '所选 CLI 运行出现问题',
        approval: null,
      };
    }
    default:
      return state;
  }
}

// Backward-compatible name for callers that have not yet migrated to generic events.
export const applyCodexChatEvent = applyConversationChatEvent;

export function loadConversationTranscript({
  projectId,
  threadId,
  sourceTool = '',
  providerId = sourceTool,
  messages,
}) {
  const source = normalizedTool(sourceTool, normalizedTool(providerId, 'codex'));
  const provider = normalizedTool(providerId, source);
  const normalized = Array.isArray(messages)
    ? messages
        .filter(message => message && (message.role === 'user' || message.role === 'assistant'))
        .map((message, index) => {
          const attachments = normalizeConversationAttachments(message.attachments);
          return {
            id: `history-${index}`,
            role: message.role,
            text: String(message.text || ''),
            ...(attachments.length ? { attachments } : {}),
            ...(message.role === 'assistant'
              ? { tool: normalizedTool(message.tool, source) }
              : {}),
            pending: false,
          };
        })
    : [];
  return {
    ...createConversationState({
      projectId,
      providerId: provider,
      threadId,
      threadTool: source,
      sourceTool: source,
      sourceSessionId: typeof threadId === 'string' ? threadId : '',
    }),
    messages: normalized,
  };
}
