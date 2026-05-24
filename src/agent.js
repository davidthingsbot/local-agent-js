import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import crypto from 'node:crypto';

const DEFAULT_BASE_URL = process.env.QWEN_BASE_URL || 'http://127.0.0.1:19434/v1';
const DEFAULT_BG_BASE_URL = process.env.QWEN_BG_BASE_URL || DEFAULT_BASE_URL;
const DEFAULT_MODEL = process.env.QWEN_MODEL || 'qwen';
const DEFAULT_CWD = process.env.LOCAL_AGENT_CWD || path.join(os.homedir(), '.openclaw', 'workspace');

export const MAX_FILE_CHARS = Number.parseInt(process.env.LOCAL_AGENT_MAX_FILE_CHARS || '700000', 10);
export const MAX_OUTPUT_CHARS = Number.parseInt(process.env.LOCAL_AGENT_MAX_OUTPUT_CHARS || '240000', 10);
const COMPACT_THRESHOLD_OVERRIDE = process.env.LOCAL_AGENT_COMPACT_THRESHOLD ? Number.parseInt(process.env.LOCAL_AGENT_COMPACT_THRESHOLD, 10) : null;
export const COMPACT_THRESHOLD_RATIO = Number.parseFloat(process.env.LOCAL_AGENT_COMPACT_THRESHOLD_RATIO || '0.90');
export const COMPACT_THRESHOLD_FALLBACK = 250_000;
export const COMPACT_KEEP_LAST_GROUPS = Math.max(1, Number.parseInt(process.env.LOCAL_AGENT_COMPACT_KEEP || '8', 10));
export const COMPACT_KEEP_LAST_EXCHANGES = Math.max(1, Number.parseInt(process.env.LOCAL_AGENT_COMPACT_KEEP_EXCHANGES || '12', 10));
export const N_KEEP_TOKENS = Number.parseInt(process.env.LOCAL_AGENT_N_KEEP || '16384', 10);
export const MAX_COMPLETION_TOKENS = Number.parseInt(process.env.LOCAL_AGENT_MAX_COMPLETION_TOKENS || '8192', 10);

const COMPACT_MARKER = '\n\n# Compacted earlier conversation\n';
const INTRA_SUMMARY_MARKER = '[Earlier work in this task — summary]\n';
const PINNED_REQUEST_HEADER = '## Original request (verbatim — pinned)';
const PINNED_OUTPUTS_HEADER = '## Open outputs (files written this session)';

let WRITE_ROOTS = [];

const BLOCKED_COMMAND_PATTERNS = [
  'rm -rf', 'rm -fr', 'mkfs', 'dd if=', ':(){', 'shutdown', 'reboot', 'poweroff',
  'sudo ', 'su ', 'chmod -r 777', 'chown -r', 'curl ', 'wget ', 'scp ', 'rsync ',
  'nc ', 'ncat ', 'telnet ', 'ssh ', 'gh repo delete', 'git push', 'git clean -fdx',
];

export const DECOMPOSITION_CLAUSE = `## Task decomposition

For multi-step or hard tasks, work in bounded checkpoints instead of inspecting indefinitely.

- Start with a brief plan before tool calls when the task has multiple steps.
- After roughly ten tool calls, write or present a concise progress summary: what you have done, what is left, and any decisions made. Then wait for the user to say "continue" or redirect.
- If the task asks for an artifact, create or update it before doing another broad inspection pass.
- If you are approaching the turn budget, synthesize the best partial answer now rather than continuing to read more files.
- For write_file, prefer relative paths under the working directory unless the user explicitly asks for an absolute writable path.
`;

export const CAPABILITIES_TEXT = `# Qwen3.6 Agent Harness Capabilities

You are Qwen3.6 running in a tiny local JavaScript agent harness.

## Tools

- list_dir(path, max_entries=100): list directory contents with names, types, and sizes.
- read_file(path, max_chars=700000): read a UTF-8 text file. For deep-context tasks, request a larger max_chars value when you need the whole file.
- write_file(path, content): write a UTF-8 text file under the current agent working directory only.
- run_shell(command, timeout_seconds=20): run a conservative local shell command in the current working directory.
- ask_subagent(task, max_turns=6): delegate a bounded task to a fresh isolated Qwen subagent using the same working directory. Subagents cannot spawn further subagents.
- start_background_subagent(task, max_turns=6): start a bounded subagent task in the background and return a job id immediately.
- check_background_job(job_id): check a background subagent job and return its output if finished.
- list_background_jobs(): list known background subagent jobs.
- clear_background_jobs(): clear background job tracking records. This does not kill running child processes or delete files they created.

## Filesystem policy

- Read/list: any local path the OS user can access.
- Write: paths must resolve under cwd or one of the configured extra writable roots (see /dirs). Relative paths resolve under cwd; absolute paths are accepted only if they fall inside a writable root. .. escapes that leave every root are blocked.
- Shell: runs in cwd; obvious destructive, privileged, network, and exfiltration-ish commands are blocked by string pattern.

## Behavioral rules

- Use tools when they materially improve the answer.
- Do not claim inspection unless a tool was used or context was provided.
- Prefer read-only inspection commands.
- Do not perform destructive, network, credential, or privacy-sensitive actions.
- If blocked, state exactly what blocked you.
- End with a short final answer summarizing what you did and found.
`;

