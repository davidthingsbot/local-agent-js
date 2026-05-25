# Hardware profiles and tuning

This document holds **machine-specific** llama.cpp launch guidance for `local-agent-js`.

Use it to preserve tested configurations without mixing hardware assumptions into the general project docs.

## How to use this file

For each hardware family, keep two things separate:

- **Facts**: hardware shape, backend, model, quant, context, slots, and exact command
- **Rationale**: why that config was chosen over nearby alternatives

When bringing up a new machine, do not start by copying another machine's conclusions. Start from the tuning workflow below and add a new section once you have measurements.

## Tuning workflow for a new machine

1. Pick the intended workload:
   - interactive single-user chat
   - local coding agent
   - multiple concurrent agent jobs
   - long-context planning / transcript-heavy workloads
2. Pick a candidate model set:
   - same model at several quants, or
   - a couple of nearby model families
3. Benchmark a small matrix:
   - quant: Q4/Q5/Q6/Q8 or equivalent
   - context: small / medium / large
   - slots: lower parallelism vs higher concurrency
   - backend: CUDA / ROCm / Vulkan / CPU as available
   - text-only vs multimodal
4. Record observed tradeoffs:
   - prompt speed
   - generation speed
   - latency to first token
   - memory/VRAM pressure
   - concurrency behavior under two or more simultaneous jobs
5. Promote only the best measured config into scripts or services.

## Tuning dimensions

### 1. Model and quant

In general:

- lower quants usually improve throughput and reduce memory pressure
- higher quants may improve quality, but can hurt tokens/sec enough to lose on real agent workloads
- for local agents, the best config is often the best **quality-per-latency** point, not the numerically largest quant

### 2. Context vs parallel slots

There is no universal best answer:

- fewer slots + larger context is better for deep planning and long transcripts
- more slots + smaller context is better for concurrent short-to-medium requests

### 3. Backend choice

Possible backends include:

- CUDA
- ROCm
- Vulkan
- CPU-only
- mixed GPU/CPU offload

Backend choice changes the optimal launch flags and sometimes the best model quant.

### 4. Text-only vs multimodal

If the primary workload is text/code agents, a text-only server may outperform a multimodal setup that loads projector weights. Keep multimodal as an explicit choice, not a hidden default.

### 5. Benchmark shape

Use short probes for quick iteration, but also run at least one realistic agent task before declaring victory.

---

## Profile: dual RTX 3090 reference setup

This is the current tested reference profile preserved from the earlier deployment.

### Intent

Optimize `local-agent-js` for a tiny local LLM agent with strong long-context capacity on a dual 3090 machine.

### Documented launch shape

- one llama.cpp server across both GPUs
- bind to `0.0.0.0:19434`
- `--ctx-size 524288`
- `-np 2`
- two simultaneous effective 256K-context slots

### Reference artifacts in this repo

- `start-servers.sh`
- `systemd/local-agent-qwen.service`

### Reference systemd command

Current unit contents are equivalent to:

```bash
CUDA_VISIBLE_DEVICES=0,1 \
/home/david/work/llama.cpp/build/bin/llama-server \
  -m /home/david/models/gguf/qwen3.6/Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf \
  --host 0.0.0.0 \
  --port 19434 \
  -ngl 99 \
  --ctx-size 524288 \
  -np 2 \
  --split-mode layer \
  --tensor-split 1,1 \
  --flash-attn on \
  -ctk q8_0 \
  -ctv q8_0 \
  --jinja \
  --temp 0.7 \
  --top-k 20 \
  --top-p 0.9 \
  --min-p 0.0 \
  --presence-penalty 0.2
```

### Operational notes

- The server is exposed on LAN/Tailscale-friendly `0.0.0.0:19434`.
- Because llama.cpp has no meaningful built-in auth here, do **not** expose it directly to the public internet.
- The helper launcher `./la.sh` can target remote hosts via `QWEN_BASE_URL=http://<model-host>:19434/v1`.

### Why keep this profile

This section exists as a preserved, tested hardware example. It is useful as:

