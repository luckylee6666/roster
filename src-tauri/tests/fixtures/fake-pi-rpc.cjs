const readline = require("node:readline");

const scenario = process.env.ROSTER_PI_SCENARIO || "normal";
const log = process.env.ROSTER_PI_LOG;
let prompts = 0;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (log) require("node:fs").appendFileSync(log, `${JSON.stringify(request)}\n`);
  if (request.type === "get_state") {
    send({ id: request.id, type: "response", command: "get_state", success: true, data: { sessionId: "fake-pi-session" } });
  } else if (request.type === "prompt") {
    prompts += 1;
    send({ id: request.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    if (scenario === "oversized") {
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x".repeat(1100000) } });
      return;
    }
    send({ type: "message_start", message: { role: "assistant", content: [] } });
    send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private thought" } });
    if (scenario === "hang") {
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "正在处理" } });
      return;
    }
    if (scenario !== "final-only" && scenario !== "retry") {
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `回复${prompts}` } });
    }
    const text = scenario === "final-only" ? "最终回复" : `回复${prompts}`;
    if (scenario === "retry") {
      send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error" } });
      send({ type: "message_start", message: { role: "assistant", content: [] } });
      send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "重试成功" }], stopReason: "end_turn" } });
    } else {
      send({ type: "tool_execution_start", toolCallId: "call-one", toolName: "read", args: { path: "/private/path" } });
      send({ type: "tool_execution_start", toolCallId: "call-one", toolName: "read", args: { path: "/private/path" } });
      send({ type: "tool_execution_end", toolCallId: "call-one", isError: scenario === "tool-failed", result: { content: [{ type: "text", text: "/private/path" }] } });
      send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" } });
    }
    send({ type: "agent_end", messages: [] });
    if (scenario === "agent-end-only") process.exit(0);
    send({ type: "agent_settled", aborted: scenario === "aborted" });
  }
});