export const SYSTEM_PROMPT = `${CAPABILITIES_TEXT}\n\n${DECOMPOSITION_CLAUSE}`;

export const TOOLS = [
  { type: 'function', function: { name: 'list_dir', description: 'List directory contents with names, types, and sizes.', parameters: { type: 'object', properties: { path: { type: 'string' }, max_entries: { type: 'integer' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 text file, truncated to a safe size.', parameters: { type: 'object', properties: { path: { type: 'string' }, max_chars: { type: 'integer' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write a UTF-8 text file under the agent working directory.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run_shell', description: 'Run a safe local shell command in cwd. Read-only commands are preferred.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_seconds: { type: 'integer' } }, required: ['command'] } } },
];

const SUBAGENT_TOOL = { type: 'function', function: { name: 'ask_subagent', description: 'Delegate a bounded task to a fresh isolated Qwen subagent using the same working directory. The subagent cannot spawn further subagents.', parameters: { type: 'object', properties: { task: { type: 'string' }, max_turns: { type: 'integer' } }, required: ['task'] } } };
const BACKGROUND_SUBAGENT_TOOLS = [
  { type: 'function', function: { name: 'start_background_subagent', description: 'Start a bounded Qwen subagent task in the background using the same working directory. Returns immediately with a job id.', parameters: { type: 'object', properties: { task: { type: 'string' }, max_turns: { type: 'integer' } }, required: ['task'] } } },
  { type: 'function', function: { name: 'list_background_jobs', description: 'List known background subagent jobs and their running/finished status.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'clear_background_jobs', description: 'Clear background job tracking records. Does not kill running child processes or delete files they created.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'check_background_job', description: 'Check status/output for a background subagent job id.', parameters: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] } } },
];

function toolsFor(enableSubagents) { return enableSubagents ? [...TOOLS, SUBAGENT_TOOL, ...BACKGROUND_SUBAGENT_TOOLS] : TOOLS; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Number(n) || lo)); }
export function truncate(s, n = MAX_OUTPUT_CHARS) { s = String(s ?? ''); return s.length <= n ? s : `${s.slice(0, n)}\n\n...[truncated ${s.length - n} chars]`; }
function expandHome(p) { return p?.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p; }
export function resolvePath(cwd, p) { let out = path.resolve(path.isAbsolute(expandHome(p || '')) ? expandHome(p || '') : path.join(cwd, expandHome(p || ''))); return out; }
function pathUnderAny(target, roots) { return roots.some((r) => target === r || target.startsWith(r + path.sep)); }
function writableRoots(cwd) { return WRITE_ROOTS.length ? WRITE_ROOTS : [path.resolve(cwd)]; }
function extraWriteDirs(cwd) { const c = path.resolve(cwd); return WRITE_ROOTS.filter((r) => r !== c); }

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }
async function toolListDir(cwd, p = '.', maxEntries = 100) {
  const target = resolvePath(cwd, p);
  try {
    const st = await fsp.stat(target);
    if (!st.isDirectory()) return { error: `not a directory: ${target}` };
    const names = (await fsp.readdir(target)).sort((a, b) => a.localeCompare(b)).slice(0, clamp(maxEntries, 1, 500));
    const entries = [];
    for (const name of names) {
      const child = path.join(target, name);
      try { const cs = await fsp.stat(child); entries.push({ name, path: child, type: cs.isDirectory() ? 'dir' : 'file', size: cs.size }); }
      catch (e) { entries.push({ name, path: child, error: e.message }); }
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { path: target, entries, count: entries.length };
  } catch { return { error: `not found: ${target}` }; }
}
async function toolReadFile(cwd, p = '', maxChars = MAX_FILE_CHARS) {
  const target = resolvePath(cwd, p);
  try {
    const st = await fsp.stat(target);
    if (!st.isFile()) return { error: `not a file: ${target}` };
    const text = await fsp.readFile(target, 'utf8');
    const limit = clamp(maxChars || MAX_FILE_CHARS, 1000, MAX_FILE_CHARS);
    return { path: target, chars: text.length, content: truncate(text, limit) };
  } catch (e) { return { error: e.code === 'ENOENT' ? `not found: ${target}` : e.message }; }
}
async function toolWriteFile(cwd, p = '', content = '') {
  const target = resolvePath(cwd, p);
  const roots = writableRoots(cwd);
  if (!pathUnderAny(target, roots)) return { error: `target outside writable roots ${JSON.stringify(roots)}: ${target}` };
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, String(content), 'utf8');
  return { ok: true, path: target, chars: String(content).length };
}
function commandBlockReason(command) { const lower = String(command || '').toLowerCase().split(/\s+/).join(' '); const pat = BLOCKED_COMMAND_PATTERNS.find((p) => lower.includes(p)); return pat ? `blocked command pattern: ${pat.trim()}` : null; }
async function toolRunShell(cwd, command = '', timeoutSeconds = 20) {
  const reason = commandBlockReason(command);
  if (reason) return { error: reason, command };
  const timeout = clamp(timeoutSeconds || 20, 1, 60) * 1000;
  return await new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve(killed ? { error: `timeout after ${timeout / 1000}s`, stdout: truncate(stdout), stderr: truncate(stderr) } : { command, returncode: code, stdout: truncate(stdout), stderr: truncate(stderr) }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message, command }); });
  });
}