- a reference for long-context multi-GPU tuning
- a known-good example of separating agent docs from launch-profile docs
- a baseline to compare against when adding future single-GPU or non-NVIDIA profiles

---

## Future profiles

Add future sections here as they are tested, for example:

- single high-VRAM NVIDIA GPU
- AMD iGPU/dGPU Vulkan profile
- ROCm profile
- CPU-only fallback profile
- text-only low-latency profile
- multimodal profile

Each new section should include:

- hardware summary
- workload target
- exact launch command
- benchmark notes
- tradeoffs and known limitations

---

## Profile: dw-x1pro-linux AMD 890M bring-up

This section resets the tuning story for the current machine instead of inheriting assumptions from the dual-3090 setup.

### Status

Bring-up / benchmarking phase. No preferred config is declared yet.

### Live machine facts captured at bring-up

- host: `dw-x1pro-linux`
- CPU: `AMD Ryzen AI 9 HX 370 w/ Radeon 890M`
- graphics backend currently visible to llama.cpp: Vulkan via Mesa RADV (`AMD Radeon Graphics`, `gfx1150`)
- current session-visible system RAM: about `15 GiB`
- GPU memory reported by `rocm-smi`: about `48 GiB` total VRAM, though backend selection and usable allocation must be validated by measurement

### Current live llama.cpp baseline observed before tuning

The existing server found on port `19434` at bring-up time was:

```bash
/usr/local/bin/llama-server \
  -m /home/david/models/Qwen3.5-35B-A3B-Q8_0.gguf \
  --mmproj /home/david/models/Qwen3.5-35B-A3B-mmproj-F16.gguf \
  -c 32768 \
  -ngl 999 \
  --host 0.0.0.0 \
  --port 19434
```

Observed properties:

- model: `Qwen3.5-35B-A3B-Q8_0.gguf`
- slots: `4`
- context per slot: `32768`
- multimodal / vision enabled: yes
- build info: `b8668-5d3a4a7da`

This baseline is recorded for comparison only. It is **not** the adopted tuning target.

### Available candidate local models at bring-up

- `Qwen3.5-35B-A3B-Q4_K_M.gguf` — about `19.93 GiB`
- `Qwen3.5-35B-A3B-UD-IQ4_NL.gguf` — about `16.60 GiB`
- `Qwen3.5-35B-A3B-Q8_0.gguf` — about `34.38 GiB`
- `Qwen3.6-35B-A3B-UD-Q5_K_M.gguf` — about `24.64 GiB`
- `gemma-4-26B-A4B-it-UD-Q4_K_M.gguf` — about `15.71 GiB`

### Initial tuning goal for this machine

Optimize `local-agent-js` for a tiny local LLM agent on this AMD/Vulkan machine with emphasis on:

- strong real-world agent responsiveness
- good quality-per-latency rather than maximum quant size
- explicit comparison of text-only vs multimodal serving
- measured tradeoffs among context length, concurrency, and backend behavior

### Initial benchmark matrix

Start with a small matrix before expanding:

#### Models / quants

- `Qwen3.5-35B-A3B-Q4_K_M.gguf`
- `Qwen3.5-35B-A3B-UD-IQ4_NL.gguf`
- `Qwen3.6-35B-A3B-UD-Q5_K_M.gguf`
- optional comparison: `gemma-4-26B-A4B-it-UD-Q4_K_M.gguf`

#### Server shapes

- text-only, `-np 1`, `-c 32768`
- text-only, `-np 2`, `-c 32768`
- text-only, `-np 2`, `-c 65536` if memory allows
- multimodal only if text-only baselines are already understood

#### Metrics to record

- prompt tokens/sec
- generation tokens/sec
- latency to first token or first completed short response
- whether two concurrent requests degrade sharply
- whether chat-completions behavior is stable and returns non-empty content

### Validation commands

Use these as the minimum measurement set while tuning:

