import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySuggestion, parseInput, suggestPaths } from "./input.ts";

const dir = mkdtempSync(join(tmpdir(), "syzygy-input-"));
mkdirSync(join(dir, "src"));
writeFileSync(join(dir, "src", "main.ts"), "");
writeFileSync(join(dir, "shot one.png"), "");
writeFileSync(join(dir, "README.md"), "");

test("parses @file, quoted path, and drag-dropped image", () => {
  const { input } = parseInput(`look at @src/main.ts and @"shot one.png" plus '${join(dir, "README.md")}' and @missing.txt`, dir);
  expect(input.slice(1)).toEqual([
    { type: "file", path: join(dir, "src/main.ts") },
    { type: "image", path: join(dir, "shot one.png") },
    { type: "file", path: join(dir, "README.md") },
  ]);
});

test("folders attach as files", () => {
  expect(parseInput("see @src/", dir).input[1]).toEqual({ type: "file", path: join(dir, "src") });
});

test("suggests paths for trailing @token", () => {
  expect(suggestPaths("open @", dir)?.items).toEqual(["src/", "README.md", "shot one.png"]);
  expect(suggestPaths("open @src/", dir)?.items).toEqual(["src/main.ts"]);
  expect(suggestPaths("open @re", dir)?.items).toEqual(["README.md"]);
  expect(suggestPaths("mail a@b", dir)).toBeNull();
  expect(suggestPaths("open @main", dir)?.items).toEqual(["src/main.ts"]);
  expect(suggestPaths("open @smts", dir)?.items).toEqual(["src/main.ts"]);
  expect(applySuggestion("open @sr", "sr", "src/")).toBe("open @src/");
});
