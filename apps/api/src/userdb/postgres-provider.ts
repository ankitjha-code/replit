import { Client } from 'pg';
import type { Logger } from 'pino';
import { AppError } from '../errors/app-error.js';
import type { UserDatabaseProvider, UserDatabaseSpec, UserDatabaseSummary } from './provider.js';

/**
 * Provisions project databases in a PostgreSQL server that is not the
 * platform's.
 *
 * Connects as an administrator, because creating roles and databases requires
 * it. Those credentials never leave this file: what an application is given is
 * a role that can reach exactly one database.
 *
 * A fresh connection per operation rather than a pool. Provisioning happens
 * once per project in its whole life, `CREATE DATABASE` cannot run inside a
 * transaction so a pooled session would carry state between unrelated
 * operations anyway, and a pool held open to a second server is a resource the
 * platform does not otherwise need.
 */

/**
 * What a generated identifier may contain.
 *
 * Every name reaching this file is built by the platform from a project's
 * identifier, so this can only fail if that generation changes. It is checked
 * anyway: these strings go into SQL identifiers, and the cost of being wrong is
 * the whole server.
 */
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

/** The alphabet a generated password uses. Checked for the same reason. */
const SAFE_PASSWORD = /^[A-Za-z0-9_-]{16,128}$/;

export interface PostgresUserDatabaseOptions {
  adminUrl: string;
  /** How long a reachability answer is reused. */
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

  /**
   * Whether the server is reachable.
   *
   * Cached briefly. Every settings page asks, and a connection per page view
   * buys nothing: a server that died a second ago is reported on the next
   * request either way.
   */
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
      /*
       * Neither statement can run inside a transaction, so this cannot be
       * atomic at the server. The caller's contract is that a half-made
       * database is not reported ready, which is arranged by only recording
       * READY after both statements returned, and by the caller dropping what
       * it can on failure.
       */
      await client.query(
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${client.escapeLiteral(password)}`,
      );
      await client.query(`CREATE DATABASE ${quoteIdentifier(name)} OWNER ${quoteIdentifier(role)}`);

      /*
       * Shut everyone else out.
       *
       * A new database is connectable by PUBLIC by default, which would let any
       * project's role open any other project's database. This is the boundary
       * between one project and the next, and it does not exist until this runs.
       */
      await client.query(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(name)} FROM PUBLIC`);
      await client.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(name)} TO ${quoteIdentifier(role)}`,
      );
    });

    /*
     * The schema inside the new database, as its owner rather than as the
     * administrator.
     *
     * Postgres 15 and later leave `public` owned by the database owner but
     * without CREATE for anyone else, which is what is wanted. Connecting once
     * as the owner also proves the credential works before the platform
     * promises it does.
     */
    await this.withClient(
      async (client) => {
        await client.query('SELECT 1');
      },
      { database: name, user: role, password },
    );
  }

  /**
   * Shuts PUBLIC out of the server's own databases.
   *
   * Found by a test rather than by reading: a new role could connect to the
   * `postgres` administrative database, because PostgreSQL grants CONNECT on it
   * to PUBLIC. Nothing of another project's **data** was reachable that way,
   * but the shared catalogues were, so one project could list every other
   * project's database and role names and then start guessing at them.
   *
   * Run before the first provision and remembered, because it is a property of
   * the server rather than of any one project.
   *
   * Deliberately not fatal. It needs an administrator with the rights to revoke
   * on those databases, and an installation whose admin role is narrower than
   * that should still get a working database with its own boundaries intact.
   * The failure is logged as the security gap it is rather than swallowed.
   */
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

  /**
   * Empties the database by replacing it with an empty one of the same name.
   *
   * PostgreSQL has no "empty this database" statement. Dropping every object
   * one at a time would leave behind whatever the enumeration missed, so the
   * database itself is dropped and made again: the same name, the same owner,
   * the same password, and therefore the same connection string.
   *
   * The role is deliberately **not** touched. Recreating it would change the
   * password, and a reset that silently invalidates every connection string
   * somebody has written down is a replacement wearing a reset's name.
   */
  async reset(spec: { name: string; role: string }): Promise<void> {
    const name = this.identifier(spec.name);
    const role = this.identifier(spec.role);

    await this.withClient(async (client) => {
      // Anything still connected would refuse the drop, and after a reset the
      // application's own connections are stale anyway.
      await client.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        [name],
      );
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
      await client.query(`CREATE DATABASE ${quoteIdentifier(name)} OWNER ${quoteIdentifier(role)}`);
      // A new database is connectable by PUBLIC again, so the boundary between
      // one project and the next has to be rebuilt with it.
      await client.query(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(name)} FROM PUBLIC`);
      await client.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(name)} TO ${quoteIdentifier(role)}`,
      );
    });
  }

  /** How much room it is taking, or null when the answer cannot be had. */
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
      // A size is a nicety. Failing to read one must not stop a page that is
      // mostly about whether the database exists at all.
      this.log.warn({ err: error }, 'could not read the size of a project database');
      return null;
    }
  }

  /**
   * The project databases on this server, and nothing else.
   *
   * Matched against the platform's own naming — `p_` and thirty-two hex
   * characters, which is a project identifier with its hyphens removed — rather
   * than listed wholesale. A server can be shared with things this platform did
   * not create, and the caller of this method deletes what it is given.
   *
   * The owner comes back beside the name because dropping a database leaves its
   * role behind, and a role nobody can name is a second leak of the same kind.
   */
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
      /*
       * Sessions first.
       *
       * A dropped database with someone connected to it refuses to drop, and
       * the application's own container may well still be holding a connection
       * at the moment a project is deleted.
       */
      await client.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        [name],
      );
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
      await client.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
    });
  }

  // -------------------------------------------------------------------------

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
      // Never allowed to mask the real error from the work above.
      await client.end().catch(() => undefined);
    }
  }

  private identifier(value: string): string {
    if (!SAFE_IDENTIFIER.test(value)) {
      // A programming error, not a user's. The message deliberately does not
      // quote the value: it goes nowhere near a response either way.
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

/**
 * Quotes an identifier that has already been checked against the pattern above.
 *
 * Both together, not either alone: the pattern is what makes this safe, and the
 * quoting is what keeps a name that happens to be a reserved word working.
 */
function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
