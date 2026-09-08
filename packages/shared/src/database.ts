import { z } from 'zod';

/**
 * The database a project's application gets.
 *
 * Not the platform's. The platform's users, sessions and secrets live in a
 * different PostgreSQL server, so a project's SQL reaches nothing of the
 * platform's because there is nothing of the platform's there to reach. That is
 * a structural separation rather than a permissions one, which means a mistake
 * in a GRANT cannot undo it.
 *
 * Projects are separated from each other inside that server by roles. That is a
 * real boundary and a weaker one, and it is stated rather than glossed over.
 */

export const DATABASE_STATUSES = ['CREATING', 'READY', 'FAILED'] as const;

export type DatabaseStatus = (typeof DATABASE_STATUSES)[number];

/**
 * The environment a project with a database is started with.
 *
 * `DATABASE_URL` is what a library reads. The `PG*` family is what the command
 * line tools read, so `psql` in the project's own terminal connects to the
 * project's own database with no arguments. Both describe one database; neither
 * is a second source of truth.
 *
 * These names are therefore not available to a project's own variables or
 * secrets while it has a database. A name with two meanings is how someone ends
 * up debugging a connection string they cannot find.
 */
export const DATABASE_ENV_KEYS = [
  'DATABASE_URL',
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
] as const;

const databaseEnvKeys = new Set<string>(DATABASE_ENV_KEYS);

export function isDatabaseEnvKey(key: string): boolean {
  return databaseEnvKeys.has(key.toUpperCase());
}

/**
 * What a caller learns about a project's database.
 *
 * Includes the password, unlike a secret. This is the project's own credential
 * for the project's own data: withholding it would mean nobody could connect a
 * migration tool, a client or a dashboard to their own database, which is most
 * of what having one is for. It is guarded by being owner-only rather than by
 * being unreadable, and the honest mitigation for a leak is rotating it.
 */
export const databaseConnectionSchema = z.object({
  /** What an application reads, already assembled. */
  url: z.string(),
  host: z.string(),
  port: z.number().int().positive(),
  database: z.string(),
  username: z.string(),
  password: z.string(),
});

export type DatabaseConnection = z.infer<typeof databaseConnectionSchema>;

export const projectDatabaseSchema = z.object({
  status: z.enum(DATABASE_STATUSES),
  createdAt: z.string(),
  /**
   * How much room it is taking, in bytes, or null when that could not be read.
   *
   * Null rather than zero on purpose: zero reads as an empty database, which is
   * a claim, and an unanswered question is not one.
   */
  sizeBytes: z.number().int().nonnegative().nullable(),
  /** Why it is in this state, when that needs saying. Written to be shown. */
  message: z.string().nullable(),
  /**
   * Absent until it is ready, and absent to anyone who may not see it.
   *
   * Two different reasons for the same shape, deliberately: a client renders
   * what it was given rather than deciding which of the two applies.
   */
  connection: databaseConnectionSchema.nullable(),
});

export type ProjectDatabase = z.infer<typeof projectDatabaseSchema>;

export const databaseStateResponseSchema = z.object({
  /** Null when the project has never asked for one. */
  database: projectDatabaseSchema.nullable(),
  /**
   * Whether the running application is using something other than what is
   * described here.
   *
   * A container is handed its environment when it is created, so resetting a
   * database or rotating its password changes what the next start will use.
   * After a rotation the credentials a running container holds are not merely
   * stale, they no longer work, which is worth saying plainly.
   */
  restartRequired: z.boolean(),
  /**
   * Why a database cannot be provisioned here, or null when one can.
   *
   * An installation with no database server configured says so rather than
   * offering a button that records a row describing something absent.
   */
  unavailableReason: z.string().nullable(),
});

export type DatabaseStateResponse = z.infer<typeof databaseStateResponseSchema>;

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

/**
 * A copy of a project's database, taken at a moment.
 *
 * The dump itself is never returned by any endpoint and is not downloadable.
 * That is deliberate: a dump is the entire contents of somebody's database in
 * one file, and an endpoint that handed one over would be the single most
 * valuable thing to reach on this platform. A backup exists to be restored
 * *here*, and restoring is the only thing that can be done with one.
 */
export const BACKUP_STATUSES = ['RUNNING', 'READY', 'FAILED'] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

export const databaseBackupSummarySchema = z.object({
  id: z.string(),
  status: z.enum(BACKUP_STATUSES),
  note: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  message: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

export type DatabaseBackupSummary = z.infer<typeof databaseBackupSummarySchema>;

export const databaseBackupListResponseSchema = z.object({
  backups: z.array(databaseBackupSummarySchema),
});

export const createBackupRequestSchema = z.object({
  note: z.string().trim().max(200).optional(),
});

export type CreateBackupRequest = z.infer<typeof createBackupRequestSchema>;

/**
 * Putting a backup back, which destroys what is there now.
 *
 * The typed confirmation is the same device account deletion uses, and for the
 * same reason: this is not reversible, and a password would prove who is asking
 * rather than that they meant it. What is typed is the word `restore`, because
 * there is no project-specific string a person would know here that they would
 * not also copy without reading.
 */
export const restoreBackupRequestSchema = z.object({
  confirm: z.literal('restore'),
});

export type RestoreBackupRequest = z.infer<typeof restoreBackupRequestSchema>;
