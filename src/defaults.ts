import type { Capacity } from "./capacity.ts";
import type { RunComponent } from "./component.ts";
import { GpuLedger, gpuShim } from "./gpu-shim.ts";
import { leftoverStopper } from "./leftover.ts";
import { type GateFacts, NO_GATE, machineSampler } from "./machine-sampler.ts";
import type { BrakeLimits } from "./pressure-brake.ts";
import { type SlotGate, slotGate } from "./slot-gate.ts";

/** What the program that starts a run knows and the components record about it (run-facts.json). */
export interface DefaultComponentOptions {
  /** The most agents the run may have alive. */
  ceiling?: number;
  /** The flags of the run as given to the program. */
  commandLine?: string[];
  /** The CPU slot gate of the run (docs/16 section C); the same object goes to `RunOptions.gate`. Left out, no gate. */
  gate?: SlotGate;
  /** The GPU slots: one GPU index per slot (`Capacity.gpuSlotMap`). Left out or empty, no GPU slots. */
  gpuSlotMap?: readonly number[];
  /** The wall limit of one command in minutes, for run-facts.json. */
  commandTimeoutMinutes?: number;
  /** Cores busy with load that is not the run's, measured before the start. */
  foreignBusyCores?: number;
  /** Hold the ladder while the machine is under pressure (docs/16 section D); `true` takes the default limits. */
  pressureBrake?: boolean | BrakeLimits;
  /** Lines the run writes as warnings at its start, so that the report says what the user chose (for example "Branch review: off"). */
  notes?: string[];
  /** For the facts of the run: the recommendation the example printed. */
  capacity?: Capacity;
}

/** The one place that names the components a run has unless the caller gives its own list. */
export function defaultComponents(options: DefaultComponentOptions = {}): RunComponent[] {
  const gpuSlots = options.gpuSlotMap?.length ?? 0;
  const ledger = gpuSlots > 0 ? new GpuLedger(gpuSlots) : undefined;
  const gate: GateFacts = {
    ...NO_GATE,
    enabled: options.gate !== undefined,
    cpuSlots: options.gate?.capacity ?? null,
    gpuSlots: gpuSlots > 0 ? gpuSlots : null,
    commandTimeoutMinutes: options.commandTimeoutMinutes ?? null,
  };
  const gate0 = options.gate;
  return [
    machineSampler({
      gate,
      ...(options.notes ? { notes: options.notes } : {}),
      needsGpu: gpuSlots > 0,
      slots: () => ({
        ...(gate0 ? { cpu: { inUse: gate0.inUse, waiting: gate0.waiting } } : {}),
        ...(ledger ? { gpu: { inUse: ledger.inUse, waiting: ledger.waiting } } : {}),
      }),
      ...(options.pressureBrake ? { brake: options.pressureBrake === true ? {} : options.pressureBrake } : {}),
      ...(options.ceiling === undefined ? {} : { ceiling: options.ceiling }),
      ...(options.commandLine === undefined ? {} : { commandLine: options.commandLine }),
      ...(options.foreignBusyCores === undefined ? {} : { foreignBusyCores: options.foreignBusyCores }),
    }),
    leftoverStopper(),
    ...(options.gate ? [slotGate(options.gate)] : []),
    ...(ledger ? [gpuShim({ slotMap: options.gpuSlotMap ?? [], ledger })] : []),
  ];
}
