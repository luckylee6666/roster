export function createConversationRunController({ invoke }) {
  let issuedRunId = '';
  // 连接中的取消必须先排队，等那次 start 真正落地后再补发。多个项目可以
  // 同时处于"连接中"，所以这里是集合；单槽会让先排队的取消被静默覆盖。
  const queuedCancelRunIds = new Set();

  const clear = runId => {
    if (runId) queuedCancelRunIds.delete(runId);
    if (issuedRunId === runId) issuedRunId = '';
  };

  const issueCancel = async runId => {
    if (!runId || issuedRunId === runId) return false;
    issuedRunId = runId;
    queuedCancelRunIds.delete(runId);
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
      if (queuedCancelRunIds.has(runId)) {
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
        queuedCancelRunIds.add(runId);
        return false;
      }
      return issueCancel(runId);
    },

    clear,
  };
}

// Kept while the conversation-mode caller migrates from its original Codex-only name.
export const createCodexRunController = createConversationRunController;
