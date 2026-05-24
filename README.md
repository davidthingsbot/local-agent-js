# local-agent-js

JavaScript/Node translation of `local-agent-py`: a tiny local agent harness for OpenAI-compatible local models such as Qwen via llama.cpp.

Default target: a Qwen server at `http://127.0.0.1:19434/v1`. On David's model host, llama.cpp now binds to `0.0.0.0:19434` so other machines can connect. The preferred server is one dual-slot llama.cpp process across both RTX 3090s: `--ctx-size 524288 -np 2`, reported as two simultaneous `n_ctx=262144` slots.

## Run

```bash
cd ~/work/local-agent-js
./la.sh
```

One-shot task:

```bash
node ./bin/local-agent-js.js --cwd ~/work/la-test \
  "Inspect this directory, write hello-js.md, and summarize what you did."
```

Install/link as an npm CLI during development:

```bash
npm link
local-agent-js --capabilities
lajs --cwd ~/work/la-test "list files and write a short report"
```


## Running from another machine

The model host now binds llama.cpp to all interfaces:

```bash
--host 0.0.0.0 --port 19434
```

From another machine, point the JS agent at the model host:

```bash
QWEN_BASE_URL=http://<model-host-ip-or-tailnet-name>:19434/v1 ./la.sh
# or
QWEN_BASE_URL=http://<model-host-ip-or-tailnet-name>:19434/v1 \
  node ./bin/local-agent-js.js --cwd ~/work/la-test "your task"
```

Use Tailscale or a trusted LAN/VPN. The llama.cpp endpoint has no real auth by default, so do **not** expose port `19434` directly to the public internet.

## What is ported

- OpenAI-compatible chat-completions loop using Node's built-in `fetch`
- Tool calling: `list_dir`, `read_file`, `write_file`, `run_shell`
- Subagents: blocking and background child agent jobs
- Safe write sandbox with optional `--write-dir`
- Transcript persistence and REPL resume
- Compaction summaries with pinned original request/open outputs
- Empty-response watchdog with four retries
- `/jobs`, `/clear-jobs`, `/context`, `/compact`, `/dirs`, `/capabilities`, `/reset`
- Same local Qwen startup script/service template as the Python repo

## Notes

This is intentionally dependency-light: no runtime npm dependencies. Node 20+ is required for built-in `fetch` and `AbortSignal.timeout`; Node 22 is what this machine is running.

The Python repo remains the more battle-tested version for now. This JS repo is the npm-module starting point.
