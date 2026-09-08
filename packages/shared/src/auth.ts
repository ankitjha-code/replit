import { z } from 'zod';

/**
 * Registration contract.
 *
 * The same schema validates the form in the browser and the request body on
 * the server. The client copy exists to give fast feedback; the server copy is
 * the one that decides, and it runs regardless of what the client did.
 */

export const PASSWORD_MIN_LENGTH = 10;
/**
 * Argon2 itself has no meaningful input limit, but an unbounded password is a
 * cheap way to make the server do expensive work. This is far above any real
 * passphrase.
 */
export const PASSWORD_MAX_LENGTH = 200;

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 39;

/** RFC 5321 caps the whole address here, and the column matches. */
export const EMAIL_MAX_LENGTH = 320;

/**
 * Usernames appear in URLs and, later, in per-project hostnames. Anything
 * outside this set would need escaping somewhere and eventually would not get
 * it.
 */
const USERNAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9]))*$/;

/**
 * Names that would collide with platform routes, hostnames or well-known
 * paths. Taking one would let a user shadow a real part of the product.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'about',
  'account',
  'admin',
  'api',
  'app',
  'apps',
  'assets',
  'auth',
  'billing',
  'blog',
  'cdn',
  'dashboard',
  'deploy',
  'deployments',
  'docs',
  'download',
  'files',
  'ftp',
  'graphql',
  'health',
  'help',
  'home',
  'imap',
  'internal',
  'legal',
  'login',
  'logout',
  'mail',
  'me',
  'new',
  'null',
  'oauth',
  'preview',
  'pricing',
  'privacy',
  'project',
  'projects',
  'public',
  'register',
  'root',
  'security',
  'settings',
  'signin',
  'signup',
  'smtp',
  'static',
  'status',
  'support',
  'system',
  'terms',
  'undefined',
  'user',
  'users',
  'www',
  'ws',
]);

/**
 * Passwords seen so often that they are tried first in any credential attack.
 *
 * A short embedded list, not a breach corpus. Checking a real breach corpus
 * means a network call to a third party on every registration, which is a
 * decision about user data, not a detail to slip in here.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  '0123456789',
  '1234567890',
  '12345678910',
  'aaaaaaaaaa',
  'abcdefghij',
  'adminadmin',
  'iloveyou11',
  'letmein123',
  'password01',
  'password11',
  'password12',
  'password123',
  'passw0rd12',
  'qwerty1234',
  'qwertyuiop',
  'welcome123',
]);

export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.toLowerCase());
}

/**
 * Lowercased and trimmed, and nothing else.
 *
 * Stripping dots or plus-addressing is provider-specific. Applying Gmail's
 * rules to every domain would merge accounts that are genuinely different
 * people.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeUsername(username: string): string {
  return username.trim();
}

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(EMAIL_MAX_LENGTH, `Email must be at most ${EMAIL_MAX_LENGTH} characters`)
  .pipe(z.email('Enter a valid email address'));

export const usernameSchema = z
  .string()
  .trim()
  .min(USERNAME_MIN_LENGTH, `Username must be at least ${USERNAME_MIN_LENGTH} characters`)
  .max(USERNAME_MAX_LENGTH, `Username must be at most ${USERNAME_MAX_LENGTH} characters`)
  .regex(USERNAME_PATTERN, 'Username may contain letters, numbers and single hyphens between them')
  .refine(
    (value) => !RESERVED_USERNAMES.has(value.toLowerCase()),
    'That username is reserved by the platform',
  );

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((value) => !isCommonPassword(value), 'That password is too easily guessed');

export const displayNameSchema = z.string().trim().min(1).max(100);

export const registerRequestSchema = z
  .object({
    email: emailSchema,
    username: usernameSchema,
    password: passwordSchema,
    displayName: displayNameSchema.optional(),
  })
  .refine(
    // A password containing the account it protects is guessed alongside it.
    (value) => !value.password.toLowerCase().includes(value.username.toLowerCase()),
    { message: 'Password must not contain your username', path: ['password'] },
  )
  .refine(
    (value) => {
      const localPart = value.email.split('@')[0]?.toLowerCase() ?? '';
      return localPart.length < 4 || !value.password.toLowerCase().includes(localPart);
    },
    { message: 'Password must not contain your email address', path: ['password'] },
  );

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/**
 * The only shape of a user that ever leaves the server.
 *
 * There is no field here to accidentally widen into a password hash: anything
 * not listed is not sent.
 */
export const publicUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  createdAt: z.string(),
  /**
   * Whether the address has been proved.
   *
   * A boolean rather than the timestamp behind it: when somebody verified is a
   * fact about the account that the account holder's own browser has no use
   * for, and the page only ever asks whether to show a prompt.
   */
  emailVerified: z.boolean(),
  /**
   * Whether this account may see the installation as a whole.
   *
   * On the public user because the browser has to know whether to show the
   * operations link at all. It grants nothing on its own — every operator route
   * checks the database — but a menu item that leads to a refusal is worse than
   * no menu item.
   */
  isOperator: z.boolean(),
});

export type PublicUser = z.infer<typeof publicUserSchema>;

export const registerResponseSchema = z.object({
  user: publicUserSchema,
});

export type RegisterResponse = z.infer<typeof registerResponseSchema>;

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

/**
 * Sign-in accepts either identifier, because people remember one or the other
 * and forcing a choice between two fields helps nobody.
 *
 * No format validation on the identifier and no policy check on the password:
 * rules that apply when choosing a credential must not apply when presenting
 * one. A user whose password predates a policy change still has to be able to
 * sign in, and rejecting a malformed identifier early would confirm which
 * shapes the system considers plausible.
 */
export const loginRequestSchema = z.object({
  identifier: z.string().trim().min(1, 'Enter your email or username').max(EMAIL_MAX_LENGTH),
  password: z.string().min(1, 'Enter your password').max(PASSWORD_MAX_LENGTH),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** True when the identifier is an email rather than a username. */
export function identifierIsEmail(identifier: string): boolean {
  return identifier.includes('@');
}

export const sessionSummarySchema = z.object({
  /** When the session stops being valid no matter how active it is. */
  expiresAt: z.string(),
});

export const authenticatedResponseSchema = z.object({
  user: publicUserSchema,
  session: sessionSummarySchema,
});

export type AuthenticatedResponse = z.infer<typeof authenticatedResponseSchema>;

/** Answer to "who am I": the user, or explicitly nobody. */
export const currentUserResponseSchema = z.object({
  user: publicUserSchema.nullable(),
});

export type CurrentUserResponse = z.infer<typeof currentUserResponseSchema>;
