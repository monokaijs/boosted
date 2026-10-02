import "@testing-library/jest-dom/vitest";
import { beforeEach, vi } from "vitest";

// jsdom has no layout scrolling; Radix Select scrolls its keyboard-focused option.
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

// Node's optional localStorage shadows jsdom storage on recent Node releases.
const values = new Map<string, string>();
const storage: Storage = {
  get length() { return values.size; },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => { values.delete(key); },
  setItem: (key, value) => { values.set(key, String(value)); },
};
vi.stubGlobal("localStorage", storage);
beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", storage);
});
