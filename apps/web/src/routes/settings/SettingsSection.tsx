import type { ReactNode } from 'react';

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
