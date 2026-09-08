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

/**
 * Project secrets.
 *
 * One rule shapes everything here: a value goes in and never comes out. There
 * is no read method on this service and no endpoint that could call one. The
 * only way a value leaves the database is `forRuntime`, which hands it to a
 * container and returns it to nobody.
 */

export interface SecretServiceOptions {
  /** Most a project may hold. A bound on what is injected into every start. */
  maxPerProject: number;
}

export class SecretService {
  constructor(
    private readonly secrets: SecretRepository,
    /** Absent when the installation has no encryption key. */
    private readonly box: SecretBox | undefined,
    /**
     * Read only, and only ever for names.
     *
     * One name cannot be both a secret and a plain variable in one project.
     * Both sides check, because either one could be set first.
     */
    private readonly variables: VariableRepository,
    /** Read only, and only ever to see whether a database exists. */
    private readonly databases: DatabaseRepository,
    private readonly options: SecretServiceOptions,
    private readonly log: Logger,
  ) {}

  get limit(): number {
    return this.options.maxPerProject;
  }

  /**
   * Why secrets cannot be used here, or null when they can.
   *
   * An installation with no encryption key cannot store a value safely, and
   * storing one unencrypted to keep the feature working would be the worst
   * available resolution.
   */
  unavailableReason(): string | null {
    return this.box
      ? null
      : 'This installation has no encryption key configured, so secrets cannot be stored.';
  }

  /**
   * Where configuration changes are announced, when there is anywhere to
   * announce them. Set after construction, as the file service's is.
   */
  private events: ProjectEventPublisher | undefined;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  /** Names and when they changed. Never values. */
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

    // The name only. A log line is the easiest place for a secret to escape,
    // and this is exactly where someone would be tempted to add the value.
    this.log.info({ projectId, key }, 'secret set');

    /*
     * The scope only, and for secrets that is not merely tidiness.
     *
     * Everyone in a project's event room can read the frame, and only an owner
     * may see a secret's name. An event carrying the name would be a way to
     * learn one from a socket a viewer is allowed to hold.
     */
    this.events?.publish(projectId, { type: 'config.changed', scope: 'secrets' });

    return toSummary(stored);
  }

  async remove(projectId: string, key: string): Promise<void> {
    const { count } = await this.secrets.deleteByKey(projectId, key);
    if (count === 0) throw new AppError('NOT_FOUND', 'There is no secret with that name');
    this.log.info({ projectId, key }, 'secret removed');
    this.events?.publish(projectId, { type: 'config.changed', scope: 'secrets' });
  }

  /**
   * The values, decrypted, for a container that is about to start.
   *
   * The only place a plaintext value exists after it was stored. The result
   * goes straight to the execution provider: never over HTTP, never into a
   * log, and never held beyond the start it belongs to.
   */
  async forRuntime(projectId: string): Promise<Record<string, string>> {
    if (!this.box) return {};

    const sealed = await this.secrets.listSealed(projectId);
    const env: Record<string, string> = {};

    for (const record of sealed) {
      try {
        env[record.key] = this.box.open(record.value);
      } catch (error) {
        // One unreadable value must not stop a project starting. Logged by
        // name, so it can be set again.
        this.log.error({ err: error, projectId, key: record.key }, 'secret could not be decrypted');
      }
    }

    return env;
  }

  /**
   * Refuses a name a plain variable already holds.
   *
   * Turning a readable variable into an unreadable secret by overwriting it
   * would be the worst of the two: the old value is gone, and the new one
   * cannot be read to confirm what replaced it. Removing the variable first is
   * a deliberate act, which is what this should be.
   */
  private async requireNameIsNotAVariable(projectId: string, key: string): Promise<void> {
    const keys = await this.variables.keysForProject(projectId);
    if (!keys.includes(key)) return;

    throw new AppError(
      'CONFLICT',
      'That name is already used by an environment variable in this project. Remove it first, or choose another name.',
      { details: { field: 'key' } },
    );
  }

  /**
   * Refuses a name the project's own database already means.
   *
   * A project with a database is started with `DATABASE_URL` and the `PG*`
   * family already set. Letting one of those be defined here would give the
   * name two meanings, one visible on the page and one inside the container,
   * which is how somebody spends a day debugging a connection string they
   * cannot find. A `FAILED` database sets nothing, so its names stay free.
   */
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
      // Describes the shape and never quotes what was sent: an error message
      // is a response body, and a response body is a place a value could leak.
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
