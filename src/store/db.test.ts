import { expect, test } from "bun:test";
import { Store } from "./db.ts";

test("projects, sessions, archive, transcript, settings", () => {
  const s = new Store(":memory:");
  const p = s.openProject("/tmp/demo");
  expect(s.openProject("/tmp/demo/").id).toBe(p.id);

  const sess = s.createSession(p.id, "codex");
  s.addMessage(sess.id, "user", "hi");
  s.addMessage(sess.id, "assistant", "hello", { model: "gpt-6-sol" });
  expect(s.messages(sess.id).map((m) => m.text)).toEqual(["hi", "hello"]);

  s.updateSession(sess.id, { archived: true, mainSessionId: "thr_1" });
  expect(s.listSessions(p.id)).toHaveLength(0);
  expect(s.listSessions(p.id, true)[0]?.mainSessionId).toBe("thr_1");

  expect(s.globalSettings().sub.codex).toEqual({ provider: "claude", family: "opus", effort: "medium" });
  s.saveProjectSettings(p.id, { mainProvider: "claude" });
  expect(s.projectSettings(p.id).mainProvider).toBe("claude");
  expect(s.projectSettings(p.id).main.codex.family).toBe("sol");
});
