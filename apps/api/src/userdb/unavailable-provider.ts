import { AppError } from '../errors/app-error.js';
import type { UserDatabaseProvider, UserDatabaseSpec, UserDatabaseSummary } from './provider.js';

export class UnavailableUserDatabaseProvider implements UserDatabaseProvider {
  readonly name = 'none';

  private readonly reason =
    'This installation has no database server configured for projects, so a project cannot be given a database.';

  unavailableReason(): Promise<string | null> {
    return Promise.resolve(this.reason);
  }

  provision(_spec: UserDatabaseSpec): Promise<void> {
    return Promise.reject(this.refusal());
  }

  setPassword(_role: string, _password: string): Promise<void> {
    return Promise.reject(this.refusal());
  }

  drop(): Promise<void> {
    return Promise.resolve();
  }

  reset(): Promise<void> {
    return Promise.reject(this.refusal());
  }

  sizeOf(): Promise<number | null> {
    return Promise.resolve(null);
  }

  list(): Promise<UserDatabaseSummary[]> {
    return Promise.resolve([]);
  }

  private refusal(): AppError {
    return new AppError('SERVICE_UNAVAILABLE', this.reason, { expose: true });
  }
}