function thisCliPath() { return path.resolve(process.argv[1] || new URL('../bin/local-agent-js.js', import.meta.url).pathname); }
function subagentCmd(cwd, task, maxTurns = 6, thinking = true, baseUrl = DEFAULT_BG_BASE_URL) {
  const cmd = [process.execPath, thisCliPath(), '--cwd', cwd, '--max-turns', String(clamp(maxTurns, 1, 10)), '--base-url', baseUrl, '--no-show-thinking'];
  for (const d of extraWriteDirs(cwd)) cmd.push('--write-dir', d);
  if (!thinking) cmd.push('--no-thinking');
  cmd.push(task);
  return cmd;
}
function subagentEnv() { return { ...process.env, QWEN_AGENT_DISABLE_SUBAGENT: '1' }; }
async function runProcess(cmd, opts = {}) {
  return await new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', killed = false;
    const timer = opts.timeoutMs ? setTimeout(() => { killed = true; child.kill('SIGKILL'); }, opts.timeoutMs) : null;
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: killed ? 124 : code, stdout, stderr, killed }); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: 1, stdout, stderr: e.message }); });
  });
}
async function toolAskSubagent(cwd, task = '', maxTurns = 6, thinking = true, baseUrl = DEFAULT_BG_BASE_URL) {
  const r = await runProcess(subagentCmd(cwd, task, maxTurns, thinking, baseUrl), { cwd, env: subagentEnv(), timeoutMs: 180000 });
  return { ok: r.code === 0, returncode: r.code, task, stdout: truncate(r.stdout), stderr: truncate(r.stderr, 8000), ...(r.killed ? { error: 'subagent timeout after 180s' } : {}) };
}
async function jobsDir(cwd) { const d = path.join(cwd, '.qwen-agent-jobs'); await fsp.mkdir(d, { recursive: true }); return d; }
async function transcriptsDir(cwd) { const d = path.join(cwd, '.local-agent-transcripts'); await fsp.mkdir(d, { recursive: true }); return d; }
async function newTranscriptPath(cwd) { const d = await transcriptsDir(cwd); const stamp = new Date().toISOString().replace(/T/, '_').replace(/:/g, '-').replace(/\..+/, ''); return path.join(d, `transcript-${stamp}.json`); }
async function latestTranscriptPath(cwd) { const d = await transcriptsDir(cwd); const files = (await fsp.readdir(d)).filter((n) => n.startsWith('transcript-') && n.endsWith('.json')).sort(); return files.length ? path.join(d, files.at(-1)) : null; }
async function saveTranscript(file, cwd, messages) { const tmp = `${file}.tmp`; await fsp.writeFile(tmp, JSON.stringify({ version: 1, cwd, messages }, null, 2), 'utf8'); await fsp.rename(tmp, file); }
async function loadTranscript(file) { const raw = JSON.parse(await fsp.readFile(file, 'utf8')); if (Array.isArray(raw)) return raw; if (raw?.messages) return raw.messages; throw new Error(`unrecognized transcript format: ${file}`); }
async function clearBackgroundJobs(cwd) { const d = path.join(cwd, '.qwen-agent-jobs'); if (!(await exists(d))) { await fsp.mkdir(d, { recursive: true }); return 0; } const metas = await fsp.readdir(d).catch(() => []); await fsp.rm(d, { recursive: true, force: true }); await fsp.mkdir(d, { recursive: true }); return metas.length; }
async function toolStartBackgroundSubagent(cwd, task = '', maxTurns = 6, thinking = true, baseUrl = DEFAULT_BG_BASE_URL) {
  const jobId = `job-${Date.now()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const jd = path.join(await jobsDir(cwd), jobId); await fsp.mkdir(jd, { recursive: true });
  const stdoutPath = path.join(jd, 'stdout.txt'), stderrPath = path.join(jd, 'stderr.txt'), exitPath = path.join(jd, 'exitcode.txt'), metaPath = path.join(jd, 'meta.json');
  const cmd = subagentCmd(cwd, task, maxTurns, thinking, baseUrl);
  const script = `${cmd.map(shellQuote).join(' ')} > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}; echo $? > ${shellQuote(exitPath)}`;
  const child = spawn('/bin/bash', ['-lc', script], { cwd, env: subagentEnv(), detached: true, stdio: 'ignore' }); child.unref();
  const meta = { job_id: jobId, pid: child.pid, task, cmd, started: Date.now() / 1000, stdout: stdoutPath, stderr: stderrPath, exitcode: exitPath };
  await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  return { ok: true, job_id: jobId, pid: child.pid, task, status: 'running', job_dir: jd };
}
function shellQuote(s) { return `'${String(s).replaceAll("'", `'\\''`)}'`; }
async function toolCheckBackgroundJob(cwd, jobId = '') {
  const jd = path.join(await jobsDir(cwd), jobId); const metaPath = path.join(jd, 'meta.json');
  if (!(await exists(metaPath))) return { ok: false, error: `unknown job_id: ${jobId}` };
  const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  if (await exists(meta.exitcode)) {
    const codeRaw = (await fsp.readFile(meta.exitcode, 'utf8')).trim(); const code = /^\d+$/.test(codeRaw) ? Number(codeRaw) : codeRaw;
    const stdout = await fsp.readFile(meta.stdout, 'utf8').catch(() => ''); const stderr = await fsp.readFile(meta.stderr, 'utf8').catch(() => '');
    return { ok: code === 0, job_id: jobId, status: 'finished', returncode: code, task: meta.task, stdout: truncate(stdout), stderr: truncate(stderr, 8000) };
  }
  return { ok: true, job_id: jobId, status: 'running', pid: meta.pid, task: meta.task };
}
async function listBackgroundJobs(cwd) { const d = await jobsDir(cwd); const rows = []; for (const name of (await fsp.readdir(d))) { const metaPath = path.join(d, name, 'meta.json'); try { const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8')); rows.push({ job_id: meta.job_id, status: (await exists(meta.exitcode)) ? 'finished' : 'running', pid: meta.pid, task: meta.task, started: meta.started }); } catch (e) { /* ignore non-job entries */ } } return rows; }
async function toolListBackgroundJobs(cwd) { const jobs = await listBackgroundJobs(cwd); return { ok: true, jobs, count: jobs.length }; }

async function executeTool(cwd, name, args = {}, thinking = true) {
  if (name === 'list_dir') return toolListDir(cwd, args.path || '.', args.max_entries || 100);
  if (name === 'read_file') return toolReadFile(cwd, args.path || '', args.max_chars || MAX_FILE_CHARS);
  if (name === 'write_file') return toolWriteFile(cwd, args.path || '', args.content || '');
  if (name === 'run_shell') return toolRunShell(cwd, args.command || '', args.timeout_seconds || 20);
  if (name === 'ask_subagent') { if (process.env.QWEN_AGENT_DISABLE_SUBAGENT === '1') return { error: 'subagents disabled inside subagent' }; return toolAskSubagent(cwd, args.task || '', args.max_turns || 6, thinking, DEFAULT_BG_BASE_URL); }
  if (name === 'start_background_subagent') { if (process.env.QWEN_AGENT_DISABLE_SUBAGENT === '1') return { error: 'background subagents disabled inside subagent' }; return toolStartBackgroundSubagent(cwd, args.task || '', args.max_turns || 6, thinking, DEFAULT_BG_BASE_URL); }
  if (name === 'check_background_job') return toolCheckBackgroundJob(cwd, args.job_id || '');
  if (name === 'list_background_jobs') return toolListBackgroundJobs(cwd);
  if (name === 'clear_background_jobs') return { ok: true, cleared: await clearBackgroundJobs(cwd) };
  return { error: `unknown tool: ${name}` };
}

function normalizeAssistantMessage(msg) { const d = { role: 'assistant', content: msg.content || '' }; if (msg.tool_calls) d.tool_calls = msg.tool_calls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function?.name, arguments: tc.function?.arguments || '{}' } })); return d; }
function splitGroups(messages) { const head = [], groups = []; let cur = []; for (const m of messages) { if (!groups.length && !cur.length && m.role === 'system') { head.push(m); continue; } if (m.role === 'user') { if (cur.length) groups.push(cur); cur = [m]; } else cur.push(m); } if (cur.length) groups.push(cur); return [head, groups]; }
function renderGroupsForSummary(groups) { const out = []; for (const g of groups) for (const m of g) { const content = (m.content || '').trim(); if (m.role === 'user') out.push(`USER: ${truncate(content, 4000)}`); else if (m.role === 'assistant') { if (content) out.push(`ASSISTANT: ${truncate(content, 4000)}`); for (const tc of m.tool_calls || []) out.push(`ASSISTANT calls ${tc.function?.name || '?'}(${truncate(tc.function?.arguments || '', 600)})`); } else if (m.role === 'tool') out.push(`TOOL: ${truncate(content, 1500)}`); } return out.join('\n'); }
const SUMMARIZER_SYSTEM = `You compress agent transcripts. Produce a concise operational summary so the agent can continue without losing essential context.

Preserve files read/written, commands/outcomes, decisions, errors, current incomplete state. Drop verbose output and repetition.

Hard rules: Do NOT output an Original request section or Open outputs section. Do NOT declare completion unless user explicitly confirmed completion.

Output sections: ## Files touched; ## Key actions and findings; ## Current state (what is incomplete and what should happen next)`;
async function chatCompletion(baseUrl, body) { const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`; const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer local-not-needed' }, body: JSON.stringify(body) }); if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`); return await res.json(); }
async function summarizeViaBg(text, bgBaseUrl, model, priorSummary = null) { let user = priorSummary ? `Prior summary (incorporate and update):\n${priorSummary}\n\n` : ''; user += `New transcript to incorporate:\n${text}`; const resp = await chatCompletion(bgBaseUrl, { model, messages: [{ role: 'system', content: SUMMARIZER_SYSTEM }, { role: 'user', content: user }], temperature: 0.3, extra_body: { chat_template_kwargs: { enable_thinking: false } } }); return (resp.choices?.[0]?.message?.content || '').trim(); }
function splitGroupIntoExchanges(group) { if (!group.length || group[0].role !== 'user') return [null, []]; const user = group[0], ex = []; let cur = []; for (const m of group.slice(1)) { if (m.role === 'assistant') { if (cur.length) ex.push(cur); cur = [m]; } else cur.push(m); } if (cur.length) ex.push(cur); return [user, ex]; }
function renderExchangesForSummary(exchanges) { return renderGroupsForSummary([exchanges.flat()]).replace(/^USER:.*\n?/gm, ''); }
function firstUserText(groups) { for (const g of groups) for (const m of g) if (m.role === 'user') return (m.content || '').trim() || null; return null; }
function splitPinnedBlocks(priorSummary = '') { const lines = priorSummary.split(/\r?\n/); const orig = [], residual = []; let mode = 'other'; for (const line of lines) { const stripped = line.trim(); if (stripped === PINNED_REQUEST_HEADER) { mode = 'orig'; orig.push(line); continue; } if (stripped === PINNED_OUTPUTS_HEADER) { mode = 'outputs'; continue; } if (line.startsWith('## ')) { mode = 'other'; residual.push(line); continue; } if (mode === 'orig') orig.push(line); else if (mode !== 'outputs') residual.push(line); } return [orig.length ? orig.join('\n').trim() : null, residual.join('\n').trim()]; }
function formatOpenOutputsBlock(openOutputs) { if (!openOutputs || !Object.keys(openOutputs).length) return null; return [PINNED_OUTPUTS_HEADER, ...Object.entries(openOutputs).sort().map(([p, chars]) => `- ${p} (last write: ${chars} chars)`)].join('\n'); }
function composePinnedSummary(orig, outputs, body) { return [orig, outputs, (body || '').trim()].filter(Boolean).join('\n\n'); }
async function compactInterGroup(head, groups, bgBaseUrl, model, keepLastGroups, verbose, openOutputs) { if (groups.length <= keepLastGroups + 1) return [head, groups, false, `only ${groups.length} group(s)`]; const toSummarize = groups.slice(0, -keepLastGroups), keepTail = groups.slice(-keepLastGroups); const sys = head[0]; let baseSys = sys.content || '', prior = null; if (baseSys.includes(COMPACT_MARKER)) [baseSys, prior] = baseSys.split(COMPACT_MARKER, 2); let [orig, residual] = prior ? splitPinnedBlocks(prior) : [null, null]; if (!orig) { const first = firstUserText(toSummarize); if (first) orig = `${PINNED_REQUEST_HEADER}\n${first}`; } const transcript = renderGroupsForSummary(toSummarize); if (verbose) console.error(`[compact-inter] summarizing ${toSummarize.length} group(s), ~${transcript.length} chars`); try { const body = await summarizeViaBg(transcript, bgBaseUrl, model, residual); const summary = composePinnedSummary(orig, formatOpenOutputsBlock(openOutputs), body); return [[{ ...sys, content: `${baseSys.trimEnd()}${COMPACT_MARKER}${summary}` }, ...head.slice(1)], keepTail, true, `compacted ${toSummarize.length} group(s) into ${summary.length} chars`]; } catch (e) { return [head, groups, false, `inter-group summarize failed: ${e.message}`]; } }
async function compactIntraGroup(group, bgBaseUrl, model, keepLastExchanges, verbose) { let [user, exchanges] = splitGroupIntoExchanges(group); if (!user) return [group, false, 'active group not user-bounded']; let prior = null; if (exchanges.length === 1 && exchanges[0][0]?.role === 'assistant' && (exchanges[0][0].content || '').startsWith(INTRA_SUMMARY_MARKER)) { prior = exchanges[0][0].content.slice(INTRA_SUMMARY_MARKER.length); exchanges = exchanges.slice(1); } if (exchanges.length <= keepLastExchanges + 1) return [group, false, `active group has ${exchanges.length} exchange(s) after prior summary`]; const toSummarize = exchanges.slice(0, -keepLastExchanges), keepTail = exchanges.slice(-keepLastExchanges); const text = renderExchangesForSummary(toSummarize); if (verbose) console.error(`[compact-intra] summarizing ${toSummarize.length} exchange(s), ~${text.length} chars`); try { const summary = await summarizeViaBg(text, bgBaseUrl, model, prior); return [[user, { role: 'assistant', content: INTRA_SUMMARY_MARKER + summary }, ...keepTail.flat()], true, `compacted ${toSummarize.length} exchange(s) into ${summary.length} chars`]; } catch (e) { return [group, false, `intra-group summarize failed: ${e.message}`]; } }
export async function compactMessages(messages, bgBaseUrl, model, keepLastGroups = COMPACT_KEEP_LAST_GROUPS, keepLastExchanges = COMPACT_KEEP_LAST_EXCHANGES, verbose = false, openOutputs = null) { let [head, groups] = splitGroups(messages); if (!head.length) return [messages, false, 'no system message; refusing to compact']; const notes = []; let didAny = false; let didInter, noteInter; [head, groups, didInter, noteInter] = await compactInterGroup(head, groups, bgBaseUrl, model, keepLastGroups, verbose, openOutputs); if (didInter) { notes.push(`inter-group: ${noteInter}`); didAny = true; } if (groups.length) { let newActive, didIntra, noteIntra; [newActive, didIntra, noteIntra] = await compactIntraGroup(groups.at(-1), bgBaseUrl, model, keepLastExchanges, verbose); if (didIntra) { groups[groups.length - 1] = newActive; notes.push(`intra-group: ${noteIntra}`); didAny = true; } }
  if (!didAny) return [messages, false, `nothing to compact (${noteInter})`]; return [[...head, ...groups.flat()], true, notes.join('; ')]; }

