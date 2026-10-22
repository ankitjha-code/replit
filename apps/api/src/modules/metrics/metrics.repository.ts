import type { Database } from '../../db/client.js';

/**
 * Counts for the metrics page, read at scrape time.
 *
 * Grouped queries only: a scrape every fifteen seconds must never become a scan
 * that grows with the number of files or log lines.
 */
export class MetricsRepository {
  constructor(private readonly db: Database) {}

  async counts(): Promise<{
    users: number;
    projects: number;
    runtimes: { status: string; count: number }[];
    deployments: { status: string; count: number }[];
    jobs: { status: string; type: string; count: number }[];
  }> {
    const [users, projects, runtimes, deployments, jobs] = await Promise.all([
      this.db.user.count(),
      this.db.project.count(),
      this.db.runtime.groupBy({ by: ['status'], _count: { _all: true } }),
      this.db.deployment.groupBy({ by: ['status'], _count: { _all: true } }),
      this.db.job.groupBy({ by: ['status', 'type'], _count: { _all: true } }),
    ]);
    return {
      users,
      projects,
      runtimes: runtimes.map((row) => ({ status: row.status, count: row._count._all })),
      deployments: deployments.map((row) => ({ status: row.status, count: row._count._all })),
      jobs: jobs.map((row) => ({ status: row.status, type: row.type, count: row._count._all })),
    };
  }
}
