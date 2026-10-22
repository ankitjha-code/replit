import {
  isDatabaseEnvKey,
  isReservedSecretKey,
  variableKeySchema,
  variableValueSchema,
  type ProjectVariable,
} from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { ProjectEventPublisher } from '../../events/project-event-bus.js';
import type { DatabaseRepository } from '../databases/database.repository.js';
import type { SecretRepository } from '../secrets/secret.repository.js';
import type { VariableRecord, VariableRepository } from './variable.repository.js';

export interface VariableServiceOptions {
  maxPerProject: number;
}

export class VariableService {
  constructor(
    private readonly variables: VariableRepository,
    private readonly secrets: SecretRepository,
    private readonly databases: DatabaseRepository,
    private readonly options: VariableServiceOptions,
    private readonly log: Logger,
  ) {}

  get limit(): number {
    return this.options.maxPerProject;
  }

  private events: ProjectEventPublisher | undefined;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  async list(projectId: string): Promise<ProjectVariable[]> {
    const records = await this.variables.listForProject(projectId);
    return records.map(toVariable);
  }

  async set(
    projectId: string,
    userId: string,
    input: { key: string; value: string },
  ): Promise<ProjectVariable> {
    const key = this.requireValidKey(input.key);
    const value = this.requireValidValue(input.value);

    const existing = await this.variables.keysForProject(projectId);
    const isNew = !existing.includes(key);

    if (isNew && existing.length >= this.options.maxPerProject) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        `This project has reached its limit of ${this.options.maxPerProject} environment variables`,
      );
    }

    if (isNew) {
      await this.requireNameIsNotASecret(projectId, key);
      await this.requireNameIsNotTheDatabase(projectId, key);
    }

    const stored = await this.variables.set({ projectId, key, value, updatedById: userId });

    this.log.info({ projectId, key }, 'environment variable set');

    this.events?.publish(projectId, { type: 'config.changed', scope: 'variables' });

    return toVariable(stored);
  }

  async remove(projectId: string, key: string): Promise<void> {
    const { count } = await this.variables.deleteByKey(projectId, key);
    if (count === 0) {
      throw new AppError('NOT_FOUND', 'There is no environment variable with that name');
    }
    this.log.info({ projectId, key }, 'environment variable removed');
    this.events?.publish(projectId, { type: 'config.changed', scope: 'variables' });
  }

  async forRuntime(projectId: string): Promise<Record<string, string>> {
    const records = await this.variables.listForProject(projectId);
    const env: Record<string, string> = {};
    for (const record of records) env[record.key] = record.value;
    return env;
  }

  async conflictsWithVariable(projectId: string, key: string): Promise<boolean> {
    const keys = await this.variables.keysForProject(projectId);
    return keys.includes(key);
  }

  private async requireNameIsNotASecret(projectId: string, key: string): Promise<void> {
    const secrets = await this.secrets.listForProject(projectId);
    if (!secrets.some((secret) => secret.key === key)) return;

    throw new AppError(
      'CONFLICT',
      'That name is already used by a secret in this project. Remove the secret first, or choose another name.',
      { details: { field: 'key' } },
    );
  }

  private async requireNameIsNotTheDatabase(projectId: string, key: string): Promise<void> {
    if (!isDatabaseEnvKey(key)) return;

    const database = await this.databases.findByProject(projectId);
    if (!database || database.status === 'FAILED') return;

    throw new AppError(
      'CONFLICT',
      `This project's database already sets ${key}. Remove the database first, or choose another name.`,
      { details: { field: 'key' } },
    );
  }

  private requireValidKey(input: string): string {
    const result = variableKeySchema.safeParse(input);

    if (!result.success) {
      throw new AppError('VALIDATION_FAILED', 'That name cannot be used', {
        details: {
          fields: [{ path: 'key', message: result.error.issues[0]?.message ?? 'Invalid name' }],
        },
      });
    }

    if (isReservedSecretKey(result.data)) {
      throw new AppError('VALIDATION_FAILED', 'That name is reserved by the platform', {
        details: { fields: [{ path: 'key', message: 'That name is reserved by the platform' }] },
      });
    }

    return result.data;
  }

  private requireValidValue(input: string): string {
    const result = variableValueSchema.safeParse(input);

    if (!result.success) {
      throw new AppError('VALIDATION_FAILED', 'That value cannot be stored', {
        details: {
          fields: [{ path: 'value', message: result.error.issues[0]?.message ?? 'Invalid value' }],
        },
      });
    }

    return result.data;
  }
}

function toVariable(record: VariableRecord): ProjectVariable {
  return {
    key: record.key,
    value: record.value,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