const EMPTY_RETRY_NUDGE = 'Your previous turn produced reasoning but no tool call and no final answer. Either call a tool to make progress on the task, or write a brief final response now.';
const EMPTY_RETRY_NUDGE_GENERIC = 'Your previous turn was empty: no tool call and no final answer. Continue the original task now. If you need more information, call a tool. If the task is complete, write a concise final answer.';
const EMPTY_AFTER_COMPACT_NUDGE = 'The conversation was just compacted. The pinned original request and any open outputs in the system message are authoritative. Continue from that state now: call exactly one tool to make concrete progress, or write a concise final answer if no tool is needed.';

async function makeRequest(baseUrl, messages, model, tools, temperature, topP, thinking, stats) { const resp = await chatCompletion(baseUrl, { model, messages, tools, tool_choice: 'auto', temperature, top_p: topP, max_tokens: MAX_COMPLETION_TOKENS, extra_body: { top_k: 20, n_keep: N_KEEP_TOKENS, chat_template_kwargs: { enable_thinking: thinking } } }); const u = resp.usage || {}; if (u.prompt_tokens != null) stats.last_prompt_tokens = Number(u.prompt_tokens); if (u.completion_tokens != null) stats.last_completion_tokens = Number(u.completion_tokens); return resp.choices?.[0]?.message || { role: 'assistant', content: '' }; }
export async function runLoop(baseUrl, messages, cwd, maxTurns, verbose, model, temperature, topP, thinking, showThinking, stats = {}, bgBaseUrl = DEFAULT_BG_BASE_URL) { let turn = 0, justCompacted = false; while (true) { turn++; if (maxTurns && turn > maxTurns) return [2, `[blocked] max turns reached (${maxTurns})`]; const lastPt = Number(stats.last_prompt_tokens || 0), threshold = Number(stats.compact_threshold || COMPACT_THRESHOLD_FALLBACK); if (lastPt > threshold) { const [newMessages, did, note] = await compactMessages(messages, bgBaseUrl, model, COMPACT_KEEP_LAST_GROUPS, COMPACT_KEEP_LAST_EXCHANGES, verbose, stats.open_outputs); if (did) { messages.splice(0, messages.length, ...newMessages); stats.last_prompt_tokens = 0; stats.compactions = Number(stats.compactions || 0) + 1; if (note.includes('inter-group:')) stats.inter_compactions = Number(stats.inter_compactions || 0) + 1; if (note.includes('intra-group:')) stats.intra_compactions = Number(stats.intra_compactions || 0) + 1; stats.last_compact_at_turn = turn; justCompacted = true; console.error(`[compact] ${note}`); } else if (verbose) console.error(`[compact] skipped: ${note}`); }
    if (verbose) console.error(`\n=== TURN ${turn} ===`);
    const tools = toolsFor(process.env.QWEN_AGENT_DISABLE_SUBAGENT !== '1');
    let msg = await makeRequest(baseUrl, messages, model, tools, temperature, topP, thinking, stats);
    let emptyAttempts = 0; const maxEmptyRetries = 4;
    while (!(msg.tool_calls?.length) && !(msg.content || '').trim() && emptyAttempts < maxEmptyRetries) { emptyAttempts++; const reasoning = msg.reasoning_content; const nudge = reasoning ? EMPTY_RETRY_NUDGE : justCompacted ? EMPTY_AFTER_COMPACT_NUDGE : EMPTY_RETRY_NUDGE_GENERIC; const why = reasoning ? 'after thinking' : justCompacted ? 'after compaction' : 'with no reasoning'; const retryThinking = emptyAttempts === maxEmptyRetries; console.error(`[watchdog] empty response ${why}; retry ${emptyAttempts}/${maxEmptyRetries} with ${retryThinking ? 'thinking on' : 'thinking off'}`); messages.push({ role: 'user', content: nudge }); stats.empty_retries = Number(stats.empty_retries || 0) + 1; msg = await makeRequest(baseUrl, messages, model, tools, retryThinking ? 0.1 : Math.min(temperature, 0.2), retryThinking ? 0.7 : Math.min(topP, 0.8), retryThinking, stats); }
    justCompacted = false; messages.push(normalizeAssistantMessage(msg));
    if (showThinking && msg.reasoning_content) console.error(`\n[thinking]\n${msg.reasoning_content.trim()}\n[/thinking]`);
    if (verbose && msg.tool_calls?.length && (msg.content || '').trim()) console.error(msg.content.trim());
    if (!(msg.tool_calls?.length)) { const final = (msg.content || '').trim(); return final ? [0, final] : [3, '[empty response — model produced no tool call and no final answer; try /compact or rephrase]']; }
    for (const tc of msg.tool_calls) { let args = {}; try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; } const name = tc.function?.name; const result = await executeTool(cwd, name, args, thinking); if (name === 'write_file' && result?.ok) { stats.open_outputs ||= {}; stats.open_outputs[result.path] = Number(result.chars || 0); } if (verbose) { console.error(`[tool] ${name}(${JSON.stringify(args)})`); console.error(`[result] ${truncate(JSON.stringify(result), 2000)}`); } messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) }); if (name === 'start_background_subagent') return result.ok ? [0, `Started background subagent \`${result.job_id}\`. Use /jobs or ask me to check \`${result.job_id}\` when you want the result.`] : [1, `Failed to start background subagent: ${JSON.stringify(result)}`]; }
  } }
