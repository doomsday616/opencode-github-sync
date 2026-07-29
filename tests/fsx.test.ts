import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SymlinkRefusedError,
  copyDirRecursive,
  copyPath,
  removeNestedGitDirs,
  replaceDirAtomically,
  replaceFileAtomically,
  syncDirIncremental,
  writeIfDiffers,
} from "../src/core/fsx.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ogs-fsx-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const p = (...parts: string[]) => path.join(root, ...parts);
const write = (rel: string, content: string) => {
  const file = p(rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

describe("writeIfDiffers", () => {
  it("only writes when content changes", () => {
    const file = p("a.txt");
    expect(writeIfDiffers(file, "one")).toBe(true);
    expect(writeIfDiffers(file, "one")).toBe(false);
    expect(writeIfDiffers(file, "two")).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("two");
  });
});

describe("copyDirRecursive", () => {
  it("copies nested files and honours exclusions", () => {
    write("src/a.txt", "a");
    write("src/nested/b.txt", "b");
    write("src/nested/skip.log", "log");
    write("src/ignored/c.txt", "c");

    const count = copyDirRecursive(p("src"), p("dst"), {
      excludeFiles: new Set(["skip.log"]),
      excludeDirs: new Set(["ignored"]),
    });

    expect(count).toBe(2);
    expect(fs.existsSync(p("dst/nested/b.txt"))).toBe(true);
    expect(fs.existsSync(p("dst/nested/skip.log"))).toBe(false);
    expect(fs.existsSync(p("dst/ignored"))).toBe(false);
  });
});

describe("syncDirIncremental", () => {
  it("copies nothing on a second identical run", () => {
    write("src/a.txt", "a");
    write("src/deep/b.txt", "b");

    const first = syncDirIncremental(p("src"), p("dst"));
    expect(first.copied).toBe(2);

    const second = syncDirIncremental(p("src"), p("dst"));
    expect(second.copied).toBe(0);
    expect(second.deleted).toBe(0);
  });

  it("mirrors deletions when deleteExtraneous is on", () => {
    write("src/a.txt", "a");
    write("dst/stale.txt", "stale");

    const result = syncDirIncremental(p("src"), p("dst"));
    expect(result.deleted).toBe(1);
    expect(fs.existsSync(p("dst/stale.txt"))).toBe(false);
  });

  it("keeps extra files when deleteExtraneous is off", () => {
    write("src/a.txt", "a");
    write("dst/keep.txt", "keep");

    syncDirIncremental(p("src"), p("dst"), { deleteExtraneous: false });
    expect(fs.existsSync(p("dst/keep.txt"))).toBe(true);
  });

  it("wipes the destination when the source disappears", () => {
    write("dst/a.txt", "a");
    const result = syncDirIncremental(p("missing"), p("dst"));
    expect(result).toEqual({ copied: 0, deleted: 0 });
    expect(fs.existsSync(p("dst"))).toBe(false);
  });

  it("recopies when content changes but size and mtime match", () => {
    const src = write("src/a.txt", "aaa");
    syncDirIncremental(p("src"), p("dst"));

    const stamp = fs.statSync(src).mtime;
    fs.writeFileSync(src, "bbb");
    fs.utimesSync(src, stamp, stamp);

    const result = syncDirIncremental(p("src"), p("dst"));
    expect(result.copied).toBe(1);
    expect(fs.readFileSync(p("dst/a.txt"), "utf8")).toBe("bbb");
  });
});

describe("atomic replacement", () => {
  it("replaces a file", () => {
    write("src.txt", "new");
    write("dst.txt", "old");
    expect(replaceFileAtomically(p("src.txt"), p("dst.txt"))).toBe(1);
    expect(fs.readFileSync(p("dst.txt"), "utf8")).toBe("new");
  });

  it("preserves the destination when the source is missing and preserveMissing is set", () => {
    write("dst.txt", "keep");
    expect(replaceFileAtomically(p("gone.txt"), p("dst.txt"), { preserveMissing: true })).toBe(0);
    expect(fs.readFileSync(p("dst.txt"), "utf8")).toBe("keep");
  });

  it("deletes the destination when the source is missing by default", () => {
    write("dst.txt", "bye");
    replaceFileAtomically(p("gone.txt"), p("dst.txt"));
    expect(fs.existsSync(p("dst.txt"))).toBe(false);
  });

  it("keeps preserved root files when replacing a directory", () => {
    write("src/a.txt", "a");
    write("dst/a.txt", "old");
    write("dst/keep.json", "local");

    replaceDirAtomically(p("src"), p("dst"), { preserveRootFiles: ["keep.json"] });

    expect(fs.readFileSync(p("dst/a.txt"), "utf8")).toBe("a");
    expect(fs.readFileSync(p("dst/keep.json"), "utf8")).toBe("local");
  });

  it("leaves no temporary directories behind", () => {
    write("src/a.txt", "a");
    replaceDirAtomically(p("src"), p("dst"));
    const leftovers = fs.readdirSync(root).filter((e) => e.includes(".sync-"));
    expect(leftovers).toEqual([]);
  });
});

describe("copyPath", () => {
  it("handles a path that is a file", () => {
    write("src", "one byte");
    expect(copyPath(p("src"), p("dst"))).toBe(1);
    expect(fs.statSync(p("dst")).isFile()).toBe(true);
  });

  it("handles a path that is a directory", () => {
    write("src/a.txt", "a");
    expect(copyPath(p("src"), p("dst"))).toBe(1);
    expect(fs.statSync(p("dst")).isDirectory()).toBe(true);
  });

  it("replaces a directory with a file when the type changes", () => {
    write("dst/a.txt", "a");
    write("src", "now a file");
    copyPath(p("src"), p("dst"));
    expect(fs.statSync(p("dst")).isFile()).toBe(true);
  });
});

describe("removeNestedGitDirs", () => {
  it("removes nested .git but keeps the top-level one", () => {
    write("repo/.git/HEAD", "ref");
    write("repo/skill-a/.git/HEAD", "ref");
    write("repo/skill-a/SKILL.md", "content");
    write("repo/skill-b/deep/.git/config", "cfg");

    const removed = removeNestedGitDirs(p("repo"));

    expect(removed).toBe(2);
    expect(fs.existsSync(p("repo/.git"))).toBe(true);
    expect(fs.existsSync(p("repo/skill-a/.git"))).toBe(false);
    expect(fs.existsSync(p("repo/skill-a/SKILL.md"))).toBe(true);
    expect(fs.existsSync(p("repo/skill-b/deep/.git"))).toBe(false);
  });
});

describe("symlink safety", () => {
  const canSymlink = (): boolean => {
    const probe = path.join(root, "probe");
    try {
      fs.symlinkSync(root, probe, "junction");
      fs.rmSync(probe, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  };

  it("refuses to copy through a symlinked source", () => {
    if (!canSymlink()) return;
    write("real/a.txt", "a");
    fs.symlinkSync(p("real"), p("link"), "junction");
    expect(() => copyDirRecursive(p("link"), p("dst"))).toThrow(SymlinkRefusedError);
  });
});
