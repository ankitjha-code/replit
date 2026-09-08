import { describe, expect, it } from 'vitest';
import { withDatabaseName } from './global-setup.js';

describe('withDatabaseName', () => {
  it('swaps the database name and keeps credentials and host', () => {
    expect(withDatabaseName('postgresql://u:p@localhost:5442/platform', 'platform_test')).toBe(
      'postgresql://u:p@localhost:5442/platform_test',
    );
  });

  it('preserves query parameters', () => {
    expect(withDatabaseName('postgresql://u:p@h:5442/platform?schema=public', 'x')).toContain(
      'schema=public',
    );
  });

  it('handles a URL with no database name', () => {
    expect(withDatabaseName('postgresql://u:p@h:5442', 'platform_test')).toBe(
      'postgresql://u:p@h:5442/platform_test',
    );
  });
});
