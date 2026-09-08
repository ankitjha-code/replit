import { config } from 'zod';

/**
 * Imported first, before anything that defines a schema.
 *
 * The production proxy's Content-Security-Policy forbids eval. Zod probes for it
 * with `new Function` when schemas are set up, and the browser reports the
 * refused probe as a violation even though Zod catches it and falls back.
 * Turning its compiler off skips the probe. It must run before any schema module
 * is evaluated, which is why it is its own module and the first import.
 */
config({ jitless: true });
