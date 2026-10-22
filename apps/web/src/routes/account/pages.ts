import { ACCOUNT_PAGES } from '../../shell/commands.js';
import { Monitor, Pulse, ShieldCheck, User, Warning, type Icon } from '../../ui/icons.js';

/**
 * The account's sections, in sidebar order. The slugs and labels are the
 * shell's (`ACCOUNT_PAGES`), so the header breadcrumb, the command palette
 * and this sidebar always name the same places; only the icons live here.
 */

export interface AccountSectionDef {
  slug: string;
  label: string;
  icon: Icon;
}

const ICONS: Record<string, Icon> = {
  '': User,
  security: ShieldCheck,
  sessions: Monitor,
  usage: Pulse,
  close: Warning,
};

export const ACCOUNT_SECTIONS: readonly AccountSectionDef[] = ACCOUNT_PAGES.map((page) => ({
  slug: page.slug,
  label: page.label,
  icon: ICONS[page.slug] ?? User,
}));

export function accountPath(slug: string): string {
  return slug ? `/account/${slug}` : '/account';
}

export function findAccountSection(slug: string | undefined): AccountSectionDef | undefined {
  return ACCOUNT_SECTIONS.find((section) => section.slug === (slug ?? ''));
}
