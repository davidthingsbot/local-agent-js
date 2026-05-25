# AMD 128K Validation Report

**Machine:** dw-x1pro-linux (AMD Ryzen AI 9 HX 370 w/ Radeon 890M)  
**Profile:** AMD 890M 128K  
**Date:** 2026-05-26  
**Status:** Benchmarking complete, 128K slot validated as feasible

---

## 1. Purpose of the AMD 128K Profile

The AMD 128K profile was created to explore **strong long-context capacity** on the dw-x1pro-linux machine, which uses an AMD Ryzen AI 9 HX 370 CPU with Radeon 890M integrated graphics.

**Key objectives:**
- Validate whether a **single 128K context slot** is feasible on this hardware
- Establish a baseline for long-context agent workloads on an AMD/Vulkan platform
- Preserve tested configurations separate from the dual-3090 reference setup
- Demonstrate that 128K context is achievable without inheriting NVIDIA-specific assumptions

The profile intentionally **resets the tuning story** for this machine rather than copying the dual-3090 long-context strategy, acknowledging that AMD/Vulkan backends have different characteristics.

---

## 2. Launch and Service Artifacts

### Reference Launcher Script
**File:** `start-server-amd-128k.sh`

Default shape:
```bash
#!/usr/bin/env bash
# AMD 128K mode: one text-only Qwen server with a single 128K slot
LLAMA_SERVER="${LLAMA_SERVER:-/usr/local/bin/llama-server}"
MODEL="${MODEL:-$HOME/models/Qwen3.5-35B-A3B-Q4_K_M.gguf}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-19434}"
CTX_SIZE="${CTX_SIZE:-131072}"
PARALLEL_SLOTS="${PARALLEL_SLOTS:-1}"

/usr/local/bin/llama-server \
  -m "$MODEL" \
  --host "$HOST" \
  --port "$PORT" \
  -ngl 999 \
  -c "$CTX_SIZE" \
  -np "$PARALLEL_SLOTS"
```

**Key features:**
- Single 128K slot by default (memory envelope safety)
- Environment-variable configurable model, host, port, context, slots
- Health check with 240-second timeout
- Log path: `/tmp/local-agent-amd-128k.log`
- Auto-stops existing server on the target port before starting

### Reference systemd Service
**File:** `systemd/local-agent-qwen-amd-128k.service`

