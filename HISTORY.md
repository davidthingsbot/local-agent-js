# HISTORY.md — local-agent-js

## 2026-05-26 — Split general docs from hardware-specific tuning docs

Reorganized the documentation so the repo no longer implies that the dual-3090 setup is the universal preferred deployment.

Changes:

- `README.md` now focuses on general project features, runtime, usage, and tuning methodology.
- Added `docs/hardware-profiles.md` for machine-specific llama.cpp launch guidance.
- `AGENTS.md` now instructs contributors to keep general docs separate from hardware-profile docs.
- `start-servers.sh` is labeled as a dual-3090 reference launcher.
- `systemd/local-agent-qwen.service` is labeled as a dual-3090 reference unit.

Intent:

- preserve the tested dual-3090 setup
- make room for future machine-specific tuning sections
- avoid carrying old hardware assumptions into new tuning work

## 2026-05-24 — Initial JavaScript translation

David asked for a sibling directory to `local-agent-py` with the suffix `js` instead of `py`, translated into JavaScript so it can become an npm module.

Created `~/work/local-agent-js` as a dependency-light Node package:

- CLI entry: `bin/local-agent-js.js`
- Main implementation: `src/agent.js`
- npm package metadata: `package.json`
- Convenience launcher: `la.sh`
- Tests: `test/basic.test.js`
- Runtime docs: `README.md`
- Server scripts/templates copied from Python repo: `start-servers.sh`, `systemd/local-agent-qwen.service`

Ported core Python harness behavior:

- OpenAI-compatible chat-completions loop via built-in `fetch`
- Tool calling: `list_dir`, `read_file`, `write_file`, `run_shell`
- Sandbox writes and optional `--write-dir`
- Blocking/background subagents
- Transcript persistence and REPL resume
- Compaction summaries with pinned original request/open outputs
- Empty-response watchdog with four retries
- REPL commands: `/jobs`, `/clear-jobs`, `/context`, `/compact`, `/dirs`, `/capabilities`, `/reset`

Validation:

- `npm test` passed: 5/5 tests.
- One-shot smoke against local Qwen service succeeded: listed `~/work/la-test`, wrote `~/work/la-test/js_smoke.md`, and returned a final summary.

Known status: Python remains more battle-tested; JS is now a working npm-module starting point.

## 2026-05-24 — Bind Qwen server to all interfaces

David asked to allow running the JS agent on a different machine from the model host. Updated server startup docs/templates to bind llama.cpp to `0.0.0.0:19434` instead of `127.0.0.1:19434`.

Changes:

- `start-servers.sh` uses `--host 0.0.0.0` in default and split-server modes.
- `systemd/local-agent-qwen.service` uses `--host 0.0.0.0`.
- `la.sh` derives its health check from `QWEN_BASE_URL`, so remote clients can run with `QWEN_BASE_URL=http://<model-host>:19434/v1 ./la.sh`.
- README/AGENTS document remote usage and warn not to expose unauthenticated llama.cpp publicly.

Operational note: a previous Tailscale Serve TCP forward on `19434 -> 127.0.0.1:19434` conflicted with true `0.0.0.0:19434` binding. Removed only that TCP forward; the HTTPS Tailscale Serve route to `127.0.0.1:18789` remains.
