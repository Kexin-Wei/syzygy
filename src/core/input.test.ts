import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completePath, parseInput } from "./input.ts";

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

test("completes trailing @token", () => {
  expect(completePath("open @sr", dir)?.text).toBe("open @src/");
  expect(completePath("open @src/m", dir)?.text).toBe("open @src/main.ts");
  expect(completePath("no token", dir)).toBeNull();
});
