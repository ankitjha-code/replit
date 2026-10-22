import type { NextFunction, Request, Response } from 'express';

export function securityHeaders() {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );

    res.setHeader('Referrer-Policy', 'no-referrer');

    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    res.setHeader(
      'Permissions-Policy',
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    );

    next();
  };
}
