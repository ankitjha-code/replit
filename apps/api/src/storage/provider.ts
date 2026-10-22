import type { Readable } from 'node:stream';

export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date | undefined;
}

export interface StorageProvider {
  readonly name: string;

  unavailableReason(): Promise<string | null>;

  put(key: string, body: Buffer, contentType: string): Promise<void>;

  get(key: string): Promise<Readable>;

  delete(key: string): Promise<void>;

  list(prefix: string): Promise<StoredObject[]>;
}
