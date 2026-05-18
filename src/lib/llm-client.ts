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

export type LlmMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type LlmCompleteOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
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
    const response = await this.client.messages.create({
      model: opts.model ?? DEFAULT_API_MODEL,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts.temperature ?? 0,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    return extractTextFromApiResponse(response);
  }
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
    const timeoutMs = this.opts.timeoutMs ?? 120_000;
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
export function collapseMessagesToPrompt(messages: LlmMessage[]): string {
  if (messages.length === 1 && messages[0]!.role === 'user') return messages[0]!.content;
  return messages
    .map((m) => (m.role === 'user' ? `USER:\n${m.content}` : `ASSISTANT:\n${m.content}`))
    .join('\n\n');
}

// Factory: pick a backend at runtime. Default 'api' for compatibility.
export function createLlmClient(opts: { backend?: 'api' | 'claude-cli' } = {}): LlmClient {
  const backend = opts.backend ?? (process.env.LLM_BACKEND as 'api' | 'claude-cli' | undefined) ?? 'api';
  if (backend === 'claude-cli') return new ClaudeCliLlmClient();
  return new AnthropicLlmClient(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
}
