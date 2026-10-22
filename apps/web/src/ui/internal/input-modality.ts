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

install();

export function lastInputWasKeyboard(): boolean {
  install();
  return keyboard;
}
