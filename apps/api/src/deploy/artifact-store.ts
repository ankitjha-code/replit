import { extname } from 'node:path';
import type { Logger } from 'pino';
import type { StorageProvider } from '../storage/provider.js';
import { readSnapshotArchive } from '../modules/snapshots/snapshot-archive.js';

/**
 * The built files of static deployments, ready to answer a request.
 *
 * A static site is stored as one tar in object storage, unpacked the first time
 * somebody asks for it, and held in memory afterwards. Held, because the
 * alternative is fetching and unpacking a whole site per request, and a static
 * site is the one thing here that should be cheap to serve.
 *
 * The cache is bounded and drops the least recently used site when it is full.
 * A host with more sites than memory then re-reads rather than failing, which is
 * slower and always correct; an unbounded cache would be faster until the day it
 * took the control plane down.
 */

export interface ArtifactFile {
  content: Buffer;
  contentType: string;
}

export interface ArtifactStoreOptions {
  /** How much unpacked output to hold across every deployment. */
  maxCacheBytes: number;
}

interface CachedArtifact {
  files: Map<string, ArtifactFile>;
  bytes: number;
}

export class ArtifactStore {
  /**
   * Unpacked sites, keyed by storage key.
   *
   * A Map, because JavaScript's preserves insertion order: re-inserting on every
   * read turns it into a least-recently-used list without a second structure.
   */
  private readonly cache = new Map<string, CachedArtifact>();
  private bytes = 0;

  /** Fetches in flight, so ten requests for a cold site are one download. */
  private readonly loading = new Map<string, Promise<CachedArtifact | undefined>>();

  constructor(
    private readonly storage: StorageProvider,
    private readonly options: ArtifactStoreOptions,
    private readonly log: Logger,
  ) {}

  /**
   * One file from a deployment's output, or undefined.
   *
   * The path comes from a URL and is looked up in a map rather than joined onto
   * anything, which is what makes traversal meaningless here: there is no
   * filesystem to escape from. The archive's own paths were checked when it was
   * written.
   */
  async file(storageKey: string, path: string): Promise<ArtifactFile | undefined> {
    const artifact = await this.load(storageKey);
    if (!artifact) return undefined;

    for (const candidate of candidatePaths(path)) {
      const found = artifact.files.get(candidate);
      if (found) return found;
    }

    return undefined;
  }

  /** Forgets one, for when its deployment is removed. */
  forget(storageKey: string): void {
    const held = this.cache.get(storageKey);
    if (!held) return;
    this.cache.delete(storageKey);
    this.bytes -= held.bytes;
  }

  private async load(storageKey: string): Promise<CachedArtifact | undefined> {
    const cached = this.cache.get(storageKey);
    if (cached) {
      // Re-inserted so it becomes the most recently used.
      this.cache.delete(storageKey);
      this.cache.set(storageKey, cached);
      return cached;
    }

    const inFlight = this.loading.get(storageKey);
    if (inFlight) return inFlight;

    const work = this.fetch(storageKey).finally(() => this.loading.delete(storageKey));
    this.loading.set(storageKey, work);
    return work;
  }

  private async fetch(storageKey: string): Promise<CachedArtifact | undefined> {
    let archive: Buffer;

    try {
      const stream = await this.storage.get(storageKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
      archive = Buffer.concat(chunks);
    } catch (error) {
      this.log.error({ err: error, storageKey }, 'a deployment artifact could not be read');
      return undefined;
    }

    const entries = await readSnapshotArchive(archive);
    const files = new Map<string, ArtifactFile>();
    let bytes = 0;

    for (const entry of entries) {
      if (entry.content === null) continue;
      const content = Buffer.from(entry.content);
      files.set(entry.path, { content, contentType: contentTypeFor(entry.path) });
      bytes += content.byteLength;
    }

    const artifact: CachedArtifact = { files, bytes };

    /*
     * A site larger than the whole budget is served and not cached.
     *
     * Caching it would evict everything else and then be evicted itself on the
     * next request, which is the worst of both. Returning it uncached is slower
     * for that one site and leaves every other site alone.
     */
    if (bytes <= this.options.maxCacheBytes) {
      this.cache.set(storageKey, artifact);
      this.bytes += bytes;
      this.evict();
    }

    return artifact;
  }

  /** Drops the least recently used sites until the cache fits again. */
  private evict(): void {
    while (this.bytes > this.options.maxCacheBytes) {
      const oldest = this.cache.keys().next();
      if (oldest.done) return;

      const held = this.cache.get(oldest.value);
      this.cache.delete(oldest.value);
      this.bytes -= held?.bytes ?? 0;
    }
  }
}

/**
 * The paths a request could mean, in order of preference.
 *
 * A directory has no content of its own, so `/docs` and `/docs/` both mean
 * `docs/index.html`. This is the one convention every static host implements
 * and the one people expect without being told.
 */
function candidatePaths(path: string): string[] {
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '');

  if (trimmed === '') return ['index.html'];
  return [trimmed, `${trimmed}/index.html`];
}

/**
 * What to say a file is.
 *
 * A small table rather than a dependency. What matters here is not breadth but
 * that the answer is never guessed from the bytes: everything unknown is
 * `application/octet-stream`, and the listener sends `nosniff` alongside it, so
 * a file somebody uploaded cannot be talked into executing as something else.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}
