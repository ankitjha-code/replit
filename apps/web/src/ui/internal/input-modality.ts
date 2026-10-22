/*
 * Whether the last thing the user did was press a key. Tooltips open on
 * focus only then: focus that arrives from a click or from a dialog's
 * auto-focus would otherwise pop a tooltip nobody asked for, and its Escape
 * would then close the tooltip instead of the dialog.
 */
let keyboard = false;
let installed = false;

function install(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener(
    'keydown',
    () => {
      keyboard = true;
    },
    true,
  );
  for (const type of ['pointerdown', 'mousedown', 'touchstart'] as const) {
    document.addEventListener(
      type,
      () => {
        keyboard = false;
      },
      true,
    );
  }
}

// Listening from module load, so the key press that moves focus is seen.
install();

export function lastInputWasKeyboard(): boolean {
  install();
  return keyboard;
}
