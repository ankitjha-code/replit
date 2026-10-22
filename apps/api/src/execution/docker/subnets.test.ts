import { describe, expect, it } from 'vitest';
import { capacity, firstFree, startingIndex, subnetAt } from './subnets.js';

const pool = { base: '10.210.0.0/16', prefixLength: 28 };

describe('project subnets', () => {
  it('holds thousands of project networks, not the thirty Docker defaults to', () => {
    expect(capacity(pool)).toBe(4_096);
  });

  it('carves consecutive, non-overlapping subnets', () => {
    expect(subnetAt(pool, 0)).toBe('10.210.0.0/28');
    expect(subnetAt(pool, 1)).toBe('10.210.0.16/28');
    expect(subnetAt(pool, 16)).toBe('10.210.1.0/28');
    expect(subnetAt(pool, 4_095)).toBe('10.210.255.240/28');
  });

  it('starts a project in the same place every time', () => {
    const id = '018f0000-0000-7000-8000-0000000000aa';
    expect(startingIndex(pool, id)).toBe(startingIndex(pool, id));
    expect(startingIndex(pool, id)).toBeLessThan(capacity(pool));
  });

  it('walks past what is taken, wrapping at the end', () => {
    const taken = new Set([subnetAt(pool, 4_095), subnetAt(pool, 0)]);
    expect(firstFree(pool, 4_095, taken)).toBe(subnetAt(pool, 1));
  });

  it('says so when the pool is full, rather than inventing an address', () => {
    const tiny = { base: '10.0.0.0/27', prefixLength: 28 };
    const taken = new Set([subnetAt(tiny, 0), subnetAt(tiny, 1)]);
    expect(firstFree(tiny, 0, taken)).toBeUndefined();
  });

  it('refuses a subnet too small to hold containers', () => {
    expect(() => capacity({ base: '10.0.0.0/16', prefixLength: 31 })).toThrow();
  });
});
