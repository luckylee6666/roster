// Used only by the ignored installed-Kilo integration test. Requests stay on
// loopback; no real credentials or external model service are involved.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw new Error('absolute test directory required');
let count = 0;
const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) {
    response.writeHead(404).end();
    return;
  }
  let raw = '';
  request.on('data', chunk => {
    raw += chunk.toString();
    if (raw.length > 1024 * 1024) request.destroy();
  });
  request.on('end', () => {
    try {
      const body = JSON.parse(raw);
      const messages = body.messages || [];
      const lastUser = messages.findLastIndex(message => message.role === 'user');
      const prompt = JSON.stringify(messages[lastUser]?.content || '');
      const results = messages.slice(lastUser + 1).filter(message => message.role === 'tool');
      const phase = prompt.includes('ROSTER_KILO_WRITE') ? 'WRITE'
        : prompt.includes('ROSTER_KILO_CONTINUE') ? 'CONTINUE' : 'PLAN';
      const tools = (body.tools || []).map(tool => tool.function?.name);
      const call = phase !== 'CONTINUE' && !results.length && tools.length > 0;
      const message = call ? { role: 'assistant', content: null, tool_calls: [{
        id: `write-${++count}`, type: 'function', function: {
          name: phase === 'PLAN' ? 'read' : 'write',
          arguments: JSON.stringify(phase === 'PLAN'
            ? { filePath: path.join(root, 'readme.txt') }
            : { filePath: path.join(root, 'probe.txt'), content: 'ROSTER_KILO_WRITE_OK' }),
        },
      }] } : { role: 'assistant', content: `ROSTER_KILO_${phase}_OK` };
      fs.appendFileSync(path.join(root, 'kilo-model-requests.jsonl'), JSON.stringify({
        phase, call, tools, toolResultCount: results.length,
      }) + '\n');
      const result = {
        id: `roster-kilo-${++count}`, object: 'chat.completion', created: 1,
        model: 'kilo-test', choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      };
      if (!body.stream) {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (delta, finish = null) => response.write(`data: ${JSON.stringify({
        ...result, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      send({ role: 'assistant', content: '' });
      if (call) send({ tool_calls: message.tool_calls.map((tool, index) => ({ index, ...tool })) });
      else send({ content: message.content });
      send({}, call ? 'tool_calls' : 'stop');
      response.end('data: [DONE]\n\n');
    } catch {
      response.destroy();
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
