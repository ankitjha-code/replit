import { useSyncExternalStore, type ReactElement } from 'react';
import { Toast as Primitive } from 'radix-ui';
import { IconButton } from '../IconButton/IconButton.js';
import { CheckCircle, Info, Warning, X, XCircle } from '../icons.js';
import { cx } from '../internal/cx.js';
import {
  TOAST_DURATION_MS,
  TOAST_LIMIT,
  dismissToast,
  getToasts,
  subscribeToasts,
  type ToastRecord,
  type ToastTone,
} from './toast-store.js';
import './Toast.css';

export {
  toast,
  dismissToast,
  clearToasts,
  useToast,
  TOAST_DURATION_MS,
  TOAST_LIMIT,
} from './toast-store.js';
export type { ToastApi, ToastOptions, ToastRecord, ToastTone } from './toast-store.js';

const ICONS: Record<ToastTone, typeof Info> = {
  success: CheckCircle,
  info: Info,
  warn: Warning,
  danger: XCircle,
};

function ToastItem({ record }: { record: ToastRecord }): ReactElement {
  const Icon = ICONS[record.tone];
  const danger = record.tone === 'danger';
  return (
    <Primitive.Root
      className={cx('ui-toast', `ui-toast--${record.tone}`)}
      open={record.open}
      onOpenChange={(open) => {
        if (!open) dismissToast(record.id);
      }}
      duration={record.duration}
      type={danger ? 'foreground' : 'background'}
      role={danger ? 'alert' : 'status'}
      data-tone={record.tone}
    >
      <Icon size={16} className="ui-toast__icon" aria-hidden="true" />
      <div className="ui-toast__body">
        <Primitive.Title className="ui-toast__title">{record.title}</Primitive.Title>
        {record.description ? (
          <Primitive.Description className="ui-toast__description">
            {record.description}
          </Primitive.Description>
        ) : null}
        {record.action ? (
          <Primitive.Action asChild altText={record.action.label}>
            <button type="button" className="ui-toast__action" onClick={record.action.onClick}>
              {record.action.label}
            </button>
          </Primitive.Action>
        ) : null}
      </div>
      <Primitive.Close asChild>
        <IconButton label="Dismiss" icon={X} size="sm" className="ui-toast__close" />
      </Primitive.Close>
    </Primitive.Root>
  );
}

export function Toaster(): ReactElement {
  const records = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  const visible: ToastRecord[] = [];
  let open = 0;
  for (const record of records) {
    if (record.open) {
      if (open >= TOAST_LIMIT) continue;
      open++;
    }
    visible.push(record);
  }
  return (
    <Primitive.Provider duration={TOAST_DURATION_MS} swipeDirection="right">
      {visible.map((record) => (
        <ToastItem key={record.id} record={record} />
      ))}
      <Primitive.Viewport
        className="ui-toast-viewport"
        data-ui-portal="toast"
        label="Notifications ({hotkey})"
      />
    </Primitive.Provider>
  );
}
