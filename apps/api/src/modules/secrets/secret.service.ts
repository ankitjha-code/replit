import {
  isDatabaseEnvKey,
  isReservedSecretKey,
  secretKeySchema,
  secretValueSchema,
  type SecretSummary,
} from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { ProjectEventPublisher } from '../../events/project-event-bus.js';
import type { SecretBox } from '../../lib/secret-box.js';
import type { DatabaseRepository } from '../databases/database.repository.js';
import type { VariableRepository } from '../variables/variable.repository.js';
import type { SecretRepository, SecretSummaryRecord } from './secret.repository.js';

export interface SecretServiceOptions {
  maxPerProject: number;
}

export class SecretService {
  constructor(
    private readonly secrets: SecretRepository,
    private readonly box: SecretBox | undefined,
    private readonly variables: VariableRepository,
    private readonly databases: DatabaseRepository,
    private readonly options: SecretServiceOptions,
    private readonly log: Logger,
  ) {}

  get limit(): number {
    return this.options.maxPerProject;
  }

  unavailableReason(): string | null {
    return this.box
      ? null
      : 'This installation has no encryption key configured, so secrets cannot be stored.';
  }

  private events: ProjectEventPublisher | undefined;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  async list(projectId: string): Promise<SecretSummary[]> {
    const records = await this.secrets.listForProject(projectId);
    return records.map(toSummary);
  }

  async set(
    projectId: string,
    userId: string,
    input: { key: string; value: string },
  ): Promise<SecretSummary> {
    const box = this.requireBox();
    const key = this.requireValidKey(input.key);
    const value = this.requireValidValue(input.value);

    const existing = await this.secrets.listForProject(projectId);
    const isNew = !existing.some((entry) => entry.key === key);

    if (isNew && existing.length >= this.options.maxPerProject) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        `This project has reached its limit of ${this.options.maxPerProject} secrets`,
      );
    }

    if (isNew) {
      await this.requireNameIsNotAVariable(projectId, key);
      await this.requireNameIsNotTheDatabase(projectId, key);
    }

    const stored = await this.secrets.set({
      projectId,
      key,
      value: box.seal(value),
      length: value.length,
      updatedById: userId,
    });

    this.log.info({ projectId, key }, 'secret set');

    this.events?.publish(projectId, { type: 'config.changed', scope: 'secrets' });

    return toSummary(stored);
  }

  async remove(projectId: string, key: string): Promise<void> {
    const { count } = await this.secrets.deleteByKey(projectId, key);
    if (count === 0) throw new AppError('NOT_FOUND', 'There is no secret with that name');
    this.log.info({ projectId, key }, 'secret removed');
    this.events?.publish(projectId, { type: 'config.changed', scope: 'secrets' });
  }

  async forRuntime(projectId: string): Promise<Record<string, string>> {
    if (!this.box) return {};

    const sealed = await this.secrets.listSealed(projectId);
    const env: Record<string, string> = {};

    for (const record of sealed) {
      try {
        env[record.key] = this.box.open(record.value);
      } catch (error) {
        this.log.error({ err: error, projectId, key: record.key }, 'secret could not be decrypted');
      }
    }

    return env;
  }

  private async requireNameIsNotAVariable(projectId: string, key: string): Promise<void> {
    const keys = await this.variables.keysForProject(projectId);
    if (!keys.includes(key)) return;

    throw new AppError(
      'CONFLICT',
      'That name is already used by an environment variable in this project. Remove it first, or choose another name.',
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

  private requireBox(): SecretBox {
    const reason = this.unavailableReason();
    if (reason || !this.box) {
      throw new AppError('SERVICE_UNAVAILABLE', reason ?? 'Secrets are unavailable', {
        expose: true,
      });
    }
    return this.box;
  }

  private requireValidKey(input: string): string {
    const result = secretKeySchema.safeParse(input);

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
    const result = secretValueSchema.safeParse(input);

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

function toSummary(record: SecretSummaryRecord): SecretSummary {
  return {
    key: record.key,
    length: record.length,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
