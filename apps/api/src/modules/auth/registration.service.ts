import {
  normalizeEmail,
  normalizeUsername,
  type PublicUser,
  type RegisterRequest,
} from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { PasswordHasher } from '../../lib/password.js';
import { toPublicUser, type UserRepository } from '../users/user.repository.js';

/**
 * Account creation.
 *
 * All the policy lives here: normalisation, duplicate handling, hashing. The
 * repository below performs no judgement and the controller above performs
 * none either, which is what makes this testable with a fake repository and no
 * database.
 */
export class RegistrationService {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly log: Logger,
  ) {}

  async register(input: RegisterRequest): Promise<PublicUser> {
    const email = normalizeEmail(input.email);
    const username = normalizeUsername(input.username);

    // Checked up front so the common case gives a precise message naming the
    // field. This is advisory only: two simultaneous registrations both pass
    // it, which is why the unique constraint below is the real guard.
    const taken = await this.users.existsByEmailOrUsername(email, username);
    if (taken.email) throw emailTaken();
    if (taken.username) throw usernameTaken();

    // Hashing is deliberate work. Doing it after the existence check means a
    // duplicate registration does not cost 19 MiB and a key derivation.
    const passwordHash = await this.hasher.hash(input.password);

    const result = await this.users.create({
      email,
      username,
      passwordHash,
      displayName: input.displayName,
    });

    if (!result.ok) {
      // Lost a race against a concurrent registration, or the check above
      // missed a case-only username difference. Either way the database is
      // authoritative.
      if (result.conflict === 'email') throw emailTaken();
      if (result.conflict === 'username') throw usernameTaken();
      throw new AppError('CONFLICT', 'That account could not be created');
    }

    // No email, username or password in the log line. The id is enough to
    // find the row, and the row is the place that holds the detail.
    this.log.info({ userId: result.user.id }, 'user registered');

    return toPublicUser(result.user);
  }
}

/**
 * Registration necessarily reveals whether an address is already in use: any
 * design that hides it either creates duplicate accounts or leaves the user
 * unable to tell why signup failed. The exposure is mitigated by rate limiting
 * the endpoint, not by returning a message the user cannot act on.
 */
const emailTaken = (): AppError =>
  new AppError('CONFLICT', 'An account with that email already exists', {
    details: { field: 'email' },
  });

const usernameTaken = (): AppError =>
  new AppError('CONFLICT', 'That username is already taken', {
    details: { field: 'username' },
  });
