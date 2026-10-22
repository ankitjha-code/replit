import '@testing-library/jest-dom/vitest';

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

if (typeof window.ResizeObserver !== 'function') {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  window.ResizeObserver = ResizeObserverStub;
}

if (typeof window.PointerEvent !== 'function') {
  class PointerEventStub extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  window.PointerEvent = PointerEventStub as unknown as typeof PointerEvent;
}

const element = window.Element.prototype;
if (typeof element.hasPointerCapture !== 'function') element.hasPointerCapture = () => false;
if (typeof element.setPointerCapture !== 'function') element.setPointerCapture = () => {};
if (typeof element.releasePointerCapture !== 'function') element.releasePointerCapture = () => {};
if (typeof element.scrollIntoView !== 'function') element.scrollIntoView = () => {};
