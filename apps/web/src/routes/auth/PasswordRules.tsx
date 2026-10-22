import type { ReactElement } from 'react';
import { PASSWORD_MIN_LENGTH, isCommonPassword } from '@platform/shared';
import { CheckCircle, Circle } from '../../ui/icons.js';

export interface PasswordRule {
  id: 'length' | 'common' | 'username';
  label: string;
  met: boolean;
}

/**
 * The three rules from the shared schema, as they stand for what is typed so
 * far. The wording deliberately avoids "at least 10 characters": that phrase
 * is the schema's error message, which the tests look for on its own.
 */
export function passwordRules(password: string, username: string): PasswordRule[] {
  const typed = password.length > 0;
  const name = username.trim().toLowerCase();
  return [
    {
      id: 'length',
      label: `${PASSWORD_MIN_LENGTH} characters or more`,
      met: password.length >= PASSWORD_MIN_LENGTH,
    },
    {
      id: 'common',
      label: 'Not a commonly used password',
      met: typed && !isCommonPassword(password),
    },
    {
      id: 'username',
      label: 'Does not contain your username',
      met: typed && (name === '' || !password.toLowerCase().includes(name)),
    },
  ];
}

/**
 * The checklist under the password field on the sign-up page; it ticks while
 * the user types. Its accessible name avoids the word "password" because
 * Playwright's `getByLabel('Password')` matches substrings and the browser
 * tests fill the field through it.
 */
export function PasswordRules({ rules }: { rules: PasswordRule[] }): ReactElement {
  return (
    <ul className="auth-rules" aria-label="Requirements">
      {rules.map((rule) => {
        const Icon = rule.met ? CheckCircle : Circle;
        return (
          <li
            key={rule.id}
            className={rule.met ? 'auth-rules__item auth-rules__item--met' : 'auth-rules__item'}
          >
            <Icon
              size={14}
              weight={rule.met ? 'fill' : 'regular'}
              className="auth-rules__icon"
              aria-hidden="true"
            />
            <span>{rule.label}</span>
            <span className="visually-hidden">{rule.met ? ', done' : ', not yet'}</span>
          </li>
        );
      })}
    </ul>
  );
}
