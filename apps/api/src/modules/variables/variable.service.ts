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

/**
 * Project environment variables.
 *
 * Everything a secret refuses to do, this does on purpose: the value is
 * returned, shown, and can be corrected. A credential belongs next door.
 *
 * The one rule that spans both is that a name may not exist in both places for
 * one project. The platform refuses the second rather than choosing a winner,
 * because a precedence rule nobody can see is how a project ends up running on
 * a value its owner cannot find.
 */

export interface VariableServiceOptions {
  /** Most a project may hold. A bound on what is injected into every start. */
  maxPerProject: number;
}

export class VariableService {
  constructor(
    private readonly variables: VariableRepository,
    /**
     * Read only, and only ever for names.
     *
     * This service must be able to say "that name is a secret" and must never
     * be able to say what the secret is. Taking the repository rather than the
     * secret service is what keeps that true: the repository's value-reading
     * method exists, but nothing here calls it, and a review can see that at a
     * glance.
     */
    private readonly secrets: SecretRepository,
    /**
     * Read only, and only ever to see whether a database exists.
     *
     * A project with one is started with names this service must not let
     * anything else claim.
     */
    private readonly databases: DatabaseRepository,
    private readonly options: VariableServiceOptions,
    private readonly log: Logger,
  ) {}

  get limit(): number {
    return this.options.maxPerProject;
  }

  /**
   * Where configuration changes are announced, when there is anywhere to
   * announce them. Set after construction, as the file service's is.
   */
  private events: ProjectEventPublisher | undefined;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  /** Names and values. The values are the point. */
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

    // Name only. The value is not sensitive by definition, but a log line that
    // records configuration is still a log line someone will later paste into
    // a ticket, and there is nothing here that needs it.
    this.log.info({ projectId, key }, 'environment variable set');

    // The scope and nothing more. A variable's name is configuration and not a
    // secret, but an event does not need it: everyone allowed to see these
    // asks for the list, where the server decides what they may read.
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

  /**
   * The variables, for a container that is about to start.
   *
   * Merged with the project's secrets by the runtime service. Nothing here is
   * sensitive, so unlike its counterpart there is no ceremony about where the
   * result may go.
   */
  async forRuntime(projectId: string): Promise<Record<string, string>> {
    const records = await this.variables.listForProject(projectId);
    const env: Record<string, string> = {};
    for (const record of records) env[record.key] = record.value;
    return env;
  }

  /** Whether a name is already a secret, so the secret side can ask too. */
  async conflictsWithVariable(projectId: string, key: string): Promise<boolean> {
    const keys = await this.variables.keysForProject(projectId);
    return keys.includes(key);
  }

  private async requireNameIsNotASecret(projectId: string, key: string): Promise<void> {
    const secrets = await this.secrets.listForProject(projectId);
    if (!secrets.some((secret) => secret.key === key)) return;

    // `field` rather than a `fields` list: that is the shape the client maps
    // a conflict onto an input with, and a validation-shaped body here would
    // be shown as the general message with nothing pointing at the name.
    throw new AppError(
      'CONFLICT',
      'That name is already used by a secret in this project. Remove the secret first, or choose another name.',
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
