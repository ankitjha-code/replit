import { extname } from 'node:path';
import type { Logger } from 'pino';
import type { StorageProvider } from '../storage/provider.js';
import { readSnapshotArchive } from '../modules/snapshots/snapshot-archive.js';

export interface ArtifactFile {
  content: Buffer;
  contentType: string;
}

export interface ArtifactStoreOptions {
  maxCacheBytes: number;
}

interface CachedArtifact {
  files: Map<string, ArtifactFile>;
  bytes: number;
}

export class ArtifactStore {
  private readonly cache = new Map<string, CachedArtifact>();
  private bytes = 0;

  private readonly loading = new Map<string, Promise<CachedArtifact | undefined>>();

  constructor(
    private readonly storage: StorageProvider,
    private readonly options: ArtifactStoreOptions,
    private readonly log: Logger,
  ) {}

  async file(storageKey: string, path: string): Promise<ArtifactFile | undefined> {
    const artifact = await this.load(storageKey);
    if (!artifact) return undefined;

    for (const candidate of candidatePaths(path)) {
      const found = artifact.files.get(candidate);
      if (found) return found;
    }

    return undefined;
  }

  forget(storageKey: string): void {
    const held = this.cache.get(storageKey);
    if (!held) return;
    this.cache.delete(storageKey);
    this.bytes -= held.bytes;
  }

  private async load(storageKey: string): Promise<CachedArtifact | undefined> {
    const cached = this.cache.get(storageKey);
    if (cached) {
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

    if (bytes <= this.options.maxCacheBytes) {
      this.cache.set(storageKey, artifact);
      this.bytes += bytes;
      this.evict();
    }

    return artifact;
  }

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

function candidatePaths(path: string): string[] {
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '');

  if (trimmed === '') return ['index.html'];
  return [trimmed, `${trimmed}/index.html`];
}

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
