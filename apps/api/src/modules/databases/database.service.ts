import { randomBytes, randomUUID } from 'node:crypto';
import {
  DATABASE_ENV_KEYS,
  type DatabaseConnection,
  type DatabaseStateResponse,
  type ProjectDatabase,
} from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { ProjectEventPublisher } from '../../events/project-event-bus.js';
import type { SecretBox } from '../../lib/secret-box.js';
import type { UserDatabaseProvider } from '../../userdb/provider.js';
import type { SecretRepository } from '../secrets/secret.repository.js';
import type { VariableRepository } from '../variables/variable.repository.js';
import type { DatabaseRecord, DatabaseRepository } from './database.repository.js';

/**
 * The database a project's application gets.
 *
 * The control plane decides that a project should have one and records it; a
 * separate PostgreSQL server holds it. What makes a project's SQL unable to
 * reach platform state is that it is a different server process, not a GRANT,
 * so nothing here can accidentally undo it.
 *
 * The password is encrypted at rest and **is** returned to an owner, unlike a
 * secret. It is the project's own credential for the project's own data, and an
 * owner who cannot read it cannot point a migration tool, a client or a
 * dashboard at their own database, which is most of what having one is for. The
 * honest mitigation for a leak is rotating it.
 */

export interface DatabaseServiceOptions {
  /** How an application reaches the server from inside its container. */
  containerHost: string;
  containerPort: number;
}

export class DatabaseService {
  constructor(
    private readonly databases: DatabaseRepository,
    private readonly provider: UserDatabaseProvider,
    /** Absent when the installation has no encryption key. */
    private readonly box: SecretBox | undefined,
    /** Read only, and only ever for names. See `requireNameIsFree`. */
    private readonly variables: VariableRepository,
    private readonly secrets: SecretRepository,
    private readonly options: DatabaseServiceOptions,
    private readonly log: Logger,
  ) {}

  /**
   * Why a database cannot be provisioned here, or null when one can.
   *
   * Two separate obstacles with one answer, because a client can act on either
   * only by telling somebody to change the installation's configuration.
   */
  /**
   * Where database changes are announced, when there is anywhere to announce
   * them. Set after construction, as the file service's is.
   */
  private events: ProjectEventPublisher | undefined;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  async unavailableReason(): Promise<string | null> {
    if (!this.box) {
      return 'This installation has no encryption key configured, so a database credential cannot be stored.';
    }
    return this.provider.unavailableReason();
  }

  /**
   * What the project has, and whether it could have one.
   *
   * `includeConnection` is the caller's permission expressed as data. The
   * service will not decide who may see a credential by inspecting a role; the
   * route that already ran an authorization check says so.
   */
  async describe(
    projectId: string,
    options: { includeConnection: boolean; restartRequired?: boolean },
  ): Promise<DatabaseStateResponse> {
    const [record, unavailableReason] = await Promise.all([
      this.databases.findByProject(projectId),
      this.unavailableReason(),
    ]);

    /*
     * Measured only for a database that exists and is ready.
     *
     * Asking the server for the size of something that was never made would
     * turn a page about "you have no database" into a failed request.
     */
    const sizeBytes =
      record && record.status === 'READY' ? await this.provider.sizeOf(record.name) : null;

    return {
      database: record ? this.present(record, options.includeConnection, sizeBytes) : null,
      unavailableReason,
      restartRequired: options.restartRequired ?? false,
    };
  }

