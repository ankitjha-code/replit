import { z } from 'zod';

export const DATABASE_STATUSES = ['CREATING', 'READY', 'FAILED'] as const;

export type DatabaseStatus = (typeof DATABASE_STATUSES)[number];

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

export const databaseConnectionSchema = z.object({
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
  sizeBytes: z.number().int().nonnegative().nullable(),
  message: z.string().nullable(),
  connection: databaseConnectionSchema.nullable(),
});

export type ProjectDatabase = z.infer<typeof projectDatabaseSchema>;

export const databaseStateResponseSchema = z.object({
  database: projectDatabaseSchema.nullable(),
  restartRequired: z.boolean(),
  unavailableReason: z.string().nullable(),
});

export type DatabaseStateResponse = z.infer<typeof databaseStateResponseSchema>;

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

export const restoreBackupRequestSchema = z.object({
  confirm: z.literal('restore'),
});

export type RestoreBackupRequest = z.infer<typeof restoreBackupRequestSchema>;
