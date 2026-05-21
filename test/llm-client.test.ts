import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  AnthropicLlmClient,
  ClaudeCliLlmClient,
  ClaudeCliError,
  collapseMessagesToPrompt,
  createLlmClient,
  type SpawnFn,
} from '../src/lib/llm-client.ts';

// ─── AnthropicLlmClient ─────────────────────────────────────────────────────

function mockAnthropic(responseText: string) {
  const create = vi.fn(async () => ({
    content: [{ type: 'text', text: responseText }],
  }));
  return {
    messages: { create },
    // The Anthropic class has many more methods we never touch — cast through unknown.
  } as never;
}

describe('AnthropicLlmClient', () => {
  it('returns text from messages.create response', async () => {
    const anthropic = mockAnthropic('hello world');
    const client = new AnthropicLlmClient(anthropic);
    const result = await client.complete([{ role: 'user', content: 'hi' }]);
    expect(result).toBe('hello world');
  });

  it('passes model, maxTokens, and temperature through to the SDK', async () => {
    const anthropic = mockAnthropic('ok');
    const client = new AnthropicLlmClient(anthropic);
    await client.complete([{ role: 'user', content: 'hi' }], {
      model: 'claude-foo',
      maxTokens: 1234,
      temperature: 0.7,
    });
    // @ts-expect-error inspecting the mock
    const call = anthropic.messages.create.mock.calls[0][0];
    expect(call.model).toBe('claude-foo');
    expect(call.max_tokens).toBe(1234);
    expect(call.temperature).toBe(0.7);
  });

  it('applies sensible defaults when options are omitted', async () => {
    const anthropic = mockAnthropic('ok');
    const client = new AnthropicLlmClient(anthropic);
    await client.complete([{ role: 'user', content: 'hi' }]);
    // @ts-expect-error inspecting the mock
    const call = anthropic.messages.create.mock.calls[0][0];
    expect(call.temperature).toBe(0);
    expect(call.max_tokens).toBe(4096);
    expect(call.model).toBe('claude-sonnet-4-6');
  });

  it('returns empty string if response has no text block', async () => {
    const noText = {
      messages: { create: vi.fn(async () => ({ content: [{ type: 'tool_use' }] })) },
    } as never;
    const client = new AnthropicLlmClient(noText);
    const result = await client.complete([{ role: 'user', content: 'hi' }]);
    expect(result).toBe('');
  });

  it('emits cache_control only on blocks flagged cache:true', async () => {
    const anthropic = mockAnthropic('ok');
    const client = new AnthropicLlmClient(anthropic);
    await client.complete([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'VOICE rules', cache: true },
          { type: 'text', text: 'variable data' },
        ],
      },
    ]);
    // @ts-expect-error inspecting the mock
    const call = anthropic.messages.create.mock.calls[0][0];
    expect(call.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(call.messages[0].content[1].cache_control).toBeUndefined();
  });
});

// ─── ClaudeCliLlmClient ─────────────────────────────────────────────────────

type MockProcOptions = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  errorEvent?: Error;
};

// Fabricate a ChildProcess-shaped EventEmitter for testing. We only stub the
// surfaces ClaudeCliLlmClient actually touches: stdout/stderr 'data', 'close',
// 'error', and stdin.{write,end}.
function makeMockProcess(opts: MockProcOptions = {}): {
  proc: ChildProcess;
  stdinWrite: ReturnType<typeof vi.fn>;
  stdinEnd: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
} {
  // The real ChildProcess streams implement node:stream interfaces; the test
  // stubs only fake the surfaces the implementation actually touches
  // (stdout/stderr 'data', 'close', 'error', stdin.{write,end}). Cast away
  // the rest — this is duck-typed test wiring, not production code.
  const proc = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdinWrite = vi.fn();
  const stdinEnd = vi.fn();
  const kill = vi.fn();
  (proc as unknown as { stdout: EventEmitter }).stdout = stdout;
  (proc as unknown as { stderr: EventEmitter }).stderr = stderr;
  (proc as unknown as { stdin: { write: typeof stdinWrite; end: typeof stdinEnd } }).stdin = {
    write: stdinWrite,
    end: stdinEnd,
  };
  (proc as unknown as { kill: typeof kill }).kill = kill;

  setImmediate(() => {
    if (opts.stdout) stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) stderr.emit('data', Buffer.from(opts.stderr));
    if (opts.errorEvent) {
      proc.emit('error', opts.errorEvent);
    } else {
      proc.emit('close', opts.exitCode ?? 0);
    }
  });

  return { proc, stdinWrite, stdinEnd, kill };
}

