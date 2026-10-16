import { describe, expect, test } from "bun:test";
import { familyOptions, resolveIntent } from "./models.ts";
import type { ModelInfo } from "./types.ts";

const m = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  displayName: id,
  efforts: ["low", "medium", "high"],
  isDefault: false,
  supportsImages: true,
  ...extra,
});

const live = [m("gpt-6-astra", { isDefault: true }), m("gpt-6-sol"), m("gpt-6-luna"), m("gpt-5.6-sol"), m("gpt-5.6-terra")];

describe("resolveIntent", () => {
  test("picks newest model in family", () => {
    expect(resolveIntent({ provider: "codex", family: "sol", effort: "low" }, live)).toEqual({
      provider: "codex",
      model: "gpt-6-sol",
      effort: "low",
    });
  });

  test("follows an upgrade when a newer family member appears", () => {
    const r = resolveIntent({ provider: "codex", family: "sol", effort: "low" }, [m("gpt-6.1-sol"), ...live]);
    expect(r.model).toBe("gpt-6.1-sol");
  });

  test("minor versions compare numerically", () => {
    const r = resolveIntent({ provider: "codex", family: "sol", effort: "low" }, [m("gpt-6.9-sol"), m("gpt-6.10-sol")]);
    expect(r.model).toBe("gpt-6.10-sol");
  });

  test("exact id is honoured", () => {
    expect(resolveIntent({ provider: "codex", family: "gpt-5.6-sol", effort: "low" }, live).model).toBe("gpt-5.6-sol");
  });

  test("missing family falls back to default with a note", () => {
    const r = resolveIntent({ provider: "codex", family: "nova", effort: "low" }, live);
    expect(r.model).toBe("gpt-6-astra");
    expect(r.note).toContain("nova");
  });

  test("unsupported effort falls back", () => {
    const r = resolveIntent({ provider: "codex", family: "sol", effort: "ultra" }, [m("gpt-6-sol", { defaultEffort: "medium" })]);
    expect(r.effort).toBe("medium");
    expect(r.note).toContain("ultra");
  });

  test("family options list version-free families first, then exact ids", () => {
    expect(familyOptions([...live, m("gpt-daybreak-blue-latest")])).toEqual([
      "astra", "sol", "luna", "terra",
      "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-daybreak-blue-latest",
    ]);
  });

  test("claude family passes through as CLI alias", () => {
    expect(resolveIntent({ provider: "claude", family: "opus", effort: "medium" }, [])).toEqual({
      provider: "claude",
      model: "opus",
      effort: "medium",
    });
  });
});
