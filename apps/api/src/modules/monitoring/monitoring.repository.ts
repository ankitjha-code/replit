import type { Database } from '../../db/client.js';

/**
 * The two columns on a project that say how its application is checked.
 *
 * A repository of its own rather than a method on the project one, because the
 * monitoring service needs exactly this and nothing else about a project.
 * Handing it the whole project repository would give it the ability to read
 * memberships and delete projects in order to read a path.
 */
export class HealthCheckSettings {
  constructor(private readonly db: Database) {}

  /**
   * What the project stored, or null when it has never said.
   *
   * Null rather than the default filled in here. A project that has never
   * thought about its health check should not be carrying a stored answer that
   * only happens to match today's default, because the day the default changes
   * that project would be left behind on the old one.
   */
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
