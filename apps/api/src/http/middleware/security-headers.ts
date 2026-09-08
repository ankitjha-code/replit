import type { NextFunction, Request, Response } from 'express';

/**
 * Response headers for an API that serves data and never a page.
 *
 * Helmet already sets the general-purpose ones. These are the four that depend
 * on knowing what this particular surface is, which Helmet cannot: it has to be
 * safe for an application that might serve HTML, and this one never does.
 *
 * That is the whole idea here. Every header below is stricter than a sensible
 * default, and each is only safe because of something true about this API
 * specifically.
 */
export function securityHeaders() {
  return (_req: Request, res: Response, next: NextFunction): void => {
    /*
     * A policy that forbids everything.
     *
     * This API returns JSON. It has no scripts, no styles, no images and no
     * frames, so a policy permitting any of them would be permitting something
     * that should never happen. If a response here is ever rendered as a
     * document — through a content-type confusion, or an error page somebody
     * adds later — this is what stops it doing anything.
     *
     * `frame-ancestors 'none'` is the part that is not about this response at
     * all: it stops the API being framed, which `X-Frame-Options` also does and
     * which browsers increasingly read only from here.
     */
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );

    /*
     * No referrer to anywhere else.
     *
     * A URL in this API can contain a project identifier, a snapshot identifier
     * and a file path. Sending that to another origin because a response
     * happened to cause a navigation would leak the shape of somebody's work to
     * whoever they went to next.
     */
    res.setHeader('Referrer-Policy', 'no-referrer');

    /*
     * Not readable as a subresource by another origin.
     *
     * CORS already decides who may read a response, and this is the second
     * layer: it stops another site loading an API URL as an image or a script
     * and learning something from whether it succeeded. The workspace is a
     * different origin only in development, where the dev server proxies it
     * onto the same one — so `same-origin` holds in both arrangements.
     */
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    /*
     * No browser features, for a surface that is not a page.
     *
     * Nothing here needs a camera, a microphone, a location or a payment
     * handler. Saying so costs nothing and means a response that is somehow
     * rendered cannot ask for any of them.
     */
    res.setHeader(
      'Permissions-Policy',
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    );

    next();
  };
}
