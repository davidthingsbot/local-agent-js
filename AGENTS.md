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
- Remote model endpoint override: `QWEN_BASE_URL=http://<model-host>:19434/v1`

## Documentation policy

Keep documentation split into two layers:

1. **General docs** — agent features, runtime behavior, CLI usage, safety notes, and tuning methodology that applies across machines.
2. **Hardware-profile docs** — commands, models, slot counts, context sizes, backends, and systemd/service examples that are tied to a particular machine or GPU layout.

Do **not** present one machine's launch command as the universal preferred default unless the docs explicitly say it is hardware-specific.

Current layout:

- `README.md` — general project overview and usage
- `docs/hardware-profiles.md` — tested hardware-specific tuning notes
- `start-servers.sh` — dual-3090 reference launch script
- `systemd/local-agent-qwen.service` — dual-3090 reference systemd unit
- `start-server-amd-128k.sh` — AMD 890M 128K reference launch script
- `systemd/local-agent-qwen-amd-128k.service` — AMD 890M 128K reference systemd unit

## Current reference hardware profiles

The repo currently preserves multiple tested hardware-profile families.

- **dual RTX 3090 reference setup** — historical multi-GPU long-context reference
- **AMD 890M 128K setup** — validated single-slot large-context reference for this machine

Treat these as examples of tested configuration families, not as a promise that every machine should use the same flags.

If you add support for another machine, document it as a separate hardware section instead of overwriting the reference story.

## Tuning expectations

When improving model performance on a machine, capture:

- model and quant used
- backend used (CUDA, ROCm, Vulkan, CPU, mixed)
- context size and slot count
- whether the server is text-only or multimodal
- why the chosen config beats nearby alternatives
- the exact validation commands used

Prefer measured claims over assumptions.

## Validation / development gates

Before claiming code changes are good, run:

```bash
npm test
node --check src/agent.js
```

For model-facing changes, also run a one-shot smoke task against local Qwen with `--no-show-thinking`.
