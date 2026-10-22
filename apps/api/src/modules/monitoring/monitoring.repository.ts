import type { Database } from '../../db/client.js';

export class HealthCheckSettings {
  constructor(private readonly db: Database) {}

  async read(projectId: string): Promise<{ path: string | null; timeoutMs: number | null } | null> {
    const found = await this.db.project.findUnique({
      where: { id: projectId },
      select: { healthCheckPath: true, healthCheckTimeoutMs: true },
    });

    if (!found) return null;
    return { path: found.healthCheckPath, timeoutMs: found.healthCheckTimeoutMs };
  }

  async write(projectId: string, input: { path: string; timeoutMs: number }): Promise<void> {
    await this.db.project.update({
      where: { id: projectId },
      data: { healthCheckPath: input.path, healthCheckTimeoutMs: input.timeoutMs },
    });
  }
}
