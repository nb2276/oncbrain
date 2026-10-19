// The 1am launchd job starts with a minimal PATH; daily-build.sh extends it.
// Each entry here is a tool the run shells out to that does not live in the
// system dirs. Missing ~/.bun/bin made every nightly push fail on 2026-10-18
// and 10-19: the gstack pre-push hook runs `bun`, so git refused the push.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const script = readFileSync('scripts/daily-build.sh', 'utf8');
const pathLine = script.split('\n').find((l) => /^export PATH="/.test(l)) ?? '';

describe('daily-build.sh PATH', () => {
  it.each([
    ['$HOME/.local/bin', 'claude CLI (claude-cli LLM backend)'],
    ['$HOME/.bun/bin', 'bun (the pre-push hook)'],
    ['/opt/homebrew/bin', 'node, npm, poppler'],
  ])('includes %s for %s', (dir) => {
    expect(pathLine.split(/[=:"]/)).toContain(dir);
  });
});