export function initialMessages(cwd) { return [{ role: 'system', content: `${SYSTEM_PROMPT}\nWorking directory: ${cwd}` }]; }
async function queryServerNCtx(baseUrl) { try { let root = baseUrl.replace(/\/$/, ''); if (root.endsWith('/v1')) root = root.slice(0, -3); const res = await fetch(`${root}/props`, { signal: AbortSignal.timeout(3000) }); if (!res.ok) return null; const data = await res.json(); const n = data.default_generation_settings?.n_ctx; return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; } }
export async function computeCompactThreshold(baseUrl) { if (COMPACT_THRESHOLD_OVERRIDE != null) return [COMPACT_THRESHOLD_OVERRIDE, `env LOCAL_AGENT_COMPACT_THRESHOLD=${COMPACT_THRESHOLD_OVERRIDE}`]; const nCtx = await queryServerNCtx(baseUrl); if (nCtx) return [Math.trunc(nCtx * COMPACT_THRESHOLD_RATIO), `${COMPACT_THRESHOLD_RATIO} * server n_ctx=${nCtx}`]; return [COMPACT_THRESHOLD_FALLBACK, `fallback (server /props unreachable at ${baseUrl})`]; }
export function estimatePromptTokens(messages) { let chars = 0; for (const m of messages) { chars += String(m.content || '').length + String(m.reasoning_content || '').length; for (const tc of m.tool_calls || []) chars += String(tc.function?.arguments || '').length + String(tc.function?.name || '').length; } return Math.trunc(chars / 3); }
function stripReasoningContent(messages) { let n = 0; for (const m of messages) if ('reasoning_content' in m) { delete m.reasoning_content; n++; } return n; }
function directoryPolicyText(cwd) { return `# Directory access policy\n\n## Writable directories\n\n${writableRoots(cwd).map((r) => `- ${r}`).join('\n')}\n\nRelative paths resolve under cwd. Absolute write paths are accepted only if they resolve inside one of these roots.\n\n## Readable directories\n\nThe harness currently permits read/list attempts for any local path accessible to the OS user. Write access is sandboxed.`; }
async function runAgent(task, cwd, maxTurns, verbose, baseUrl, model, temperature, topP, thinking, showThinking, bgBaseUrl = DEFAULT_BG_BASE_URL) { const messages = initialMessages(cwd); messages.push({ role: 'user', content: task }); const transcript = await newTranscriptPath(cwd); await saveTranscript(transcript, cwd, messages); if (verbose) console.error(`transcript: ${transcript}`); const [threshold, source] = await computeCompactThreshold(baseUrl); const stats = { compact_threshold: threshold, compact_threshold_source: source }; const [code, final] = await runLoop(baseUrl, messages, cwd, maxTurns, verbose, model, temperature, topP, thinking, showThinking, stats, bgBaseUrl); await saveTranscript(transcript, cwd, messages); console.log(final); return code; }
function backgroundJobsText(jobs) { return `Background jobs:\n${jobs.length ? jobs.map((j) => `- ${j.job_id} [${j.status}] pid=${j.pid} task=${j.task}`).join('\n') : '(none)'}`; }
async function runRepl(cwd, maxTurns, verbose, baseUrl, model, temperature, topP, thinking, showThinking, clearJobsOnStart, bgBaseUrl = DEFAULT_BG_BASE_URL) { const [threshold, thresholdSrc] = await computeCompactThreshold(baseUrl); const stats = { compact_threshold: threshold, compact_threshold_source: thresholdSrc }; console.log(`compact threshold: ${threshold} prompt-tokens (${thresholdSrc}); n_keep=${N_KEEP_TOKENS}`); if (clearJobsOnStart) { const n = await clearBackgroundJobs(cwd); if (n) console.log(`cleared ${n} background job record(s)`); } let transcript = await latestTranscriptPath(cwd), messages; if (transcript) { try { messages = await loadTranscript(transcript); console.log(`resumed transcript: ${transcript} (${messages.length} messages)`); const stripped = stripReasoningContent(messages); if (stripped) console.log(`stripped reasoning_content from ${stripped} message(s)`); const est = estimatePromptTokens(messages); stats.last_prompt_tokens = est; } catch (e) { console.log(`failed to load ${transcript}: ${e.message}; starting fresh`); messages = initialMessages(cwd); transcript = await newTranscriptPath(cwd); } } else { messages = initialMessages(cwd); transcript = await newTranscriptPath(cwd); console.log(`new transcript: ${transcript}`); } await saveTranscript(transcript, cwd, messages); console.log('Qwen3.6 JS agent REPL'); console.log(`cwd: ${cwd}`); console.log(`thinking: ${thinking} show_thinking: ${showThinking} max_turns_per_task: ${maxTurns || 'unlimited'}`); console.log('Commands: /help, /jobs, /clear-jobs, /reset, /context, /compact, /transcript, /quit'); const rl = readline.createInterface({ input, output }); for (;;) { const line = (await rl.question('local-agent-js> ')).trim(); if (!line) continue; if (['/q', '/quit', '/exit'].includes(line)) { rl.close(); return 0; } if (line === '/help') { console.log('Enter a task or follow-up. /jobs lists background jobs. /clear-jobs clears job records. /capabilities describes tools. /dirs lists policy. /reset clears context. /context shows stats. /compact summarizes older turns.'); continue; } if (line === '/jobs') { console.log(backgroundJobsText(await listBackgroundJobs(cwd))); continue; } if (line === '/clear-jobs') { console.log(`cleared ${await clearBackgroundJobs(cwd)} background job record(s)`); continue; } if (line === '/capabilities') { console.log(CAPABILITIES_TEXT); continue; } if (line === '/dirs') { console.log(directoryPolicyText(cwd)); continue; } if (line === '/reset') { messages = initialMessages(cwd); transcript = await newTranscriptPath(cwd); await saveTranscript(transcript, cwd, messages); for (const k of Object.keys(stats)) delete stats[k]; stats.compact_threshold = threshold; stats.compact_threshold_source = thresholdSrc; console.log(`context reset; new transcript: ${transcript}`); continue; } if (line === '/context') { const chars = messages.reduce((n, m) => n + String(m.content || '').length, 0); console.log(`messages=${messages.length} approx_content_chars=${chars} last_prompt_tokens=${stats.last_prompt_tokens ?? '?'} compactions=${stats.compactions || 0} empty_retries=${stats.empty_retries || 0} threshold=${stats.compact_threshold} (${stats.compact_threshold_source}) transcript=${transcript}`); continue; } if (line === '/compact') { const [newMessages, did, note] = await compactMessages(messages, bgBaseUrl, model, COMPACT_KEEP_LAST_GROUPS, COMPACT_KEEP_LAST_EXCHANGES, true, stats.open_outputs); if (did) { messages.splice(0, messages.length, ...newMessages); stats.last_prompt_tokens = 0; stats.compactions = Number(stats.compactions || 0) + 1; await saveTranscript(transcript, cwd, messages); } console.log(`compact: ${note}`); continue; } if (line === '/transcript') { console.log(transcript); continue; } messages.push({ role: 'user', content: line }); const [code, final] = await runLoop(baseUrl, messages, cwd, maxTurns, verbose, model, temperature, topP, thinking, showThinking, stats, bgBaseUrl); await saveTranscript(transcript, cwd, messages); console.log(final); if (code !== 0) console.log('(use /reset if it got stuck)'); } }

