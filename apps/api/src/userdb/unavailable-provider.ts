import { AppError } from '../errors/app-error.js';
import type { UserDatabaseProvider, UserDatabaseSpec, UserDatabaseSummary } from './provider.js';

/**
 * The provider an installation gets when no database server is configured.
 *
 * Not a stub that pretends to work. It reports why nothing can be provisioned
 * and refuses every operation with that reason, so the workspace says "this
 * installation cannot give a project a database" instead of showing one that
 * does not exist.
 */
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

  /**
   * Succeeds rather than refusing.
   *
   * Deleting a project must not be blocked by there being nowhere for its
   * database to have been. There is nothing to remove, which is the state the
   * caller asked for.
   */
  drop(): Promise<void> {
    return Promise.resolve();
  }

  reset(): Promise<void> {
    return Promise.reject(this.refusal());
  }

  /** Null rather than zero: nothing was measured, so nothing is claimed. */
  sizeOf(): Promise<number | null> {
    return Promise.resolve(null);
  }

  /** No server, so nothing here was ever made. Empty, not a refusal. */
  list(): Promise<UserDatabaseSummary[]> {
    return Promise.resolve([]);
  }

  private refusal(): AppError {
    return new AppError('SERVICE_UNAVAILABLE', this.reason, { expose: true });
  }
}