```ini
[Unit]
Description=Local Agent Qwen AMD 890M 128K reference llama-server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/llama-server -m /home/david/models/Qwen3.5-35B-A3B-Q4_K_M.gguf --host 0.0.0.0 --port 19434 -ngl 999 -c 131072 -np 1
Restart=always
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

**Key features:**
- Runs as a persistent service
- Restart-on-failure with 5-second delay
- Binds to `0.0.0.0:19434` for LAN/Tailscale access
- Hard-coded model path (should be adjusted per deployment)

### Model Used
- **Qwen3.5-35B-A3B-Q4_K_M.gguf** (~19.93 GiB)
- Selected as the best quality-per-latency candidate from benchmarking

---

## 3. Documented Benchmark Conclusions

### First Benchmark Pass (Text-Only, -np 1, -c 32768)

| Model | Prompt tok/s | Generation tok/s | Notes |
|-------|--------------|------------------|-------|
| Qwen3.5-35B-A3B-Q4_K_M | ~47.4 | ~30.1 | **Winner** - fastest |
| Qwen3.5-35B-A3B-UD-IQ4_NL | ~43.3 | ~26.8 | Slower than Q4_K_M |
| Qwen3.6-35B-A3B-UD-Q5_K_M | ~37.4 | ~23.1 | Slowest of the three |
| Qwen3.5-35B-A3B-Q8_0 (baseline) | ~37 | ~23 | Multimodal baseline |

**Conclusion:** `Qwen3.5-35B-A3B-Q4_K_M.gguf` was the strongest candidate for text-only workloads.

### Second Pass (Concurrency Testing)

**Shape `-np 2, -c 32768`:**
- Raw: ~42.9 tok/s prompt, ~30.3 tok/s generation
- Behavior: Context budget **shared** across slots (each got 16K, not 32K)
- Verdict: Not the right way to preserve per-slot context

**Shape `-np 2, -c 65536`:**
- Raw: ~48.7 tok/s prompt, ~30.8 tok/s generation
- Behavior: Two slots with 32K ctx each
- Verdict: **Provisional winner** for concurrent 32K workloads

### Large-Context Feasibility Check

| Shape | VRAM Usage | Swap Usage | Verdict |
|-------|------------|------------|---------|
| `-np 1, -c 131072` | ~51.27/51.54 GB | Increased | **Safe-ish large-context candidate** |
| `-np 2, -c 262144` | ~51.15/51.54 GB | Extremely high | **Higher-risk** - two 128K slots |
| `-np 1, -c 262144` | Near top | Saturated | **Edge-of-capacity** - 256K single slot |

### Final Benchmark Conclusions

1. **128K context is technically feasible** on this AMD 890M machine with Q4_K_M quant.
2. **Single 128K slot (`-np 1, -c 131072`)** is the recommended safe configuration.
3. **Two 128K slots (`-np 2, -c 262144`)** is possible but runs very close to memory limits.
4. **256K single slot (`-np 1, -c 262144`)** is also feasible but near the edge of capacity.
5. Performance at 128K remains **surprisingly close** to smaller-context baselines (~38-41 tok/s prompt, ~29 tok/s generation).

### Known Limitation: Reasoning Tokens

All tested models returned **empty `content`** when `max_tokens` was set too small (e.g., 8), because the model consumes tokens for `reason_content` before the final response. This requires either:
- Suppressing reasoning by default, or
- Budgeting larger `max_tokens` to accommodate both reasoning and final content

---

## 4. Main Operational Risks and Cautions

### Memory Pressure Risks

1. **Near-capacity operation:** At 128K+ context, VRAM usage approaches 51+ GB, leaving minimal headroom.
2. **Swap saturation:** Large-context tests caused significant swap usage, which could degrade performance under sustained load.
3. **Two-slot 128K risk:** Running two 128K slots simultaneously is technically possible but should be treated as **risky** until tested under longer real workloads.

### Backend Uncertainties

1. **Vulkan as primary backend:** The current configuration uses Vulkan via Mesa RADV (`gfx1150`). This has not been compared against other backends (ROCm, CPU-only).
2. **No ROCm comparison:** AMD hardware may have ROCm support that could offer different performance characteristics.

### Security Considerations

1. **No authentication:** llama.cpp has no meaningful built-in auth; the server is exposed on `0.0.0.0:19434`.
2. **Do not expose to public internet:** The README explicitly warns against direct public exposure; use Tailscale or trusted LAN/VPN only.

### Production Readiness Gaps

1. **No realistic long-agent-task validation:** The current validation relies on short probes; a realistic long-context agent task has not yet been run.
2. **Reasoning suppression undecided:** The profile documentation notes that production callers should decide whether to suppress reasoning or budget for it.
3. **Provisional recommendation:** The `-np 1, -c 131072` configuration is labeled as a "safe-ish" candidate, not a final production recommendation.

### Hardware-Specific Constraints

1. **System RAM visibility:** Only ~15 GiB of system RAM is visible to llama.cpp, which may limit flexibility for larger context configurations.
2. **GPU memory allocation:** While `rocm-smi` reports ~48 GiB VRAM, usable allocation must be validated by measurement (backend selection matters).

---

## Summary

The AMD 128K profile successfully validated that **128K context is achievable** on the dw-x1pro-linux AMD 890M machine using the `Qwen3.5-35B-A3B-Q4_K_M.gguf` model with Vulkan backend. The recommended safe configuration is a single 128K slot (`-np 1, -c 131072`), which maintains reasonable performance (~38-41 tok/s prompt, ~29 tok/s generation) while operating near the machine's memory limits.

**Key artifacts created:**
- `start-server-amd-128k.sh` — Reference launcher script
- `systemd/local-agent-qwen-amd-128k.service` — Systemd unit for persistent service

**Next steps before production adoption:**
1. Run realistic long-context agent tasks (not just short probes)
2. Decide on reasoning suppression vs. token budgeting
3. Consider comparing against ROCm backend if available
4. Test sustained workloads to validate memory stability

---

*Report generated from README.md, AGENTS.md, HISTORY.md, start-server-amd-128k.sh, systemd/local-agent-qwen-amd-128k.service, and docs/hardware-profiles.md.*
