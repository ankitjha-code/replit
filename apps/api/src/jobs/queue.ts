export interface JobQueue {
  readonly name: string;

  unavailableReason(): Promise<string | null>;

  publish(): void;

  subscribe(listener: () => void): () => void;

  close(): Promise<void>;
}
