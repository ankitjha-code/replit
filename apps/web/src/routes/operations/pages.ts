import { OPERATIONS_PAGES } from '../../shell/commands.js';
import { Broom, HardDrives, Pulse, Scroll, Users, type Icon } from '../../ui/icons.js';

/**
 * The operations sections, in sidebar order. Slugs and labels are the shell's
 * (`OPERATIONS_PAGES`), so the header breadcrumb, the command palette and this
 * sidebar always name the same places; only the icons live here.
 */

export interface OperationsSectionDef {
  slug: string;
  label: string;
  icon: Icon;
}

const ICONS: Record<string, Icon> = {
  '': Pulse,
  hosts: HardDrives,
  accounts: Users,
  cleanup: Broom,
  audit: Scroll,
};

export const OPERATIONS_SECTIONS: readonly OperationsSectionDef[] = OPERATIONS_PAGES.map(
  (page) => ({
    slug: page.slug,
    label: page.label,
    icon: ICONS[page.slug] ?? Pulse,
  }),
);

export function operationsPath(slug: string): string {
  return slug ? `/operations/${slug}` : '/operations';
}

export function findOperationsSection(slug: string | undefined): OperationsSectionDef | undefined {
  return OPERATIONS_SECTIONS.find((section) => section.slug === (slug ?? ''));
}
