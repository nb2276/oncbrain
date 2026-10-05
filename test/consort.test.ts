import { describe, it, expect } from 'vitest';
import { consortIsCoherent, randomizedCount } from '../src/lib/consort.ts';

const arms = (...n: number[]) => n.map((allocated) => ({ allocated }));

describe('consortIsCoherent', () => {
  it('needs two arms', () => {
    expect(consortIsCoherent({ randomized: 100, arms: arms(100) })).toBe(false);
    expect(consortIsCoherent(null)).toBe(false);
  });
  it('accepts arms-only (no printed total)', () => {
    expect(consortIsCoherent({ randomized: null, arms: arms(152, 151) })).toBe(true);
  });
  it('accepts fewer allocated than randomized, refuses more', () => {
    expect(consortIsCoherent({ randomized: 304, arms: arms(152, 151) })).toBe(true);
    expect(consortIsCoherent({ randomized: 384, arms: arms(172, 172, 82) })).toBe(false);
  });
});

describe('randomizedCount', () => {
  it('is the printed total or nothing, never the sum of the arms', () => {
    expect(randomizedCount({ randomized: 304, arms: arms(152, 151) })).toBe(304);
    expect(randomizedCount({ randomized: null, arms: arms(152, 151) })).toBeNull();
    expect(randomizedCount({ arms: arms(152, 151) })).toBeNull();
  });
});
