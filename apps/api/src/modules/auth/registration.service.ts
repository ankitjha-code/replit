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

export class RegistrationService {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly log: Logger,
  ) {}

  async register(input: RegisterRequest): Promise<PublicUser> {
    const email = normalizeEmail(input.email);
    const username = normalizeUsername(input.username);

    const taken = await this.users.existsByEmailOrUsername(email, username);
    if (taken.email) throw emailTaken();
    if (taken.username) throw usernameTaken();

    const passwordHash = await this.hasher.hash(input.password);

    const result = await this.users.create({
      email,
      username,
      passwordHash,
      displayName: input.displayName,
    });

    if (!result.ok) {
      if (result.conflict === 'email') throw emailTaken();
      if (result.conflict === 'username') throw usernameTaken();
      throw new AppError('CONFLICT', 'That account could not be created');
    }

    this.log.info({ userId: result.user.id }, 'user registered');

    return toPublicUser(result.user);
  }
}

const emailTaken = (): AppError =>
  new AppError('CONFLICT', 'An account with that email already exists', {
    details: { field: 'email' },
  });

const usernameTaken = (): AppError =>
  new AppError('CONFLICT', 'That username is already taken', {
    details: { field: 'username' },
  });
