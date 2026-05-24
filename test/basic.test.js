import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_PROMPT, initialMessages, truncate, estimatePromptTokens, COMPACT_THRESHOLD_FALLBACK } from '../src/agent.js';

test('system prompt includes hard-task decomposition by default', () => {
  assert.match(SYSTEM_PROMPT, /Task decomposition/);
  assert.match(SYSTEM_PROMPT, /roughly ten tool calls/);
});

test('initialMessages pins working directory', () => {
  const msgs = initialMessages('/tmp/example');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /Working directory: \/tmp\/example/);
});

test('truncate preserves short text and marks long text', () => {
  assert.equal(truncate('abc', 10), 'abc');
  assert.match(truncate('abcdefghij', 5), /^abcde\n\n\.\.\.\[truncated 5 chars\]/);
});

test('prompt estimator counts message content and tool call args', () => {
  const n = estimatePromptTokens([
    { role: 'user', content: 'a'.repeat(300) },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"x"}' } }] },
  ]);
  assert.ok(n >= 100);
});

test('fallback threshold matches Python default', () => {
  assert.equal(COMPACT_THRESHOLD_FALLBACK, 250_000);
});
