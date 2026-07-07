import { describe, expect, it } from "vitest";
import { AutocompleteEngine } from "../src/core/engine.js";
import type { CompletionBackend } from "../src/types.js";

function fakeBackend(
  impl: (prompt: string, opts: { signal?: AbortSignal }) => Promise<string>,
): CompletionBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "fake",
    calls,
    async complete(prompt, opts) {
      calls.push(prompt);
      return impl(prompt, opts);
    },
    dispose() {},
  };
}

describe("AutocompleteEngine", () => {
  it("completes, strips fences, and trims prefix echo", async () => {
    const backend = fakeBackend(async () => "```python\nreturn a + b\n```");
    const engine = new AutocompleteEngine({ backend });
    const res = await engine.complete({ prefix: "def add(a, b):\n    return " });
    expect(res.text).toBe("a + b");
    expect(res.fromCache).toBe(false);
  });

  it("serves repeats from cache without calling the backend", async () => {
    const backend = fakeBackend(async () => "x");
    const engine = new AutocompleteEngine({ backend });
    await engine.complete({ prefix: "a = " });
    const res = await engine.complete({ prefix: "a = " });
    expect(res.fromCache).toBe(true);
    expect(backend.calls.length).toBe(1);
  });

  it("supersedes an in-flight request with the same sessionKey", async () => {
    const backend = fakeBackend(
      (prompt, { signal }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve("done:" + prompt.length), 50);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
          });
        }),
    );
    const engine = new AutocompleteEngine({ backend });
    const first = engine.complete({ prefix: "a", sessionKey: "cell-1" });
    const second = engine.complete({ prefix: "ab", sessionKey: "cell-1" });
    await expect(first).rejects.toThrow("superseded");
    await expect(second).resolves.toMatchObject({ fromCache: false });
  });

  it("propagates an external abort signal", async () => {
    const backend = fakeBackend(
      (_p, { signal }) =>
        new Promise((_res, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const engine = new AutocompleteEngine({ backend });
    const ctrl = new AbortController();
    const p = engine.complete({ prefix: "a", sessionKey: "s" }, { signal: ctrl.signal });
    ctrl.abort(new Error("user moved on"));
    await expect(p).rejects.toThrow("user moved on");
  });
});
