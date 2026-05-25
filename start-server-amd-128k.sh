#!/usr/bin/env bash
# Reference llama-server launcher for the dw-x1pro-linux AMD 890M 128K profile
# documented in docs/hardware-profiles.md.
#
# Default shape: one text-only Qwen server with a single 128K slot.
# This keeps the machine inside a more comfortable memory envelope than the
# experimentally valid but tighter 2x128K or 1x256K shapes.
set -euo pipefail

LLAMA_SERVER="${LLAMA_SERVER:-/usr/local/bin/llama-server}"
MODEL="${MODEL:-$HOME/models/Qwen3.5-35B-A3B-Q4_K_M.gguf}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-19434}"
CTX_SIZE="${CTX_SIZE:-131072}"
PARALLEL_SLOTS="${PARALLEL_SLOTS:-1}"
LOG_PATH="${LOG_PATH:-/tmp/local-agent-amd-128k.log}"

if [ ! -x "$LLAMA_SERVER" ]; then
  echo "llama-server not executable: $LLAMA_SERVER" >&2
  exit 1
fi

if [ ! -f "$MODEL" ]; then
  echo "model not found: $MODEL" >&2
  exit 1
fi

stop_port() {
  local port="$1"
  pkill -f "llama-server .*--port ${port}" 2>/dev/null || true
  pkill -f "llama-server.*--port ${port}" 2>/dev/null || true
}

wait_ready() {
  local port="$1" pid="$2" log="$3"
  for _ in $(seq 1 240); do
    if curl -fsS "http://127.0.0.1:${port}/health" 2>/dev/null | grep -q ok; then
      echo "local-agent AMD 128K ready on port $port pid=$pid"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "server exited early; tail of $log:" >&2
      tail -120 "$log" >&2 || true
      return 1
    fi
    sleep 1
  done
  echo "server timed out; tail of $log:" >&2
  tail -120 "$log" >&2 || true
  return 1
}

echo "AMD 128K mode: host=$HOST port=$PORT ctx=$CTX_SIZE slots=$PARALLEL_SLOTS model=$(basename "$MODEL") log=$LOG_PATH"
stop_port "$PORT"
sleep 1

nohup "$LLAMA_SERVER" \
  -m "$MODEL" \
  --host "$HOST" \
  --port "$PORT" \
  -ngl 999 \
  -c "$CTX_SIZE" \
  -np "$PARALLEL_SLOTS" \
  > "$LOG_PATH" 2>&1 &

wait_ready "$PORT" "$!" "$LOG_PATH"

echo
echo "endpoint: http://127.0.0.1:${PORT}/v1"
echo "props:    curl -s http://127.0.0.1:${PORT}/props | jq '.model_alias, .total_slots, .default_generation_settings.n_ctx'"
