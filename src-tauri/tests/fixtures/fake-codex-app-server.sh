#!/bin/sh
set -eu

if [ "${1:-}" != "app-server" ] || [ "${2:-}" != "--stdio" ]; then
  printf '%s\n' "expected: app-server --stdio" >&2
  exit 2
fi

log_path=${ROSTER_FAKE_CODEX_LOG:?missing ROSTER_FAKE_CODEX_LOG}
scenario=${ROSTER_FAKE_CODEX_SCENARIO:-start}
timeout_seconds=${ROSTER_FAKE_CODEX_TIMEOUT_SECONDS:-10}
: >"$log_path"

watchdog_pid=
cleanup() {
  if [ -n "$watchdog_pid" ]; then
    kill "$watchdog_pid" 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 124' HUP INT TERM
(
  sleep "$timeout_seconds"
  kill -TERM "$$" 2>/dev/null || true
) &
watchdog_pid=$!

read_request() {
  label=$1
  if ! IFS= read -r request_line; then
    printf 'missing request: %s\n' "$label" >&2
    exit 3
  fi
  printf '%s\n' "$request_line" >>"$log_path"
}

read_request initialize
printf '%s\n' '{"id":1,"result":{"serverInfo":{"name":"fake-codex"}}}'

read_request initialized
read_request thread
if [ "$scenario" = "resume" ]; then
  thread_id=thread-existing-1
else
  thread_id=thread-contract-1
fi
printf '{"id":2,"result":{"thread":{"id":"%s"}}}\n' "$thread_id"

read_request turn
printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-contract-1"}}}'

printf '%s\n' '{"id":101,"method":"item/commandExecution/requestApproval","params":{}}'
read_request command_approval_response
printf '%s\n' '{"id":102,"method":"item/fileChange/requestApproval","params":{}}'
read_request file_approval_response
printf '%s\n' '{"id":103,"method":"item/tool/requestUserInput","params":{}}'
read_request user_input_response

if [ "$scenario" = "delta-completed" ]; then
  first_delta=$(dd if=/dev/zero bs=1 count=20000 2>/dev/null | tr '\000' a)
  second_delta=$(dd if=/dev/zero bs=1 count=20000 2>/dev/null | tr '\000' b)
  printf '%s%s%s\n' '{"method":"item/agentMessage/delta","params":{"itemId":"agent-stream-1","delta":"' "$first_delta" '"}}'
  printf '%s%s%s\n' '{"method":"item/agentMessage/delta","params":{"itemId":"agent-stream-1","delta":"' "$second_delta" '"}}'
  printf '%s%s%s%s%s\n' '{"method":"item/completed","params":{"item":{"id":"agent-stream-1","type":"agentMessage","text":"' "$first_delta" "$second_delta" '"}}}'
elif [ "$scenario" = "multi-agent-message" ]; then
  printf '%s\n' '{"method":"item/agentMessage/delta","params":{"itemId":"agent-stream-1","delta":"流式第一段"}}'
  printf '%s\n' '{"method":"item/completed","params":{"item":{"id":"agent-stream-1","type":"agentMessage","text":"流式第一段"}}}'
  printf '%s\n' '{"method":"item/completed","params":{"item":{"id":"agent-fallback-2","type":"agentMessage","text":"无流式第二段"}}}'
else
  printf '%s\n' '{"method":"item/agentMessage/delta","params":{"delta":"契约测试回复"}}'
fi
if [ "$scenario" = "hang" ]; then
  while :; do
    sleep 1
  done
fi

if [ "$scenario" = "leader-exit-with-child" ] || [ "$scenario" = "leader-exit-with-child-no-completed" ]; then
  child_pid_file=${ROSTER_FAKE_CODEX_CHILD_PID_FILE:?missing ROSTER_FAKE_CODEX_CHILD_PID_FILE}
  sleep "$timeout_seconds" &
  printf '%s %s\n' "$$" "$!" >"$child_pid_file"
fi

if [ "$scenario" = "leader-exit-with-child-no-completed" ]; then
  exit 0
fi

printf '%s\n' '{"method":"turn/completed","params":{"turn":{"id":"turn-contract-1","status":"completed"}}}'

if [ "$scenario" = "wait-stdin-eof" ]; then
  # A normal App Server exits only after its client closes the writer. Keep
  # this process alive until EOF so the Rust contract test catches a cleanup
  # path that waits for grace timeout before dropping ChildStdin.
  while IFS= read -r _ignored; do
    :
  done
  printf '%s\n' '{"observed":"stdin-eof"}' >>"$log_path"
fi
