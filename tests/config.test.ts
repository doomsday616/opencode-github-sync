import { describe, expect, it } from "vitest";
import { parseNameStatus } from "../src/core/git.js";
import { commitMessage, hostAlias, sanitizeAlias } from "../src/core/host.js";
import { deepMerge, parseJsonc } from "../src/core/jsonc.js";
import { stripOverrides } from "../src/core/overrides.js";
import { isLocalRuntimePath } from "../src/core/repo.js";
import { pluginSpecToName } from "../src/core/stage.js";

describe("parseJsonc", () => {
  it("strips line and block comments", () => {
    const parsed = parseJsonc(`{
      // a line comment
      "a": 1, /* inline */
      /* block
         comment */
      "b": 2
    }`);
    expect(parsed).toEqual({ a: 1, b: 2 });
  });

  it("removes trailing commas in objects and arrays", () => {
    expect(parseJsonc('{ "a": [1, 2, 3,], }')).toEqual({ a: [1, 2, 3] });
  });

  it("leaves comment-like sequences inside strings alone", () => {
    const parsed = parseJsonc('{ "url": "https://example.com//x", "glob": "/* not a comment" }');
    expect(parsed).toEqual({ url: "https://example.com//x", glob: "/* not a comment" });
  });

  it("handles escaped quotes", () => {
    expect(parseJsonc('{ "a": "say \\"hi\\" // now" }')).toEqual({ a: 'say "hi" // now' });
  });

  it("strips a UTF-8 BOM", () => {
    expect(parseJsonc('\uFEFF{ "a": 1 }')).toEqual({ a: 1 });
  });

  it("reports a helpful error for malformed input", () => {
    expect(() => parseJsonc("{ nope }")).toThrow(/JSONC parse error/);
  });
});

describe("deepMerge", () => {
  it("merges nested objects key by key", () => {
    expect(deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 } })).toEqual({
      a: { x: 1, y: 3, z: 4 },
    });
  });

  it("replaces arrays instead of concatenating", () => {
    expect(deepMerge({ a: [1, 2, 3] }, { a: [9] })).toEqual({ a: [9] });
  });

  it("deletes a key when the patch value is null", () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
  });

  it("does not mutate the inputs", () => {
    const base = { a: { x: 1 } };
    deepMerge(base, { a: { y: 2 } });
    expect(base).toEqual({ a: { x: 1 } });
  });
});

describe("stripOverrides", () => {
  it("restores the repository value for an overridden key", () => {
    const effective = { model: "local-model", theme: "dark" };
    const overrides = { model: "local-model" };
    const previous = { model: "shared-model", theme: "light" };
    expect(stripOverrides(effective, overrides, previous)).toEqual({
      model: "shared-model",
      theme: "dark",
    });
  });

  it("drops a key the repository has never seen", () => {
    const result = stripOverrides({ proxy: "corp", theme: "dark" }, { proxy: "corp" }, {});
    expect(result).toEqual({ theme: "dark" });
  });

  it("recurses into nested overrides without discarding siblings", () => {
    const effective = { mcp: { a: { enabled: true }, b: { enabled: true } } };
    const overrides = { mcp: { a: { enabled: true } } };
    const previous = { mcp: { a: { enabled: false }, b: { enabled: false } } };
    expect(stripOverrides(effective, overrides, previous)).toEqual({
      mcp: { a: { enabled: false }, b: { enabled: true } },
    });
  });

  it("is a no-op when there are no overrides", () => {
    const effective = { a: 1, b: { c: 2 } };
    expect(stripOverrides(effective, {}, { a: 9 })).toEqual(effective);
  });
});

describe("pluginSpecToName", () => {
  it.each([
    ["opencode-foo", "opencode-foo"],
    ["opencode-foo@latest", "opencode-foo"],
    ["opencode-foo@1.2.3", "opencode-foo"],
    ["@scope/opencode-foo", "@scope/opencode-foo"],
    ["@scope/opencode-foo@0.2.1", "@scope/opencode-foo"],
  ])("%s -> %s", (input, expected) => {
    expect(pluginSpecToName(input)).toBe(expected);
  });
});

describe("hostAlias", () => {
  it("prefers the environment variable", () => {
    process.env.OPENCODE_SYNC_HOST_ALIAS = "my machine";
    expect(hostAlias("configured")).toBe("my-machine");
    delete process.env.OPENCODE_SYNC_HOST_ALIAS;
  });

  it("falls back to a configured alias", () => {
    expect(hostAlias("laptop")).toBe("laptop");
  });

  it("never leaks the raw hostname", () => {
    const alias = hostAlias();
    expect(alias).toMatch(/^(win|mac|linux)-[0-9a-f]{6}$/);
  });

  it("is stable across calls", () => {
    expect(hostAlias()).toBe(hostAlias());
  });

  it("sanitises unsafe characters", () => {
    expect(sanitizeAlias("a/b\\c:d")).toBe("a-b-c-d");
    expect(sanitizeAlias("   ")).toBe("unknown");
  });

  it("builds a commit message with the alias", () => {
    expect(commitMessage("sync", "laptop")).toMatch(
      /^sync: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} from laptop$/,
    );
  });
});

describe("isLocalRuntimePath", () => {
  it.each([
    ["_data/opencode.db", true],
    ["_data/opencode.db-wal", true],
    ["_data/storage/session/abc.json", true],
    ["_data/tool-output/x", true],
    ["_data/storage/project/a.json", false],
    ["_data/storage/migration", false],
    ["opencode.jsonc", false],
    ["_sessions/ses_1.json.gz", false],
  ])("%s -> %s", (input, expected) => {
    expect(isLocalRuntimePath(input)).toBe(expected);
  });

  it("normalises Windows separators", () => {
    expect(isLocalRuntimePath("_data\\opencode.db")).toBe(true);
  });
});

describe("parseNameStatus", () => {
  it("maps status characters to change kinds", () => {
    const entries = parseNameStatus("A\tnew.txt\nM\tmod.txt\nD\tgone.txt");
    expect(entries).toEqual([
      { kind: "added", path: "new.txt" },
      { kind: "modified", path: "mod.txt" },
      { kind: "deleted", path: "gone.txt" },
    ]);
  });

  it("uses the destination path for renames", () => {
    expect(parseNameStatus("R100\told.txt\tnew.txt")).toEqual([
      { kind: "renamed", path: "new.txt" },
    ]);
  });

  it("ignores blank and unknown lines", () => {
    expect(parseNameStatus("\nU\tconflict.txt\n")).toEqual([]);
  });
});