  /**
   * Gives the project a database.
   *
   * Refuses rather than replacing when one exists: a project has one database,
   * and quietly making a second would leave the first holding the only copy of
   * data nobody can reach any more.
   */
  async provision(projectId: string): Promise<DatabaseStateResponse> {
    const box = this.requireBox();

    const existing = await this.databases.findByProject(projectId);
    if (existing && existing.status !== 'FAILED') {
      throw new AppError('CONFLICT', 'This project already has a database.');
    }

    const reason = await this.provider.unavailableReason();
    if (reason) {
      // Refused before anything is written, so an installation with no server
      // never accumulates rows describing databases that will never exist.
      throw new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });
    }

    await this.requireNamesAreFree(projectId);

    /*
     * A failed attempt is retried on the same row rather than beside it.
     *
     * Its physical names were never successfully created, so reusing them is
     * safe, and leaving the old row would mean a project with two rows and no
     * way to say which is current.
     */
    if (existing) await this.discard(existing);

    const password = generatePassword();
    const record = await this.databases.create({
      projectId,
      name: physicalName('p', projectId),
      role: physicalName('r', projectId),
      password: box.seal(password),
    });

    try {
      await this.provider.provision({
        name: record.name,
        role: record.role,
        password,
      });
    } catch (error) {
      const message = this.userFacing(error, 'The database could not be created.');
      await this.databases.markFailed(record.id, message);

      /*
       * Undo whatever did get made.
       *
       * Provisioning is several statements and cannot be atomic at the server,
       * so a failure halfway leaves a role with no database or the reverse.
       * Dropping is safe when nothing is there.
       */
      await this.provider
        .drop({ name: record.name, role: record.role })
        .catch((cleanup: unknown) => {
          this.log.error(
            { err: cleanup, projectId, database: record.name },
            'a half-made project database could not be cleaned up',
          );
        });

      this.log.error({ err: error, projectId }, 'project database provisioning failed');
      throw new AppError('EXECUTION_FAILED', message, { expose: true });
    }

    await this.databases.markReady(record.id);
    this.log.info({ projectId, database: record.name }, 'project database created');
    this.events?.publish(projectId, { type: 'config.changed', scope: 'database' });

    return this.describe(projectId, { includeConnection: true });
  }

  /**
   * Empties the database, keeping the same name, owner and password.
   *
   * Deliberately not a drop followed by a provision. Every connection string
   * somebody has written down keeps working, and the `DATABASE_URL` a running
   * container already holds stays correct, so a reset is a reset rather than a
   * replacement that silently invalidates all of them.
   *
   * There is no undo. Whatever was in it is gone.
   */
  async reset(projectId: string): Promise<DatabaseStateResponse> {
    const record = await this.requireReady(projectId);

    try {
      await this.provider.reset({ name: record.name, role: record.role });
    } catch (error) {
      const message = this.userFacing(error, 'The database could not be reset.');
      this.log.error({ err: error, projectId }, 'project database reset failed');
      throw new AppError('EXECUTION_FAILED', message, { expose: true });
    }

    this.log.info({ projectId, database: record.name }, 'project database reset');
    this.events?.publish(projectId, { type: 'config.changed', scope: 'database' });
    return this.describe(projectId, { includeConnection: true });
  }

  /**
   * Replaces the password, which is the only honest answer to one that leaked.
   *
   * The credential is readable by an owner, so the mitigation for it getting
   * out cannot be to hide it: it has to be to make the old one useless. The
   * application keeps the old password until it is restarted, and the caller is
   * told so rather than left to discover it.
   */
  async rotate(projectId: string): Promise<DatabaseStateResponse> {
    const box = this.requireBox();
    const record = await this.requireReady(projectId);

    const password = generatePassword();

    try {
      await this.provider.setPassword(record.role, password);
    } catch (error) {
      const message = this.userFacing(error, 'The password could not be changed.');
      this.log.error({ err: error, projectId }, 'project database password rotation failed');
      throw new AppError('EXECUTION_FAILED', message, { expose: true });
    }

    /*
     * Recorded only after the server accepted it.
     *
     * The other order would leave the platform holding a password the server
     * has never heard of, which is worse than the one it replaced: the old one
     * at least worked.
     */
    await this.databases.setPassword(record.id, box.seal(password));

    this.log.info({ projectId, database: record.name }, 'project database password rotated');
    this.events?.publish(projectId, { type: 'config.changed', scope: 'database' });
    return this.describe(projectId, { includeConnection: true });
  }

  /**
   * Removes the database on request, rather than because a project is going.
   *
   * Refuses when the server cannot be reached, which is the opposite of what
   * `release` does. Deleting a project must never be blocked; deleting only the
   * database must never half-succeed and leave the platform claiming a database
   * is gone while it sits there holding data.
   */
  async destroy(projectId: string): Promise<DatabaseStateResponse> {
    const record = await this.databases.findByProject(projectId);
    if (!record) throw new AppError('NOT_FOUND', 'This project has no database.');

    try {
      await this.provider.drop({ name: record.name, role: record.role });
    } catch (error) {
      const message = this.userFacing(error, 'The database could not be removed.');
      this.log.error({ err: error, projectId }, 'project database could not be dropped');
      throw new AppError('EXECUTION_FAILED', message, { expose: true });
    }

    await this.databases.deleteByProject(projectId);
    this.log.info({ projectId, database: record.name }, 'project database deleted');
    this.events?.publish(projectId, { type: 'config.changed', scope: 'database' });

    return this.describe(projectId, { includeConnection: true });
  }

  /** The one lookup every lifecycle operation needs, with its two refusals. */
  private async requireReady(projectId: string): Promise<DatabaseRecord> {
    const record = await this.databases.findByProject(projectId);
    if (!record) throw new AppError('NOT_FOUND', 'This project has no database.');
    if (record.status !== 'READY') {
      throw new AppError(
        'PRECONDITION_FAILED',
        'This project database is not ready, so it cannot be changed yet.',
      );
    }
    return record;
  }

  /**
   * Removes the project's database and everything in it.
   *
   * Called when a project is deleted. Deliberately does not throw: a project
   * must be deletable even when the database server is unreachable, so a
   * failure here is logged as a leak rather than blocking the deletion.
   */
  async release(projectId: string): Promise<void> {
    const record = await this.databases.findByProject(projectId);
    if (!record) return;

    try {
      await this.provider.drop({ name: record.name, role: record.role });
    } catch (error) {
      this.log.error(
        { err: error, projectId, database: record.name },
        'a project database could not be dropped and is now orphaned',
      );
    }

    await this.databases.deleteByProject(projectId);
  }

  /**
   * The environment a project with a database is started with.
   *
   * Empty when it has none, or when its credential cannot be decrypted: an
   * application handed a connection string that does not work is worse off than
   * one told there is no database, because it will report a connection failure
   * and nobody will know why.
   */
  async forRuntime(projectId: string): Promise<Record<string, string>> {
    const record = await this.databases.findByProject(projectId);
    if (!record || record.status !== 'READY') return {};

    const connection = this.connectionFor(record);
    if (!connection) {
      this.log.error(
        { projectId, database: record.name },
        'a project database credential could not be decrypted, so the runtime was started without it',
      );
      return {};
    }

    return {
      DATABASE_URL: connection.url,
      PGHOST: connection.host,
      PGPORT: String(connection.port),
      PGDATABASE: connection.database,
      PGUSER: connection.username,
      PGPASSWORD: connection.password,
    };
  }

  /**
   * What a backup workload needs in order to reach the database.
   *
   * Deliberately a separate method from `forRuntime`, which returns a whole
   * environment for a container running somebody's application. This returns one
   * URL to one caller that runs a command the platform wrote, and keeping them
   * apart means widening one never widens the other.
   *
   * Null when there is no database, or when the credential cannot be decrypted —
   * a backup taken with a URL that does not work would be an empty file recorded
   * as a copy.
   */
  async connectionForBackup(
    projectId: string,
  ): Promise<{ databaseId: string; connectionUrl: string } | null> {
    const record = await this.databases.findByProject(projectId);
    if (!record || record.status !== 'READY') return null;

    const connection = this.connectionFor(record);
    if (!connection) return null;

    return { databaseId: record.id, connectionUrl: connection.url };
  }

  /** Whether the project has a database, so other services can reserve names. */
  async hasDatabase(projectId: string): Promise<boolean> {
    const record = await this.databases.findByProject(projectId);
    return record !== null && record.status === 'READY';
  }

  // -------------------------------------------------------------------------

  private present(
    record: DatabaseRecord,
    includeConnection: boolean,
    sizeBytes: number | null,
  ): ProjectDatabase {
    const connection =
      includeConnection && record.status === 'READY' ? this.connectionFor(record) : null;

    return {
      status: record.status,
      createdAt: record.createdAt.toISOString(),
      sizeBytes,
      message: record.message,
      connection,
    };
  }

  private connectionFor(record: DatabaseRecord): DatabaseConnection | null {
    if (!this.box) return null;

    let password: string;
    try {
      password = this.box.open(record.password);
    } catch {
      // Reported by the caller, which knows whether this is being shown to a
      // person or handed to a container.
      return null;
    }

    const host = this.options.containerHost;
    const port = this.options.containerPort;

    return {
      url: `postgresql://${encodeURIComponent(record.role)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(record.name)}`,
      host,
      port,
      database: record.name,
      username: record.role,
      password,
    };
  }

  /**
   * Refuses to provision while a variable or secret holds a name it would set.
   *
   * The alternative is a project whose `DATABASE_URL` means one thing on the
   * page and another inside the container, which is how somebody spends a day
   * debugging a connection string they cannot find.
   */
  private async requireNamesAreFree(projectId: string): Promise<void> {
    const [variableKeys, secretRecords] = await Promise.all([
      this.variables.keysForProject(projectId),
      this.secrets.listForProject(projectId),
    ]);

    const taken = new Set([...variableKeys, ...secretRecords.map((s) => s.key)]);
    const clash = DATABASE_ENV_KEYS.filter((key) => taken.has(key));
    if (clash.length === 0) return;

    throw new AppError(
      'CONFLICT',
      `A database sets ${clash.join(', ')}, and this project already defines ${
        clash.length === 1 ? 'that name' : 'those names'
      }. Remove ${clash.length === 1 ? 'it' : 'them'} first.`,
    );
  }

  private async discard(record: DatabaseRecord): Promise<void> {
    await this.provider.drop({ name: record.name, role: record.role }).catch((error: unknown) => {
      this.log.warn(
        { err: error, database: record.name },
        'a failed project database could not be cleaned up before retrying',
      );
    });
    await this.databases.deleteByProject(record.projectId);
  }

  private requireBox(): SecretBox {
    if (!this.box) {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'This installation has no encryption key configured, so a database credential cannot be stored.',
        { expose: true },
      );
    }
    return this.box;
  }

  private userFacing(error: unknown, fallback: string): string {
    return error instanceof AppError && error.expose ? error.message : fallback;
  }
}

/**
 * A physical name derived from the project, never from anything a person typed.
 *
 * PostgreSQL identifiers are capped at 63 bytes, and a prefix plus 32 hex
 * characters is 34. The prefix keeps a database name and a role name distinct
 * even though both come from the same project.
 */
function physicalName(prefix: 'p' | 'r', projectId: string): string {
  const compact = projectId.replaceAll('-', '').toLowerCase();
  const body = /^[0-9a-f]{32}$/.test(compact) ? compact : randomUUID().replaceAll('-', '');
  return `${prefix}_${body}`;
}

/**
 * A password from an alphabet that needs no escaping anywhere it is used.
 *
 * It ends up in a SQL literal and in a URL. Base64url has neither quotes nor
 * reserved URL characters, so both uses are safe before any escaping, and both
 * escape it anyway.
 */
function generatePassword(): string {
  return randomBytes(24).toString('base64url');
}
