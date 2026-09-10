const readline = require('node:readline');
const fs = require('node:fs');
const provider = process.env.ROSTER_RESIDENT_PROVIDER;
const scenario = process.env.ROSTER_RESIDENT_SCENARIO || 'normal';
const log = process.env.ROSTER_RESIDENT_LOG;
const session = `session-${provider}`;
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
let turns = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(log, JSON.stringify({ pid: process.pid, request }) + '\n');
  if (request.method === 'initialize') return out({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (['session/new', 'session/load'].includes(request.method)) return out({ id: request.id, result: { sessionId: session } });
  if (['session/set_mode', 'session/set_model'].includes(request.method)) return out(scenario === 'reject-mode' ? { id: request.id, error: { message: 'mode rejected' } } : { id: request.id, result: {} });
  if (request.method && request.method !== 'session/prompt') return;
  if (!request.method && !['user'].includes(request.type || request.event)) return;
  turns++;
  if (scenario === 'die-second' && turns === 2) return process.exit(1);
  if (scenario === 'oversized') return process.stdout.write('x'.repeat(1024 * 1024 + 1) + '\n');
  if (request.method === 'session/prompt') {
    if (scenario === 'oversized-update') {
      out({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'read', status: 'completed', content: { type: 'text', text: 'x'.repeat(1024 * 1024 + 1) } } } });
      out({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `回复${turns}` } } } });
      return out({ id: request.id, result: { stopReason: 'end_turn' } });
    }
    if (scenario === 'empty-reply') {
      out({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '私有推理' } } } });
      return out({ id: request.id, result: { stopReason: 'end_turn' } });
    }
    out({ method: 'session/update', params: { sessionId: 'wrong-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '串会话' } } } });
    out({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '私有推理' } } } });
    if (scenario === 'agent-message') {
      out({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message', content: [{ type: 'text', text: `回复${turns}` }] } } });
    } else {
      out({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `回复${turns}` } } } });
    }
    if (scenario !== 'hang') out({ id: request.id, result: { stopReason: 'end_turn' } });
  } else if (provider === 'agy') {
    out({ event: 'init', conversation_id: session });
    out({ event: 'step_update', step_update: { conversation_id: session, step_type: 'agent_response', text_delta: `回复${turns}` } });
    if (scenario !== 'hang') out({ event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: `回复${turns}` } });
  } else {
    out({ type: 'system', session_id: session, subtype: 'init' });
    if (provider === 'qwen') out({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `回复${turns}` } } });
    out({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text: `回复${turns}` }] } });
    if (scenario !== 'hang') out({ type: 'result', session_id: session, is_error: false, result: `回复${turns}` });
  }
});
