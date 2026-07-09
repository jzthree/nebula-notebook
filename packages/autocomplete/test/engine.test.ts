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

describe("single-flight per session (typing-burst protection)", () => {
  it("never runs more than one backend turn per session concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const backend = fakeBackend(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      return "x = 1";
    });
    const engine = new AutocompleteEngine({ backend });
    // A burst of distinct requests on the same cell — like fast typing.
    const results = await Promise.allSettled([
      engine.complete({ prefix: "a", sessionKey: "cell-1" }),
      engine.complete({ prefix: "ab", sessionKey: "cell-1" }),
      engine.complete({ prefix: "abc", sessionKey: "cell-1" }),
      engine.complete({ prefix: "abcd", sessionKey: "cell-1" }),
    ]);
    expect(maxInFlight).toBe(1);
    // Latest wins; superseded ones rejected.
    expect(results[3].status).toBe("fulfilled");
  });

  it("superseded-while-queued requests never reach the backend", async () => {
    const backend = fakeBackend(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return "y";
    });
    const engine = new AutocompleteEngine({ backend });
    const p1 = engine.complete({ prefix: "one", sessionKey: "c" });   // dispatches
    const p2 = engine.complete({ prefix: "two", sessionKey: "c" });   // queues, then superseded
    const p3 = engine.complete({ prefix: "three", sessionKey: "c" }); // queues, wins
    const [r1, r2, r3] = await Promise.allSettled([p1, p2, p3]);
    expect(r3.status).toBe("fulfilled");
    expect(r2.status).toBe("rejected"); // superseded while queued
    // Backend saw the first (already dispatched) and the last — NOT the middle.
    expect(backend.calls.length).toBe(2);
    void r1;
  });

  it("different sessions still run in parallel", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const backend = fakeBackend(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      return "z";
    });
    const engine = new AutocompleteEngine({ backend });
    await Promise.all([
      engine.complete({ prefix: "a", sessionKey: "cell-1" }),
      engine.complete({ prefix: "b", sessionKey: "cell-2" }),
    ]);
    expect(maxInFlight).toBe(2);
  });
});
