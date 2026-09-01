import '@testing-library/jest-dom/vitest';

// Mock IntersectionObserver for OptimizedImage tests
class MockIntersectionObserver {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {
    // Immediately trigger intersection for tests
    this.callback([{ isIntersecting: true, target: document.createElement('div') }]);
  }
  disconnect() {}
  unobserve() {}
}

globalThis.IntersectionObserver = MockIntersectionObserver;

// Mock window.matchMedia for components that use it
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
