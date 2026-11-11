import type { RunComponent } from "./component.ts";
import { machineSampler } from "./machine-sampler.ts";

/** The one place that names the components a run has unless the caller gives its own list. */
export function defaultComponents(): RunComponent[] {
  return [machineSampler()];
}
