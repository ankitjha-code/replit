import type { Request, Response } from 'express';
import { publicReadiness, type HealthService } from './health.service.js';

export class HealthController {
  constructor(private readonly service: HealthService) {}

  live = (_req: Request, res: Response): void => {
    res.status(200).json(this.service.live());
  };

  ready = async (req: Request, res: Response): Promise<void> => {
    const report = await this.service.ready();
    const body = req.auth?.user.isOperator === true ? report : publicReadiness(report);
    res.status(report.status === 'down' ? 503 : 200).json(body);
  };
}
