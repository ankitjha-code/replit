import type { Request, Response } from 'express';
import type { HealthService } from './health.service.js';

/**
 * Translates between HTTP and the health service. No logic lives here beyond
 * choosing a status code from the service's verdict.
 */
export class HealthController {
  constructor(private readonly service: HealthService) {}

  live = (_req: Request, res: Response): void => {
    res.status(200).json(this.service.live());
  };

  ready = async (_req: Request, res: Response): Promise<void> => {
    const report = await this.service.ready();
    res.status(report.status === 'down' ? 503 : 200).json(report);
  };
}
