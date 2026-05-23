// LLM backend adapter.
//
// Two paths share one interface:
//   - AnthropicLlmClient   → paid Anthropic API via @anthropic-ai/sdk
//   - ClaudeCliLlmClient   → shells out to `claude -p`, billed to your Claude Code subscription
//
// Pick at runtime via LLM_BACKEND env var ('api' or 'claude-cli'). Default 'api'
// for compatibility — anyone with ANTHROPIC_API_KEY set keeps the existing
// behavior. Flip to 'claude-cli' for local builds that piggyback on your
// existing Claude Code subscription.
//
// Caveats of the claude-cli path:
//   - Requires `claude` CLI on PATH, authenticated.
//   - temperature is best-effort. The CLI does not expose an explicit
//     temperature flag, so summary stability comes from prompt structure
//     and the model's defaults, not the API knob.
//   - Slower per call (process spawn).
//   - Counts against your Claude Code weekly usage budget. Heavy eval loops
//     during prompt iteration can eat into it.

import Anthropic from '@anthropic-ai/sdk';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

// `cache: true` marks this block as a prompt-cache breakpoint (api backend
// only). Content up to and including it is cached and billed at ~10% on
// subsequent calls within the cache TTL. Used for the VOICE block, which is
// byte-identical across every phase + study-agent call in a build. The
// claude-cli backend ignores it (the CLI manages its own context).
export type LlmTextBlock = { type: 'text'; text: string; cache?: boolean };
export type LlmImageBlock = { type: 'image'; url: string };
export type LlmContentBlock = LlmTextBlock | LlmImageBlock;

export type LlmMessage = {
  role: 'user' | 'assistant';
  // string for simple text-only messages; LlmContentBlock[] for multimodal
  // (e.g., image + text in one user turn).
  content: string | LlmContentBlock[];
};

export type LlmCompleteOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  // Extended-thinking budget in tokens (api backend only). When > 0, the model
  // reasons in a separate thinking block before answering. The api requires
  // temperature=1 and max_tokens > budget when thinking is on, so the client
  // forces temperature=1 and adds the budget on top of maxTokens. Ignored by
  // the claude-cli backend (no clean `claude -p` flag for it).
  thinkingBudget?: number;
};

export interface LlmClient {
  complete(messages: LlmMessage[], opts?: LlmCompleteOptions): Promise<string>;
}

const DEFAULT_API_MODEL = 'claude-sonnet-4-6';
const DEFAULT_CLI_MODEL = 'sonnet';
const DEFAULT_MAX_TOKENS = 4096;

// API-backed client: calls Anthropic's messages.create endpoint.
export class AnthropicLlmClient implements LlmClient {
  constructor(private readonly client: Anthropic) {}

  async complete(messages: LlmMessage[], opts: LlmCompleteOptions = {}): Promise<string> {
    const thinkingBudget = opts.thinkingBudget && opts.thinkingBudget > 0 ? opts.thinkingBudget : 0;
    const baseMax = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    const response = await this.client.messages.create({
      model: opts.model ?? DEFAULT_API_MODEL,
      // max_tokens must exceed the thinking budget — reserve the budget on top
      // of the answer allowance so a deep think can't starve the JSON output.
      max_tokens: thinkingBudget ? thinkingBudget + baseMax : baseMax,
      // The api rejects temperature != 1 when thinking is enabled.
      temperature: thinkingBudget ? 1 : (opts.temperature ?? 0),
      ...(thinkingBudget
        ? { thinking: { type: 'enabled' as const, budget_tokens: thinkingBudget } }
        : {}),
      messages: messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : m.content.map(toAnthropicBlock),
      })),
    });
    return extractTextFromApiResponse(response);
  }
}

// Map our portable content blocks to Anthropic's SDK shape.
function toAnthropicBlock(block: LlmContentBlock) {
  if (block.type === 'text') {
    return block.cache
      ? {
          type: 'text' as const,
          text: block.text,
          cache_control: { type: 'ephemeral' as const },
        }
      : { type: 'text' as const, text: block.text };
  }
  return {
    type: 'image' as const,
    source: { type: 'url' as const, url: block.url },
  };
}

function extractTextFromApiResponse(response: {
  content: Array<{ type: string; text?: string }>;
}): string {
  for (const block of response.content) {
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return '';
}

// Spawn signature compatible with node:child_process.spawn (kept loose for testability).
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildProcess;

export class ClaudeCliError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'ClaudeCliError';
  }
}

// CLI-backed client: shells out to `claude -p`. Prompt is sent on stdin to avoid
// argv length limits and to keep multi-line prompts intact. Stdout is the response.
export class ClaudeCliLlmClient implements LlmClient {
  constructor(
    private readonly opts: {
      binary?: string;
      spawn?: SpawnFn;
      timeoutMs?: number;
    } = {},
  ) {}

