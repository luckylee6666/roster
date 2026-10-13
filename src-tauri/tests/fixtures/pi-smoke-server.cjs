// Manual integration fixture: local synthetic provider only. Never proxy a request
// or load credentials. The Rust ignored test owns/cleans the temporary directory.
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
      count++;
      fs.appendFileSync(path.join(root, 'pi-model-requests.jsonl'), JSON.stringify({
        request: count,
        tools: (body.tools || []).map(tool => tool.function?.name),
        toolResults: (body.messages || []).filter(message => message.role === 'tool')
          .map(message => ({ content: message.content, tool_call_id: message.tool_call_id })),
      }) + '\n');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (delta, finish = null) => response.write(`data: ${JSON.stringify({
        id: `roster-pi-${count}`, object: 'chat.completion.chunk', created: 1,
        model: 'pi-test', choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      send({ role: 'assistant', content: '' });
      if (count === 1) {
        send({ tool_calls: [
          { index: 0, id: 'read-probe', type: 'function', function: {
            name: 'read', arguments: JSON.stringify({ path: path.join(root, 'probe.txt') }),
          } },
          // An unadvertised write must not become executable merely because a
          // provider emits it; the positive read above verifies tools ran at all.
          { index: 1, id: 'write-probe', type: 'function', function: {
            name: 'write', arguments: JSON.stringify({ path: path.join(root, 'probe.txt'), content: 'SHOULD_NOT_WRITE' }),
          } },
        ] });
        send({}, 'tool_calls');
      } else {
        send({ content: count === 2 ? 'PI_ROSTER_TURN_ONE_OK' : 'PI_ROSTER_TURN_TWO_OK' });
        send({}, 'stop');
      }
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
