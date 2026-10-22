import { describe, expect, it } from 'vitest';
import { canControl, canManage, canWrite } from './permissions.js';

describe('project permissions', () => {
  it('follows the shared role table', () => {
    expect(canWrite('VIEWER')).toBe(false);
    expect(canWrite('EDITOR')).toBe(true);
    expect(canWrite('OWNER')).toBe(true);
    expect(canControl('VIEWER')).toBe(false);
    expect(canControl('EDITOR')).toBe(true);
    expect(canManage('EDITOR')).toBe(false);
    expect(canManage('OWNER')).toBe(true);
  });

  it('answers no while the role is unknown', () => {
    expect(canWrite(undefined)).toBe(false);
    expect(canControl(null)).toBe(false);
    expect(canManage(undefined)).toBe(false);
  });
});
