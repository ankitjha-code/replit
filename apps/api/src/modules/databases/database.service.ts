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

export interface DatabaseServiceOptions {
  containerHost: string;
  containerPort: number;
}

export class DatabaseService {
  constructor(
    private readonly databases: DatabaseRepository,
    private readonly provider: UserDatabaseProvider,
    private readonly box: SecretBox | undefined,
    private readonly variables: VariableRepository,
    private readonly secrets: SecretRepository,
    private readonly options: DatabaseServiceOptions,
    private readonly log: Logger,
  ) {}

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

  async describe(
    projectId: string,
    options: { includeConnection: boolean; restartRequired?: boolean },
  ): Promise<DatabaseStateResponse> {
    const [record, unavailableReason] = await Promise.all([
      this.databases.findByProject(projectId),
      this.unavailableReason(),
    ]);

    const sizeBytes =
      record && record.status === 'READY' ? await this.provider.sizeOf(record.name) : null;

    return {
      database: record ? this.present(record, options.includeConnection, sizeBytes) : null,
      unavailableReason,
      restartRequired: options.restartRequired ?? false,
    };
  }

  async provision(projectId: string): Promise<DatabaseStateResponse> {
    const box = this.requireBox();

    const existing = await this.databases.findByProject(projectId);
    if (existing && existing.status !== 'FAILED') {
      throw new AppError('CONFLICT', 'This project already has a database.');
    }

    const reason = await this.provider.unavailableReason();
    if (reason) {
      throw new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });
    }

    await this.requireNamesAreFree(projectId);

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

    await this.databases.setPassword(record.id, box.seal(password));

    this.log.info({ projectId, database: record.name }, 'project database password rotated');
    this.events?.publish(projectId, { type: 'config.changed', scope: 'database' });
    return this.describe(projectId, { includeConnection: true });
  }

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

  async connectionForBackup(
    projectId: string,
  ): Promise<{ databaseId: string; connectionUrl: string } | null> {
    const record = await this.databases.findByProject(projectId);
    if (!record || record.status !== 'READY') return null;

    const connection = this.connectionFor(record);
    if (!connection) return null;

    return { databaseId: record.id, connectionUrl: connection.url };
  }

  async hasDatabase(projectId: string): Promise<boolean> {
    const record = await this.databases.findByProject(projectId);
    return record !== null && record.status === 'READY';
  }

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

function physicalName(prefix: 'p' | 'r', projectId: string): string {
  const compact = projectId.replaceAll('-', '').toLowerCase();
  const body = /^[0-9a-f]{32}$/.test(compact) ? compact : randomUUID().replaceAll('-', '');
  return `${prefix}_${body}`;
}

function generatePassword(): string {
  return randomBytes(24).toString('base64url');
}
