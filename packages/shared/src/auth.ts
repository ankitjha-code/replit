import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 39;

export const EMAIL_MAX_LENGTH = 320;

const USERNAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9]))*$/;

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
  .refine((value) => !value.password.toLowerCase().includes(value.username.toLowerCase()), {
    message: 'Password must not contain your username',
    path: ['password'],
  })
  .refine(
    (value) => {
      const localPart = value.email.split('@')[0]?.toLowerCase() ?? '';
      return localPart.length < 4 || !value.password.toLowerCase().includes(localPart);
    },
    { message: 'Password must not contain your email address', path: ['password'] },
  );

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const publicUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  createdAt: z.string(),
  emailVerified: z.boolean(),
  isOperator: z.boolean(),
});

export type PublicUser = z.infer<typeof publicUserSchema>;

export const registerResponseSchema = z.object({
  user: publicUserSchema,
});

export type RegisterResponse = z.infer<typeof registerResponseSchema>;

export const loginRequestSchema = z.object({
  identifier: z.string().trim().min(1, 'Enter your email or username').max(EMAIL_MAX_LENGTH),
  password: z.string().min(1, 'Enter your password').max(PASSWORD_MAX_LENGTH),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export function identifierIsEmail(identifier: string): boolean {
  return identifier.includes('@');
}

export const sessionSummarySchema = z.object({
  expiresAt: z.string(),
});

export const authenticatedResponseSchema = z.object({
  user: publicUserSchema,
  session: sessionSummarySchema,
});

export type AuthenticatedResponse = z.infer<typeof authenticatedResponseSchema>;

export const currentUserResponseSchema = z.object({
  user: publicUserSchema.nullable(),
});

export type CurrentUserResponse = z.infer<typeof currentUserResponseSchema>;
