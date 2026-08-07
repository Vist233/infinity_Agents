import "@testing-library/jest-dom/vitest";

// jsdom does not implement ResizeObserver, which Radix UI components rely on.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
