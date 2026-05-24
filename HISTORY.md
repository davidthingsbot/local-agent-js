# HISTORY.md — local-agent-js

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