```bash
# server facts
curl -s http://127.0.0.1:19434/props | jq '{model_alias,total_slots,n_ctx:.default_generation_settings.n_ctx,vision:.modalities.vision,build_info}'
curl -s http://127.0.0.1:19434/slots | jq .

# health
curl -s http://127.0.0.1:19434/health

# raw completion timing
curl -s http://127.0.0.1:19434/completion \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Reply with exactly: OK","n_predict":8,"temperature":0}'

# agent smoke
QWEN_BASE_URL=http://127.0.0.1:19434/v1 ./la.sh --no-show-thinking
```

### What not to assume

- do not assume the dual-3090 long-context strategy is correct here
- do not assume the largest quant is best for agent work
- do not assume multimodal should stay enabled by default
- do not assume Vulkan is the final winning backend without comparison data

### First text-only benchmark pass (`-np 1`, `-c 32768`)

These are early bring-up numbers, meant for relative comparison rather than final published performance claims.

#### Baseline already running before tuning

- model: `Qwen3.5-35B-A3B-Q8_0.gguf`
- shape: multimodal, `4` slots, `32768` ctx each
- raw `/completion` sample: about `37 tok/s` prompt, `23 tok/s` generation
- OpenAI chat-completions test returned empty `content` with `finish_reason=length` when `max_tokens` was too small because the model spent the budget in `reasoning_content`
- `local-agent-js` one-shot behavior was not used as the primary benchmark for this baseline

#### Candidate results

- `Qwen3.5-35B-A3B-Q4_K_M.gguf`
  - shape: text-only, `-np 1`, `-c 32768`
  - raw average: about `47.4 tok/s` prompt, `30.1 tok/s` generation
  - OpenAI chat-completions test still returned empty `content` at `max_tokens=8`, consistent with reasoning tokens consuming the response budget
  - `local-agent-js` one-shot smoke succeeded and returned `OK`

- `Qwen3.5-35B-A3B-UD-IQ4_NL.gguf`
  - shape: text-only, `-np 1`, `-c 32768`
  - raw average: about `43.3 tok/s` prompt, `26.8 tok/s` generation
  - OpenAI chat-completions test still returned empty `content` at `max_tokens=8`, consistent with reasoning tokens consuming the response budget
  - `local-agent-js` one-shot smoke succeeded and returned `OK`

- `Qwen3.6-35B-A3B-UD-Q5_K_M.gguf`
  - shape: text-only, `-np 1`, `-c 32768`
  - raw average: about `37.4 tok/s` prompt, `23.1 tok/s` generation
  - OpenAI chat-completions test still returned empty `content` at `max_tokens=8`, consistent with reasoning tokens consuming the response budget
  - `local-agent-js` one-shot smoke succeeded and returned `OK`

#### Early conclusion from first pass

For this machine and this initial Vulkan-backed pass, `Qwen3.5-35B-A3B-Q4_K_M.gguf` is the strongest first candidate among the tested text-only shapes.

It beat the other tested candidates on both prompt and generation speed, and it also outperformed the previously running `Q8_0` multimodal baseline.

#### Immediate next experiments

1. Re-run the current winner (`Qwen3.5-35B-A3B-Q4_K_M.gguf`) at `-np 2`.
2. Try `-c 65536` on the current winner if memory remains healthy.
3. Decide whether production callers should suppress reasoning by default or simply allocate a larger `max_tokens` budget for chat-completions.
4. Only after a solid text-only winner exists, test whether multimodal is worth the extra cost on this machine.

### Second pass on the current winner (`Qwen3.5-35B-A3B-Q4_K_M.gguf`)

#### `-np 2`, `-c 32768`

Observed behavior:

- raw single-request average: about `42.9 tok/s` prompt, `30.3 tok/s` generation
- `/slots` reported `2` slots with `16384` ctx each
- two concurrent requests completed successfully, but prompt throughput per request dropped sharply during concurrency
- generation under concurrency remained usable, but this shape effectively split the available context budget across slots

Interpretation:

- in this build, `-c 32768 -np 2` behaved like a **shared total context** split across two slots
- this means it is not the right way to preserve `32K` per slot on this machine

#### `-np 2`, `-c 65536`

Observed behavior:

