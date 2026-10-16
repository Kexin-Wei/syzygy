import { expect, test } from "bun:test";
import { claudeUsage, describeClaudeTool } from "./adapter.ts";

test("describes claude tool calls by their command, path or query", () => {
  expect(describeClaudeTool("Bash", { command: "git status --short", description: "status" })).toBe("git status --short");
  expect(describeClaudeTool("Edit", { file_path: "/a/b.ts", old_string: "x", new_string: "y" })).toBe("/a/b.ts");
  expect(describeClaudeTool("Grep", { pattern: "TODO", path: "src" })).toBe("TODO  in src");
  expect(describeClaudeTool("mcp__x__y", { query: "hello", n: 3 })).toBe("hello");
  expect(describeClaudeTool("Bash", { command: "x".repeat(5000) })).toHaveLength(4001);
});

test("reads account usage from a rate_limit_event", () => {
  const info = { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.17, resetsAt: 1 }, seven_day: { utilization: 0.39, resetsAt: 2 } } };
  expect(claudeUsage(info, 5)).toEqual({ fiveHour: 17, weekly: 39, at: 5 });
  expect(claudeUsage({ status: "allowed" })).toBeNull();
});
