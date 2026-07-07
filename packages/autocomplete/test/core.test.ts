import { describe, expect, it } from "vitest";
import { LruCache } from "../src/core/lru.js";
import { buildPrompt, cacheKey } from "../src/core/prompt.js";
import {
  stripFences,
  transcriptDirMatchesToken,
  trimPrefixOverlap,
  trimSuffixOverlap,
} from "../src/core/text.js";

describe("stripFences", () => {
  it("removes a python fence", () => {
    expect(stripFences("```python\nx = 1\n```")).toBe("x = 1");
  });
  it("removes a bare fence", () => {
    expect(stripFences("```\nx = 1\n```")).toBe("x = 1");
  });
  it("leaves unfenced text alone", () => {
    expect(stripFences("x = 1")).toBe("x = 1");
  });
  it("keeps inner backticks", () => {
    expect(stripFences("f'`{x}`'")).toBe("f'`{x}`'");
  });
});

describe("trimPrefixOverlap", () => {
  it("removes an echoed current line", () => {
    expect(trimPrefixOverlap("def add(a, b):\n    return ", "return a + b")).toBe("a + b");
  });
  it("passes through non-overlapping completions", () => {
    expect(trimPrefixOverlap("x = ", "1 + 2")).toBe("1 + 2");
  });
  it("handles completion equal to prefix tail", () => {
    expect(trimPrefixOverlap("abc", "abc")).toBe("");
  });
});

describe("trimSuffixOverlap", () => {
  it("removes a re-closed quote already present in the suffix", () => {
    expect(trimSuffixOverlap("'", "{name}!'")).toBe("{name}!");
  });
  it("removes a re-closed bracket run", () => {
    expect(trimSuffixOverlap(")\nprint(x)", "a + b)")).toBe("a + b");
  });
  it("passes through when there is no overlap", () => {
    expect(trimSuffixOverlap("\ny = 2", "x + 1")).toBe("x + 1");
  });
  it("handles empty suffix", () => {
    expect(trimSuffixOverlap("", "anything")).toBe("anything");
  });
});

describe("transcriptDirMatchesToken", () => {
  const token = "52054dd4-6c28-4ae7-9429-fe9ea646f312";
  it("matches a munged cwd dir containing the token (slashes/dots/underscores → dashes)", () => {
    expect(
      transcriptDirMatchesToken(`-private-tmp-nebula-autocomplete-ws-${token}`, token),
    ).toBe(true);
  });
  it("matches even if munging alters the token's own hyphens", () => {
    // Some munges collapse/replace separators; alphanumeric comparison still hits.
    const collapsed = "-var-folders-T-nebulaautocompletews52054dd46c284ae79429fe9ea646f312";
    expect(transcriptDirMatchesToken(collapsed, token)).toBe(true);
  });
  it("does NOT match an unrelated real project dir", () => {
    expect(transcriptDirMatchesToken("-Users-jianzhou-Code-nebula-notebook", token)).toBe(false);
  });
  it("empty token never matches (guards against nuking everything)", () => {
    expect(transcriptDirMatchesToken("-Users-anything", "")).toBe(false);
  });
});

describe("LruCache", () => {
  it("evicts the least recently used entry", () => {
    const c = new LruCache<number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a"); // refresh a
    c.set("c", 3); // evicts b
    expect(c.get("a")).toBe(1);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("c")).toBe(3);
  });
  it("capacity 0 disables caching", () => {
    const c = new LruCache<number>(0);
    c.set("a", 1);
    expect(c.get("a")).toBeUndefined();
  });
});

describe("buildPrompt", () => {
  const opts = { contextBudget: 100, maxLines: 5 };

  it("marks the cursor and includes suffix", () => {
    const p = buildPrompt({ prefix: "x = ", suffix: "\ny = 2" }, opts);
    expect(p).toContain("x = <CURSOR>\ny = 2");
  });

  it("includes nearby cells and comments markdown", () => {
    const p = buildPrompt(
      {
        prefix: "df.",
        cells: [
          { type: "markdown", content: "Load data" },
          { type: "code", content: "import pandas as pd" },
          { type: "code", content: "df." },
        ],
        activeCellIndex: 2,
      },
      opts,
    );
    expect(p).toContain("# Load data");
    expect(p).toContain("import pandas as pd");
  });

  it("includes kernel/filename hints and does not hardcode a language", () => {
    const p = buildPrompt({ prefix: "x", kernelName: "ir", filename: "a.ipynb" }, opts);
    expect(p).toContain("kernel=ir");
    expect(p).toContain("file=a.ipynb");
    expect(p).not.toContain("(python)");
  });

  it("omits the hint clause entirely when no hints are given", () => {
    const p = buildPrompt({ prefix: "x" }, opts);
    expect(p).not.toContain("Hints");
  });

  it("drops cells beyond the budget, keeping nearest", () => {
    const far = { type: "code" as const, content: "far_away = 1".repeat(20) };
    const near = { type: "code" as const, content: "near = 2" };
    const p = buildPrompt(
      {
        prefix: "x",
        cells: [far, near, { type: "code", content: "x" }],
        activeCellIndex: 2,
      },
      { contextBudget: 20, maxLines: 5 },
    );
    expect(p).toContain("near = 2");
    expect(p).not.toContain("far_away");
  });
});

describe("cacheKey", () => {
  it("differs when nearby text differs", () => {
    expect(cacheKey({ prefix: "a" })).not.toBe(cacheKey({ prefix: "b" }));
  });
  it("is stable for identical requests", () => {
    const req = { prefix: "a", suffix: "b", language: "python" };
    expect(cacheKey(req)).toBe(cacheKey({ ...req }));
  });
});