- raw single-request average: about `48.7 tok/s` prompt, `30.8 tok/s` generation
- `/slots` reported `2` slots with `32768` ctx each
- `local-agent-js` one-shot smoke succeeded and returned `OK`

Interpretation:

- if the goal is **two 32K slots**, `-np 2 -c 65536` is the correct shape among the configurations tested so far
- this shape preserved the strong performance of the `Q4_K_M` winner while restoring `32768` ctx per slot

#### Updated provisional recommendation

Current best tested direction on this machine:

```bash
/usr/local/bin/llama-server \
  -m /home/david/models/Qwen3.5-35B-A3B-Q4_K_M.gguf \
  --host 127.0.0.1 \
  --port 19435 \
  -ngl 999 \
  -c 65536 \
  -np 2
```

This is a **provisional benchmark winner**, not yet the final production recommendation. One remaining product decision is whether the main service should suppress reasoning by default, or instead keep reasoning enabled and budget enough `max_tokens` for both `reasoning_content` and final `content`.

### Large-context feasibility check

Objective asked: at least `128K` context. With the current best candidate model (`Qwen3.5-35B-A3B-Q4_K_M.gguf`), the answer is **yes, technically possible** on this machine.

#### `-np 1`, `-c 131072`

Observed behavior:

- server started successfully
- `/slots` reported `1` slot with `131072` ctx
- raw probe remained usable at about `38.3 tok/s` prompt and `29.1 tok/s` generation
- VRAM usage rose to roughly `51.27 / 51.54 GB`
- system memory pressure increased materially during the test

Interpretation:

- a single `128K` slot is feasible
- performance remains surprisingly close to the smaller-context baseline
- memory headroom is much tighter than at `32K` or `64K`

#### `-np 2`, `-c 262144`

Observed behavior:

- server started successfully
- `/slots` reported `2` slots with `131072` ctx each
- VRAM usage rose to roughly `51.15 / 51.54 GB`
- swap usage became extremely high during the test

Interpretation:

- **two 128K slots are also technically possible**
- however, this configuration runs very close to the machine's memory limits and should be treated as risky until tested under longer real workloads

#### `-np 1`, `-c 262144`

Observed behavior:

- server started successfully
- `/slots` reported `1` slot with `262144` ctx
- raw probe remained usable at about `41.3 tok/s` prompt and `29.2 tok/s` generation
- VRAM usage again sat near the top of available capacity
- swap was effectively saturated during the test

Interpretation:

- a single `256K` slot is also technically possible
- but this is a near-the-edge configuration on this machine, not a comfortable default

#### Large-context conclusion

If the real objective is **"128K at least"**, then yes — this machine can do it with the tested `Q4_K_M` model.

Best current framing:

- **safe-ish large-context candidate:** `-np 1 -c 131072`
- **higher-risk long-context candidate:** `-np 2 -c 262144` for two 128K slots
- **edge-of-capacity candidate:** `-np 1 -c 262144` for one 256K slot

### Reference artifacts for the current preferred large-context shape

- launcher: `start-server-amd-128k.sh`
- systemd unit: `systemd/local-agent-qwen-amd-128k.service`

Before adopting any of these as the main service, the next validation should be a realistic long agent task rather than only short probes, because the machine is operating close to memory limits at these larger context sizes.

### Long agent-task validation on the preferred 128K shape

A realistic `local-agent-js` one-shot validation was run against the active `128K` service shape.

Task summary:

- read `README.md`, `AGENTS.md`, `HISTORY.md`, `start-server-amd-128k.sh`, `systemd/local-agent-qwen-amd-128k.service`, and `docs/hardware-profiles.md`
- write `amd-128k-validation-report.md`
- return a final summary

Observed outcome:

- task completed successfully
- output file created: `amd-128k-validation-report.md`
- server remained healthy after the run
- post-task memory state stayed acceptable for continued operation, though swap remained in use from earlier large-context experiments

Interpretation:

- the preferred `-np 1 -c 131072` shape is not only able to answer short probes, but also handled a real multi-file documentation task end-to-end via `local-agent-js`
- this is a meaningful confidence boost for using the 128K profile as the next practical default on this machine
