export function createConversationRunController({ invoke }) {
  let queuedRunId = '';
  let issuedRunId = '';

  const clear = runId => {
    if (queuedRunId === runId) queuedRunId = '';
    if (issuedRunId === runId) issuedRunId = '';
  };

  const issueCancel = async runId => {
    if (!runId || issuedRunId === runId) return false;
    issuedRunId = runId;
    if (queuedRunId === runId) queuedRunId = '';
    try {
      await invoke('conversation_chat_cancel', { runId });
      return true;
    } catch (error) {
      if (issuedRunId === runId) issuedRunId = '';
      throw error;
    }
  };

  return {
    async start(request) {
      const runId = request?.runId || '';
      try {
        await invoke('conversation_chat_start', { request });
      } catch (error) {
        clear(runId);
        throw error;
      }
      // A queued cancellation is best-effort. The turn has started
      // successfully even if its later stop request cannot reach the backend.
      if (queuedRunId === runId) {
        try {
          await issueCancel(runId);
        } catch (_) {
          // The caller keeps the turn live and presents a retryable stop UI.
        }
      }
    },

    async cancel(runId, { backendReady = true } = {}) {
      if (!runId || issuedRunId === runId) return false;
      if (!backendReady) {
        queuedRunId = runId;
        return false;
      }
      return issueCancel(runId);
    },

    clear,
  };
}

// Kept while the conversation-mode caller migrates from its original Codex-only name.
export const createCodexRunController = createConversationRunController;
