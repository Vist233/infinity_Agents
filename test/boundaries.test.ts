import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The import boundaries of docs/18: the core imports no component, the components do not import each other, they depend on ports only, and the composition
 * is in one place (`defaults.ts`). Every file of src/ is listed below by hand: a new file fails the test until it is put in a list, and a wrong import fails.
 */

/** Files with no reason to depend on anything above them: the ports (Host, Component, Clock), the record formats and small utilities. */
const LEAVES = [
  "backoff.ts",
  "capacity.ts",
  "clock.ts",
  "component.ts",
  "csv.ts",
  "error-cluster.ts",
  "host.ts",
  "jsonl.ts",
  "machine-summary.ts",
  "platform.ts",
  "pool.ts",
  "prompts.ts",
  "records.ts",
  "review-snapshot.ts",
  "run-layout.ts",
  "task.ts",
  "evaluation.ts",
];

/** The core: the run itself (ladder, gate, budget, stuck detection, fleet, records and reports) and the oversight of agents. */
const CORE = [
  "agent-worker.ts",
  "budget.ts",
  "commit-plugin.ts",
  "gate.ts",
  "ladder.ts",
  "mode.ts",
  "mode-factory.ts",
  "network.ts",
  "orchestrator.ts",
  "planner.ts",
  "review-loop.ts",
  "review-run.ts",
  "review-schedule.ts",
  "run-recorder.ts",
  "run-state.ts",
  "rung-meter.ts",
  "stuck.ts",
  "work-repo.ts",
  "worker-policy.ts",
  "leaderboard.ts",
  "code-leaderboard.ts",
  "report.ts",
  "code-report.ts",
];

/** The modes: what a task is (prompts, tools, evaluator, hidden data, review rules). */
const MODES = [
  "code-mode.ts",
  "math-mode.ts",
  "hidden-keeper.ts",
  "lean-runner.ts",
  "lean-setup.ts",
  "lean-tool.ts",
  "review-rules.ts",
  "safety-review.ts",
  "submit-tool.ts",
  "verifier.ts",
];

/** The components, by group. A file may import the files of its own group, and leaves; never a file of another group. */
const GROUPS: Record<string, string[]> = {
  sampler: ["machine-sampler.ts", "proc-readings.ts", "pressure-brake.ts"],
  leftover: ["leftover.ts"],
  slots: ["slot-gate.ts", "command-class.ts"],
  gpu: ["gpu-shim.ts"],
  limits: ["command-limits.ts"],
};

/** The one place where components are put together. */
const COMPOSITION = ["defaults.ts"];

/** Known imports that break the rules and are to go in step 2 of docs/18. Each is written down so that no other one can slip in. */
const KNOWN_EXCEPTIONS: Array<[from: string, to: string, why: string]> = [
  ["orchestrator.ts", "defaults.ts", "the default list of components comes from the composition root"],
  ["orchestrator.ts", "slot-gate.ts", "type SlotGate in RunOptions.gate"],
  ["mode-factory.ts", "slot-gate.ts", "type SlotGate passed on to the code mode"],
  ["code-mode.ts", "slot-gate.ts", "the commandLimits plugin and the SlotGate it waits at"],
];

type Graph = Map<string, string[]>;
const SRC = join(import.meta.dirname, "..", "src");

/** Every relative import of a source text: static, `export ... from`, type-only and dynamic. */
function importsOf(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)["']\.\/([^"']+)["']/gm)) found.add(match[1] as string);
  return [...found].sort();
}

function readGraph(): Graph {
  const graph: Graph = new Map();
  for (const file of readdirSync(SRC).filter((name) => name.endsWith(".ts"))) graph.set(file, importsOf(readFileSync(join(SRC, file), "utf8")));
  return graph;
}

const groupOf = (file: string): string | undefined => Object.entries(GROUPS).find(([, files]) => files.includes(file))?.[0];
const isComponent = (file: string) => groupOf(file) !== undefined;

