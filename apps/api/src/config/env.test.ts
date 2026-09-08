import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const minimal = {} as NodeJS.ProcessEnv;

describe('environment configuration', () => {
  it('applies defaults suitable for local development', () => {
    const config = loadEnv(minimal);
    expect(config.NODE_ENV).toBe('development');
    expect(config.API_PORT).toBe(4000);
    expect(config.CORS_ORIGINS).toEqual(['http://localhost:5173']);
  });

  it('coerces the port from a string', () => {
    expect(loadEnv({ API_PORT: '8123' } as NodeJS.ProcessEnv).API_PORT).toBe(8123);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadEnv({ API_PORT: '70000' } as NodeJS.ProcessEnv)).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadEnv({ NODE_ENV: 'staging' } as NodeJS.ProcessEnv)).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('splits and trims the CORS origin list', () => {
    const config = loadEnv({
      CORS_ORIGINS: 'http://a.test, http://b.test ,',
    } as NodeJS.ProcessEnv);
    expect(config.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('parses boolean-ish flags', () => {
    expect(loadEnv({ TRUST_PROXY: 'true' } as NodeJS.ProcessEnv).TRUST_PROXY).toBe(true);
    expect(loadEnv({ TRUST_PROXY: '0' } as NodeJS.ProcessEnv).TRUST_PROXY).toBe(false);
    expect(loadEnv(minimal).TRUST_PROXY).toBe(false);
  });

  it('rejects a malformed public URL', () => {
    expect(() => loadEnv({ API_PUBLIC_URL: 'not-a-url' } as NodeJS.ProcessEnv)).toThrow(
      /Invalid environment configuration/,
    );
  });
});

describe('database configuration', () => {
  it('defaults the pool to a conservative ceiling', () => {
    const config = loadEnv(minimal);
    expect(config.DATABASE_POOL_MAX).toBe(10);
    expect(config.DATABASE_STATEMENT_TIMEOUT_MS).toBe(15_000);
  });

  it('coerces pool settings from strings', () => {
    const config = loadEnv({ DATABASE_POOL_MAX: '25' } as NodeJS.ProcessEnv);
    expect(config.DATABASE_POOL_MAX).toBe(25);
  });

  it('refuses a pool size that would exhaust the server', () => {
    expect(() => loadEnv({ DATABASE_POOL_MAX: '5000' } as NodeJS.ProcessEnv)).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('refuses a zero pool size', () => {
    expect(() => loadEnv({ DATABASE_POOL_MAX: '0' } as NodeJS.ProcessEnv)).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('accepts both postgres URL schemes', () => {
    expect(loadEnv({ DATABASE_URL: 'postgres://h/db' } as NodeJS.ProcessEnv).DATABASE_URL).toBe(
      'postgres://h/db',
    );
    expect(
      loadEnv({ DATABASE_URL: 'postgresql://h/db' } as NodeJS.ProcessEnv).DATABASE_URL,
    ).toBeDefined();
  });
});

describe('blank settings', () => {
  it('treats an empty value as not set, as a blank template line or compose default gives', () => {
    const config = loadEnv({
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASSWORD: '',
      MAIL_FROM: '',
      METRICS_TOKEN: '',
      REDIS_URL: '',
    } as NodeJS.ProcessEnv);
    expect(config.SMTP_HOST).toBeUndefined();
    expect(config.METRICS_TOKEN).toBeUndefined();
    expect(config.REDIS_URL).toBeUndefined();
  });
});
