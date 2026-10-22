import { NavLink } from 'react-router-dom';
import type { ProjectRole } from '@platform/shared';
import { Lock } from '../../ui/icons.js';
import { VisuallyHidden } from '../../ui/index.js';
import { SETTINGS_GROUPS, canOpenSettingsPage, settingsPath } from './pages.js';

/**
 * The settings sidebar: five goal groups, ten pages, always all visible.
 *
 * A page the person cannot open still appears, with a lock, because hiding it
 * was the original complaint: an editor could not tell whether deployments
 * existed at all. Below 900px the same list lays out as a scrolling row.
 */
export function SettingsNav({
  projectId,
  role,
}: {
  projectId: string;
  /** Undefined while the project is still loading: no locks are drawn yet. */
  role: ProjectRole | undefined;
}): React.JSX.Element {
  return (
    <nav aria-label="Project settings" className="settings-nav">
      {SETTINGS_GROUPS.map((group) => (
        <div key={group.label} className="settings-nav__group">
          <p className="settings-nav__label" id={`settings-group-${group.label}`}>
            {group.label}
          </p>
          <ul className="settings-nav__list" aria-labelledby={`settings-group-${group.label}`}>
            {group.pages.map((page) => {
              const locked = role !== undefined && !canOpenSettingsPage(page, role);
              return (
                <li key={page.id}>
                  <NavLink to={settingsPath(projectId, page.id)} className="settings-nav__link">
                    <page.icon size={16} aria-hidden="true" />
                    <span>{page.label}</span>
                    {locked ? (
                      <>
                        <Lock size={14} className="settings-nav__lock" aria-hidden="true" />
                        <VisuallyHidden>, owner only</VisuallyHidden>
                      </>
                    ) : null}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