/** The problems of a graph under the rules above, as words. */
function boundaryProblems(graph: Graph, exceptions = KNOWN_EXCEPTIONS): string[] {
  const problems: string[] = [];
  const listed = [...LEAVES, ...CORE, ...MODES, ...COMPOSITION, ...Object.values(GROUPS).flat()];
  for (const file of graph.keys()) {
    const times = listed.filter((name) => name === file).length;
    if (times === 0) problems.push(`${file} is in no list: say what it is (leaf, core, mode, component, composition)`);
    if (times > 1) problems.push(`${file} is in more than one list`);
  }
  const allowed = (from: string, to: string) => exceptions.some(([a, b]) => a === from && b === to);
  for (const [file, imports] of graph) {
    for (const target of imports) {
      if (!graph.has(target)) continue; // not a source file of src/ (cannot happen for ./ imports of .ts files)
      if (COMPOSITION.includes(file)) continue;
      if (CORE.includes(file) || MODES.includes(file)) {
        if ((isComponent(target) || COMPOSITION.includes(target)) && !allowed(file, target))
          problems.push(`${file} imports ${target}: the core and the modes import no component`);
      } else if (isComponent(file)) {
        const same = groupOf(file) === groupOf(target);
        if (!same && !LEAVES.includes(target)) problems.push(`${file} imports ${target}: a component imports its own group, leaves and ports only`);
      } else if (LEAVES.includes(file)) {
        if (!LEAVES.includes(target)) problems.push(`${file} imports ${target}: a leaf imports leaves only`);
      }
    }
  }
  for (const [from, to] of exceptions)
    if (!graph.get(from)?.includes(to)) problems.push(`the exception ${from} -> ${to} is not needed any more: remove it from the list`);
  return problems;
}

describe("import boundaries (docs/18)", () => {
  it("every file of src/ is in exactly one list, and no import breaks a rule", () => {
    expect(boundaryProblems(readGraph())).toEqual([]);
  });

  it("only the composition root puts components of several groups together", () => {
    const graph = readGraph();
    const many = [...graph].filter(([, imports]) => new Set(imports.filter((target) => isComponent(target)).map(groupOf)).size > 1).map(([file]) => file);
    expect(many.sort()).toEqual(["defaults.ts"]);
  });

  it("the Host port imports nothing, and no component touches the operating system (os, child_process) except through it", () => {
    const graph = readGraph();
    expect(graph.get("host.ts")).toEqual([]);
    const withOs = [...graph.keys()].filter((file) => /from "node:(os|child_process)"/.test(readFileSync(join(SRC, file), "utf8"))).sort();
    expect(withOs.filter((file) => isComponent(file))).toEqual([]);
  });

  describe("the checker itself", () => {
    const base = (): Graph => new Map(readGraph());
    it("finds a core file that imports a component", () => {
      const graph = base();
      graph.set("ladder.ts", ["proc-readings.ts"]);
      expect(boundaryProblems(graph).join("\n")).toContain("ladder.ts imports proc-readings.ts");
    });
    it("finds a component that imports a component of another group", () => {
      const graph = base();
      graph.set("leftover.ts", [...(graph.get("leftover.ts") ?? []), "slot-gate.ts"]);
      expect(boundaryProblems(graph).join("\n")).toContain("leftover.ts imports slot-gate.ts");
    });
    it("finds a leaf that imports a component, a file that is in no list, and an exception that is no longer needed", () => {
      const graph = base();
      graph.set("host.ts", ["leftover.ts"]);
      graph.set("brand-new.ts", []);
      graph.set(
        "orchestrator.ts",
        (graph.get("orchestrator.ts") ?? []).filter((target) => target !== "slot-gate.ts"),
      );
      const problems = boundaryProblems(graph).join("\n");
      expect(problems).toContain("host.ts imports leftover.ts");
      expect(problems).toContain("brand-new.ts is in no list");
      expect(problems).toContain("the exception orchestrator.ts -> slot-gate.ts is not needed any more");
    });
    it("reads static, type-only, re-export and dynamic imports", () => {
      const source =
        'import { a } from "./one.ts";\nimport type { B } from "./two.ts";\nexport { c } from "./three.ts";\nconst x = await import("./four.ts");\nimport "./five.ts";\nimport fs from "node:fs";\n';
      expect(importsOf(source)).toEqual(["five.ts", "four.ts", "one.ts", "three.ts", "two.ts"]);
    });
  });
});
