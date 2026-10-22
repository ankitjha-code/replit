import { Client } from 'pg';
import type { Logger } from 'pino';
import { AppError } from '../errors/app-error.js';
import type { UserDatabaseProvider, UserDatabaseSpec, UserDatabaseSummary } from './provider.js';

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

const SAFE_PASSWORD = /^[A-Za-z0-9_-]{16,128}$/;

export interface PostgresUserDatabaseOptions {
  adminUrl: string;
  availabilityTtlMs: number;
}

export class PostgresUserDatabaseProvider implements UserDatabaseProvider {
  readonly name = 'postgres';

  private availability: { reason: string | null; at: number } | undefined;
  private hardened = false;

  constructor(
    private readonly options: PostgresUserDatabaseOptions,
    private readonly log: Logger,
  ) {}

  async unavailableReason(): Promise<string | null> {
    const cached = this.availability;
    if (cached && Date.now() - cached.at < this.options.availabilityTtlMs) return cached.reason;

    let reason: string | null;
    try {
      await this.withClient(async (client) => {
        await client.query('SELECT 1');
      });
      reason = null;
    } catch (error) {
      this.log.warn({ err: error }, 'project database server is unreachable');
      reason =
        'The database server for projects cannot be reached, so a project cannot be given a database right now.';
    }

    this.availability = { reason, at: Date.now() };
    return reason;
  }

  async provision(spec: UserDatabaseSpec): Promise<void> {
    await this.harden();

    const role = this.identifier(spec.role);
    const name = this.identifier(spec.name);
    const password = this.password(spec.password);

    await this.withClient(async (client) => {
      await client.query(
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${client.escapeLiteral(password)}`,
      );
      await client.query(`CREATE DATABASE ${quoteIdentifier(name)} OWNER ${quoteIdentifier(role)}`);

      await client.query(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(name)} FROM PUBLIC`);
      await client.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(name)} TO ${quoteIdentifier(role)}`,
      );
    });

    await this.withClient(
      async (client) => {
        await client.query('SELECT 1');
      },
      { database: name, user: role, password },
    );
  }

  private async harden(): Promise<void> {
    if (this.hardened) return;

    try {
      await this.withClient(async (client) => {
        for (const database of ['postgres', 'template1']) {
          await client.query(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(database)} FROM PUBLIC`);
        }
      });
      this.hardened = true;
    } catch (error) {
      this.log.error(
        { err: error },
        'could not revoke PUBLIC connect on the project database server: project roles may be able to list other project database names',
      );
    }
  }

  async setPassword(roleName: string, newPassword: string): Promise<void> {
    const role = this.identifier(roleName);
    const password = this.password(newPassword);

    await this.withClient(async (client) => {
      await client.query(
        `ALTER ROLE ${quoteIdentifier(role)} PASSWORD ${client.escapeLiteral(password)}`,
      );
    });
  }

  async reset(spec: { name: string; role: string }): Promise<void> {
    const name = this.identifier(spec.name);
    const role = this.identifier(spec.role);

    await this.withClient(async (client) => {
      await client.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        [name],
      );
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
      await client.query(`CREATE DATABASE ${quoteIdentifier(name)} OWNER ${quoteIdentifier(role)}`);
      await client.query(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(name)} FROM PUBLIC`);
      await client.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(name)} TO ${quoteIdentifier(role)}`,
      );
    });
  }

  async sizeOf(rawName: string): Promise<number | null> {
    const name = this.identifier(rawName);

    try {
      return await this.withClient(async (client) => {
        const result = await client.query<{ size: string }>(
          'SELECT pg_database_size($1)::text AS size',
          [name],
        );
        const raw = result.rows[0]?.size;
        if (raw === undefined) return null;
        const size = Number(raw);
        return Number.isFinite(size) ? size : null;
      });
    } catch (error) {
      this.log.warn({ err: error }, 'could not read the size of a project database');
      return null;
    }
  }

  async list(): Promise<UserDatabaseSummary[]> {
    return this.withClient(async (client) => {
      const result = await client.query<{ name: string; role: string | null }>(
        `SELECT d.datname AS name, r.rolname AS role
           FROM pg_database d
           LEFT JOIN pg_roles r ON r.oid = d.datdba
          WHERE d.datistemplate = false
            AND d.datname ~ '^p_[0-9a-f]{32}$'`,
      );

      return result.rows.map((row) => ({ name: row.name, role: row.role }));
    });
  }

  async drop(spec: { name: string; role: string }): Promise<void> {
    const role = this.identifier(spec.role);
    const name = this.identifier(spec.name);

    await this.withClient(async (client) => {
      await client.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        [name],
      );
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
      await client.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
    });
  }

  private async withClient<T>(
    work: (client: Client) => Promise<T>,
    as?: { database: string; user: string; password: string },
  ): Promise<T> {
    const client = as
      ? new Client({
          connectionString: this.options.adminUrl,
          database: as.database,
          user: as.user,
          password: as.password,
        })
      : new Client({ connectionString: this.options.adminUrl });

    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private identifier(value: string): string {
    if (!SAFE_IDENTIFIER.test(value)) {
      throw new AppError('INTERNAL_ERROR', 'A database identifier was not generated correctly');
    }
    return value;
  }

  private password(value: string): string {
    if (!SAFE_PASSWORD.test(value)) {
      throw new AppError('INTERNAL_ERROR', 'A database password was not generated correctly');
    }
    return value;
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
