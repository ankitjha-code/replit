import type { ReactNode } from 'react';

/**
 * One anchor target on a settings page. The id is what the in-page nav links
 * to; the section components inside keep their own headings.
 */
export function SettingsSection({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div id={id} className="settings-section">
      {children}
    </div>
  );
}