describe('ClaudeCliLlmClient', () => {
  it('resolves with stdout on exit 0', async () => {
    const mock = makeMockProcess({ stdout: 'cli output', exitCode: 0 });
    const spawnFn: SpawnFn = vi.fn(() => mock.proc);
    const client = new ClaudeCliLlmClient({ spawn: spawnFn });
    const result = await client.complete([{ role: 'user', content: 'hello' }]);
    expect(result).toBe('cli output');
  });

  it('rejects with ClaudeCliError on non-zero exit', async () => {
    const mock = makeMockProcess({ stderr: 'boom', exitCode: 1 });
    const spawnFn: SpawnFn = vi.fn(() => mock.proc);
    const client = new ClaudeCliLlmClient({ spawn: spawnFn });
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      name: 'ClaudeCliError',
      code: 1,
      stderr: 'boom',
    });
  });

  it('rejects when the process emits an error event', async () => {
    const mock = makeMockProcess({ errorEvent: new Error('ENOENT') });
    const spawnFn: SpawnFn = vi.fn(() => mock.proc);
    const client = new ClaudeCliLlmClient({ spawn: spawnFn });
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(
      ClaudeCliError,
    );
  });

  it('rejects when spawn itself throws synchronously', async () => {
    const spawnFn: SpawnFn = vi.fn(() => {
      throw new Error('not found');
    });
    const client = new ClaudeCliLlmClient({ spawn: spawnFn });
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(
      ClaudeCliError,
    );
  });

  it('writes the prompt to stdin and closes it', async () => {
    const mock = makeMockProcess({ stdout: 'ok', exitCode: 0 });
    const spawnFn: SpawnFn = vi.fn(() => mock.proc);
    const client = new ClaudeCliLlmClient({ spawn: spawnFn });
    await client.complete([{ role: 'user', content: 'the prompt text' }]);
    expect(mock.stdinWrite).toHaveBeenCalledWith('the prompt text');
    expect(mock.stdinEnd).toHaveBeenCalled();
  });

  it('passes --model with the requested model name', async () => {
    const mock = makeMockProcess({ stdout: 'ok', exitCode: 0 });
    const spawnFn: SpawnFn = vi.fn(() => mock.proc);
    const client = new ClaudeCliLlmClient({ spawn: spawnFn });
    await client.complete([{ role: 'user', content: 'hi' }], { model: 'opus' });
    expect(spawnFn).toHaveBeenCalledWith('claude', ['-p', '--model', 'opus'], expect.any(Object));
  });

  it('defaults the model to "sonnet" when not provided', async () => {
    const mock = makeMockProcess({ stdout: 'ok', exitCode: 0 });
    const spawnFn: SpawnFn = vi.fn(() => mock.proc);
    const client = new ClaudeCliLlmClient({ spawn: spawnFn });
    await client.complete([{ role: 'user', content: 'hi' }]);
    expect(spawnFn).toHaveBeenCalledWith('claude', ['-p', '--model', 'sonnet'], expect.any(Object));
  });

  it('uses a custom binary path if provided', async () => {
    const mock = makeMockProcess({ stdout: 'ok', exitCode: 0 });
    const spawnFn: SpawnFn = vi.fn(() => mock.proc);
    const client = new ClaudeCliLlmClient({ spawn: spawnFn, binary: '/opt/claude' });
    await client.complete([{ role: 'user', content: 'hi' }]);
    expect(spawnFn).toHaveBeenCalledWith('/opt/claude', expect.any(Array), expect.any(Object));
  });

  it('scrubs ANTHROPIC_API_KEY from the child env so subscription auth wins', async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-placeholder';
    try {
      const mock = makeMockProcess({ stdout: 'ok', exitCode: 0 });
      const spawnFn: SpawnFn = vi.fn(() => mock.proc);
      const client = new ClaudeCliLlmClient({ spawn: spawnFn });
      await client.complete([{ role: 'user', content: 'hi' }]);
      // @ts-expect-error inspecting the mock
      const opts = spawnFn.mock.calls[0][2];
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(opts.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      // Other env vars should still pass through
      expect(opts.env.PATH).toBeDefined();
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
    }
  });
});

// ─── collapseMessagesToPrompt ──────────────────────────────────────────────

describe('collapseMessagesToPrompt', () => {
  it('returns content directly for a single user message', () => {
    expect(collapseMessagesToPrompt([{ role: 'user', content: 'hello' }])).toBe('hello');
  });

  it('adds USER/ASSISTANT markers for multi-turn', () => {
    const result = collapseMessagesToPrompt([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
    expect(result).toBe('USER:\nq1\n\nASSISTANT:\na1\n\nUSER:\nq2');
  });
});

// ─── factory ───────────────────────────────────────────────────────────────

describe('createLlmClient', () => {
  it('returns ClaudeCliLlmClient when backend is claude-cli', () => {
    const client = createLlmClient({ backend: 'claude-cli' });
    expect(client).toBeInstanceOf(ClaudeCliLlmClient);
  });

  it('returns AnthropicLlmClient by default', () => {
    const client = createLlmClient();
    expect(client).toBeInstanceOf(AnthropicLlmClient);
  });

  it('respects LLM_BACKEND env var when explicit opts not set', () => {
    const original = process.env.LLM_BACKEND;
    process.env.LLM_BACKEND = 'claude-cli';
    try {
      const client = createLlmClient();
      expect(client).toBeInstanceOf(ClaudeCliLlmClient);
    } finally {
      if (original === undefined) delete process.env.LLM_BACKEND;
      else process.env.LLM_BACKEND = original;
    }
  });
});
