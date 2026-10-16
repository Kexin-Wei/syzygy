import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { Core } from "../core/core.ts";
import { familyOptions, resolveIntent } from "../core/models.ts";
import type { ModelInfo, ModelIntent, ProviderId } from "../core/types.ts";
import type { Settings } from "../store/db.ts";

const PROVIDERS: ProviderId[] = ["codex", "claude"];

type Row = "main" | "mainFamily" | "mainEffort" | "subProvider" | "subFamily" | "subEffort" | "override" | "approvals" | "scope";
const ROWS: Row[] = ["main", "mainFamily", "mainEffort", "subProvider", "subFamily", "subEffort", "override", "approvals", "scope"];

function cycle<T>(list: T[], cur: T, dir: number): T {
  const i = list.indexOf(cur);
  return list[(((i < 0 ? 0 : i) + dir) % list.length + list.length) % list.length]!;
}

/** Edit main/sub provider, model family and effort; saved as intents so upgrades are picked up. */
export function ModelPicker({ core, onDone }: { core: Core; onDone: (msg?: string) => void }) {
  const [s, setS] = useState<Settings>(() => structuredClone(core.settings));
  const [scope, setScope] = useState<"global" | "project">("global");
  const [row, setRow] = useState(0);
  const [models, setModels] = useState<Partial<Record<ProviderId, ModelInfo[]>>>({});
  const [err, setErr] = useState<string>();

  useEffect(() => {
    for (const p of PROVIDERS) {
      core.models(p, true).then(
        (m) => setModels((prev) => ({ ...prev, [p]: m })),
        (e) => setErr(`${p}: ${e.message}`),
      );
    }
  }, []);

  const mainP = s.mainProvider;
  const mainI = s.main[mainP];
  const subI = s.sub[mainP];
  const efforts = (i: ModelIntent) => {
    const list = models[i.provider];
    if (!list) return ["low", "medium", "high", "xhigh", "max"];
    const id = resolveIntent(i, list).model;
    return list.find((m) => m.id === id)?.efforts ?? ["low", "medium", "high", "xhigh", "max"];
  };
  const families = (p: ProviderId) => (models[p] ? familyOptions(models[p]!) : []);
  const resolvedLabel = (i: ModelIntent) => {
    const list = models[i.provider];
    if (!list) return "…";
    const r = resolveIntent(i, list);
    return `→ ${r.model}${r.note ? ` (${r.note})` : ""}`;
  };

  const setMain = (i: ModelIntent) => setS({ ...s, main: { ...s.main, [mainP]: i } });
  const setSub = (i: ModelIntent) => setS({ ...s, sub: { ...s.sub, [mainP]: i } });

  useInput((input, key) => {
    if (key.escape) return onDone();
    if (key.upArrow) return setRow(Math.max(0, row - 1));
    if (key.downArrow) return setRow(Math.min(ROWS.length - 1, row + 1));
    if (key.return) {
      const { mainProvider, main, sub, allowSubOverride, approvals } = s;
      core
        .updateSettings({ mainProvider, main, sub, allowSubOverride, approvals }, scope)
        .then(() => onDone(`saved (${scope}); main ${mainProvider} ${main[mainProvider].family}/${main[mainProvider].effort}, sub ${sub[mainProvider].provider} ${sub[mainProvider].family}/${sub[mainProvider].effort}`));
      return;
    }
    const dir = key.leftArrow ? -1 : key.rightArrow || input === " " ? 1 : 0;
    if (!dir) return;
    switch (ROWS[row]) {
      case "main":
        return setS({ ...s, mainProvider: cycle(PROVIDERS, mainP, dir) });
      case "mainFamily":
        return families(mainP).length && setMain({ ...mainI, family: cycle(families(mainP), mainI.family, dir) });
      case "mainEffort":
        return setMain({ ...mainI, effort: cycle(efforts(mainI), mainI.effort, dir) });
      case "subProvider": {
        const p = cycle(PROVIDERS, subI.provider, dir);
        // switching provider resets to that provider's default intent
        return setSub(p === subI.provider ? subI : { ...s.main[p] });
      }
      case "subFamily":
        return families(subI.provider).length && setSub({ ...subI, family: cycle(families(subI.provider), subI.family, dir) });
      case "subEffort":
        return setSub({ ...subI, effort: cycle(efforts(subI), subI.effort, dir) });
      case "override":
        return setS({ ...s, allowSubOverride: !s.allowSubOverride });
      case "approvals":
        return setS({ ...s, approvals: s.approvals === "ask" ? "auto" : "ask" });
      case "scope":
        return setScope(scope === "global" ? "project" : "global");
    }
  });

  const lines: [Row, string, string, string?][] = [
    ["main", "Main agent", mainP],
    ["mainFamily", "  model", mainI.family, resolvedLabel(mainI)],
    ["mainEffort", "  effort", mainI.effort],
    ["subProvider", "Subagent", subI.provider, mainP === subI.provider ? "(same provider)" : undefined],
    ["subFamily", "  model", subI.family, resolvedLabel(subI)],
    ["subEffort", "  effort", subI.effort],
    ["override", "Main may override sub model", s.allowSubOverride ? "yes" : "no"],
    ["approvals", "Approvals", s.approvals, s.approvals === "ask" ? "prompt in Syzygy" : "providers decide (codex never-ask, claude auto mode)"],
    ["scope", "Save to", scope, scope === "project" ? core.project.path : "all projects"],
  ];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
      <Text bold color="blue">
        Models & agents
      </Text>
      {lines.map(([r, label, value, hint], i) => (
        <Text key={r} inverse={i === row}>
          {i === row ? "› " : "  "}
          {label.padEnd(30)}
          <Text bold>‹ {value} ›</Text>
          {hint ? <Text dimColor> {hint}</Text> : null}
        </Text>
      ))}
      {err ? <Text color="red">{err}</Text> : null}
      <Text dimColor>↑↓ select · ←→ change · Enter save · Esc cancel. Families like "sol"/"opus" follow upgrades; exact ids pin.</Text>
    </Box>
  );
}