function parseArgs(argv) { const args = { task: [], repl: false, cwd: DEFAULT_CWD, writeDir: [], maxTurns: 40, baseUrl: DEFAULT_BASE_URL, bgBaseUrl: DEFAULT_BG_BASE_URL, model: DEFAULT_MODEL, temperature: 0.6, topP: 0.95, thinking: true, showThinking: true, capabilities: false, dirs: false, clearJobs: false, clearJobsOnStart: false, verbose: false }; for (let i = 0; i < argv.length; i++) { const a = argv[i]; const next = () => argv[++i]; if (a === '--repl' || a === '-i') args.repl = true; else if (a === '--cwd') args.cwd = next(); else if (a === '--write-dir') args.writeDir.push(next()); else if (a === '--max-turns') args.maxTurns = Number.parseInt(next(), 10); else if (a === '--base-url') args.baseUrl = next(); else if (a === '--bg-base-url') args.bgBaseUrl = next(); else if (a === '--model') args.model = next(); else if (a === '--temperature') args.temperature = Number.parseFloat(next()); else if (a === '--top-p') args.topP = Number.parseFloat(next()); else if (a === '--thinking') args.thinking = true; else if (a === '--no-thinking') args.thinking = false; else if (a === '--show-thinking') args.showThinking = true; else if (a === '--no-show-thinking') args.showThinking = false; else if (a === '--capabilities') args.capabilities = true; else if (a === '--dirs') args.dirs = true; else if (a === '--clear-jobs') args.clearJobs = true; else if (a === '--clear-jobs-on-start') args.clearJobsOnStart = true; else if (a === '-v' || a === '--verbose') args.verbose = true; else if (a === '-h' || a === '--help') args.help = true; else args.task.push(a); } return args; }
function usage() { return `Usage: local-agent-js [options] <task...>\n\nOptions: --repl, --cwd DIR, --write-dir DIR, --max-turns N, --base-url URL, --model NAME, --no-thinking, --no-show-thinking, -v`; }
export async function main(argv = process.argv.slice(2)) { const args = parseArgs(argv); if (args.help) { console.log(usage()); return 0; } const cwd = path.resolve(expandHome(args.cwd)); await fsp.mkdir(cwd, { recursive: true }); const envExtras = (process.env.LOCAL_AGENT_EXTRA_WRITE_DIRS || '').split(':').filter(Boolean); const extras = []; for (const raw of [...args.writeDir, ...envExtras]) { const r = path.resolve(expandHome(raw)); await fsp.mkdir(r, { recursive: true }); if (r !== cwd && !extras.includes(r)) extras.push(r); } WRITE_ROOTS = [cwd, ...extras]; if (args.capabilities) { console.log(CAPABILITIES_TEXT); return 0; } if (args.dirs) { console.log(directoryPolicyText(cwd)); return 0; } if (args.clearJobs) { console.log(`cleared ${await clearBackgroundJobs(cwd)} background job record(s)`); return 0; } if (args.repl) return runRepl(cwd, args.maxTurns, args.verbose, args.baseUrl, args.model, args.temperature, args.topP, args.thinking, args.showThinking, args.clearJobsOnStart, args.bgBaseUrl); if (!args.task.length) { console.error(usage()); return 2; } return runAgent(args.task.join(' '), cwd, args.maxTurns, args.verbose, args.baseUrl, args.model, args.temperature, args.topP, args.thinking, args.showThinking, args.bgBaseUrl); }
