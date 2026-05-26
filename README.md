# local-agent-js

JavaScript/Node translation of `local-agent-py`: a tiny local agent harness for OpenAI-compatible local models such as Qwen via llama.cpp.

This repo now separates:

- **general agent/runtime documentation** from
- **hardware-specific tuning profiles**

That keeps the core docs useful on any machine while still preserving tested launch examples for particular hardware.

## What this project does

`local-agent-js` is a lightweight local agent CLI and module for running tool-using agent loops against a local OpenAI-compatible endpoint.

Core capabilities:

- OpenAI-compatible chat-completions loop using Node's built-in `fetch`
- Tool calling: `list_dir`, `read_file`, `write_file`, `run_shell`
- Subagents: blocking and background child agent jobs
- Safe write sandbox with optional `--write-dir`
- Transcript persistence and REPL resume
- Compaction summaries with pinned original request/open outputs
- Empty-response watchdog with four retries
- REPL commands: `/jobs`, `/clear-jobs`, `/context`, `/compact`, `/dirs`, `/capabilities`, `/reset`

## Runtime

- Node 20+ required
- Node 22 is the current development baseline on David's machine
- CLI entry: `bin/local-agent-js.js`
- Main module: `src/agent.js`
- Convenience launcher: `./la.sh`
- Default model endpoint: `http://127.0.0.1:19434/v1`

## Quick start

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

Point the JS agent at the remote model host:

```bash
QWEN_BASE_URL=http://<model-host-ip-or-tailnet-name>:19434/v1 ./la.sh
# or
QWEN_BASE_URL=http://<model-host-ip-or-tailnet-name>:19434/v1 \
  node ./bin/local-agent-js.js --cwd ~/work/la-test "your task"
```

Use Tailscale or a trusted LAN/VPN. The llama.cpp endpoint has no meaningful protection unless you enable its built-in API-key support, so do **not** expose port `19434` directly to the public internet.

For secured deployments, this repo now uses llama.cpp's built-in authentication options:

- `--api-key KEY`
- `--api-key-file FNAME`

On the current AMD 890M setup, the boot-time service is configured with `--api-key-file` so requests must present `Authorization: Bearer <key>`.

## Documentation map

### General docs

- `README.md` — project overview, features, runtime, and usage
- `AGENTS.md` — contributor/agent guidance for working in this repo

### Hardware-specific docs

- `docs/hardware-profiles.md` — machine-specific tuning guidance and tested launch profiles

### Reference launch artifacts

These are examples tied to specific tested hardware profiles, not universal defaults:

- dual-3090:
  - `start-servers.sh`
  - `systemd/local-agent-qwen.service`
- AMD 890M 128K:
  - `start-server-amd-128k.sh`
  - `systemd/local-agent-qwen-amd-128k.service`

## Hardware tuning approach

When tuning `local-agent-js` for a new machine, keep the tuning dimensions separate from the agent features themselves.

Typical tuning axes:

- **Model family and quant**: Q4/Q5/Q6/Q8 or other GGUF variants
- **Context vs concurrency**: larger `--ctx-size` and fewer slots vs smaller contexts and more slots
- **Backend**: CUDA, ROCm, Vulkan, CPU, or mixed offload
- **Text-only vs multimodal**: whether to load projector files / vision support
- **Latency vs throughput**: interactive single-user feel vs multiple concurrent agent jobs

The workflow should be:

1. Start from a clean hardware profile for the machine.
2. Benchmark a small matrix of model/quant/context/parallel choices.
3. Keep the best-performing launch command in the hardware-profile docs.
4. Only then promote a tested command into helper scripts or systemd examples.

## Current hardware references

The repo currently includes two documented hardware-profile families:

- **dual RTX 3090 reference profile**
  - `docs/hardware-profiles.md`
  - `start-servers.sh`
  - `systemd/local-agent-qwen.service`
- **AMD 890M 128K validated profile**
  - `docs/hardware-profiles.md`
  - `start-server-amd-128k.sh`
  - `systemd/local-agent-qwen-amd-128k.service`

These files document tested configuration families; they should not be read as the only intended deployment shapes for this project.

## Notes

This project is intentionally dependency-light: no runtime npm dependencies. The Python repo remains the more battle-tested version for now; this JS repo is the npm-module starting point.
