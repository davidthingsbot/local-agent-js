# AGENTS.md — local-agent-js

This repo is the JavaScript/Node translation of `~/work/local-agent-py`.

## Goal

Keep this package suitable for publishing or linking as an npm CLI/module. Prefer no runtime dependencies unless they clearly improve maintainability.

## Runtime

- Node 20+ required; Node 22 used on David's machine.
- CLI entry: `bin/local-agent-js.js`
- Main module: `src/agent.js`
- Local launcher: `./la.sh`
- Default model endpoint: `http://127.0.0.1:19434/v1`

## Preferred model service

Use the same preferred Qwen service as `local-agent-py`: one llama.cpp server across both RTX 3090s, configured as `--ctx-size 524288 -np 2`, yielding two simultaneous 256K-context slots.

Check it with:

```bash
systemctl --user status local-agent-qwen.service
curl -s http://127.0.0.1:19434/props | jq '.total_slots, .default_generation_settings.n_ctx'
```

## Development gates

Before claiming changes are good, run:

```bash
npm test
node --check src/agent.js
```

For model-facing changes, also run a one-shot smoke task against local Qwen with `--no-show-thinking`.