  async complete(messages: LlmMessage[], opts: LlmCompleteOptions = {}): Promise<string> {
    const binary = this.opts.binary ?? 'claude';
    const spawnFn = this.opts.spawn ?? (spawn as SpawnFn);
    // 10-minute default — the v4 digest prompt with comparative analysis on
    // a full day of tweets can take 2-5 minutes on the subscription path,
    // especially during high-load periods. Headroom > tight budget.
    const timeoutMs = this.opts.timeoutMs ?? 600_000;
    const model = opts.model ?? DEFAULT_CLI_MODEL;

    const prompt = collapseMessagesToPrompt(messages);
    const args = ['-p', '--model', model];

    // claude -p uses subscription auth by default, but if ANTHROPIC_API_KEY is
    // present in the env it treats that as an external (metered) API key and
    // routes the call there instead. We're explicitly on the subscription path
    // — strip the env var so a stale or placeholder ANTHROPIC_API_KEY from .env
    // can't hijack the call. Same goes for the alias ANTHROPIC_AUTH_TOKEN.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;

    return new Promise<string>((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = spawnFn(binary, args, { env: childEnv });
      } catch (err) {
        reject(
          new ClaudeCliError(`Failed to spawn ${binary}: ${(err as Error).message}`, null, ''),
        );
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        try {
          proc.kill('SIGTERM');
        } catch {
          // intentionally swallowed — process may already be gone
        }
        settle(() =>
          reject(new ClaudeCliError(`claude -p timed out after ${timeoutMs}ms`, null, stderr)),
        );
      }, timeoutMs);

      proc.stdout?.on('data', (chunk) => {
        stdout += chunk.toString('utf-8');
      });
      proc.stderr?.on('data', (chunk) => {
        stderr += chunk.toString('utf-8');
      });
      proc.on('error', (err) => {
        settle(() =>
          reject(new ClaudeCliError(`claude -p failed: ${err.message}`, null, stderr)),
        );
      });
      proc.on('close', (code) => {
        settle(() => {
          if (code === 0) {
            resolve(stdout);
          } else {
            // Surface whatever the CLI emitted on either stream — claude -p
            // sometimes writes diagnostic JSON to stdout before exiting 1
            // (e.g., on auth / rate-limit issues), so include both.
            const diagnostic =
              [
                stderr && `stderr: ${stderr.trim()}`,
                stdout && `stdout: ${stdout.trim()}`,
              ]
                .filter(Boolean)
                .join(' | ') || 'no output';
            reject(
              new ClaudeCliError(
                `claude -p exited with code ${code}: ${diagnostic}`,
                code,
                stderr,
              ),
            );
          }
        });
      });

      try {
        proc.stdin?.write(prompt);
        proc.stdin?.end();
      } catch (err) {
        settle(() =>
          reject(
            new ClaudeCliError(`Failed to write prompt to claude stdin: ${(err as Error).message}`, null, stderr),
          ),
        );
      }
    });
  }
}

// The pipeline currently builds a single user-prompt string. If we ever support
// multi-turn, the API path gets it for free; the CLI path concatenates with role
// markers because `claude -p` accepts a single prompt buffer, not a turn list.
// Multimodal content blocks are degraded to text — the CLI path can't yet
// surface image URLs to claude -p, so images are listed by URL with a note
// telling the model they exist but can't be inspected.
export function collapseMessagesToPrompt(messages: LlmMessage[]): string {
  const stringify = (m: LlmMessage): string => {
    if (typeof m.content === 'string') return m.content;
    const parts: string[] = [];
    let imageCount = 0;
    for (const block of m.content) {
      if (block.type === 'text') parts.push(block.text);
      else {
        imageCount++;
        parts.push(`[image #${imageCount}: ${block.url} — image content not available to claude -p backend]`);
      }
    }
    return parts.join('\n\n');
  };
  if (messages.length === 1 && messages[0]!.role === 'user') return stringify(messages[0]!);
  return messages
    .map((m) => (m.role === 'user' ? `USER:\n${stringify(m)}` : `ASSISTANT:\n${stringify(m)}`))
    .join('\n\n');
}

// Factory: pick a backend at runtime. Default 'api' for compatibility.
export function createLlmClient(opts: { backend?: 'api' | 'claude-cli' } = {}): LlmClient {
  const backend = opts.backend ?? (process.env.LLM_BACKEND as 'api' | 'claude-cli' | undefined) ?? 'api';
  if (backend === 'claude-cli') {
    // CLAUDE_BIN lets a non-interactive caller (launchd, cron) pin the absolute
    // path to the claude CLI. Under launchd, ~/.local/bin is not on PATH, so a
    // bare `claude` spawn fails with ENOENT. Falls back to PATH lookup.
    return new ClaudeCliLlmClient({ binary: process.env.CLAUDE_BIN || undefined });
  }
  return new AnthropicLlmClient(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
}
