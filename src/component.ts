import type { Clock } from "./clock.ts";
import type { RunLayout } from "./run-layout.ts";

/** What the core lets a component see of the run: numbers only, nothing to change. */
export interface RunView {
  /** The ladder's current rung: how many agents the run is allowed to have alive now. */
  rung(): number;
  /** Agents alive now. */
  agents(): number;
}

export interface ComponentContext {
  layout: RunLayout;
  clock: Clock;
  view: RunView;
  /** Writes a line to the run's events (the report shows them). */
  note(message: string): void;
  /**
   * Asks the ladder to stay where it is: no climb and no replacement agent while `on` is true (docs/16 section D). It is the one thing a component can ask of
   * the core; the core does not look at why, and the component records the reason.
   */
  hold(on: boolean): void;
}

/**
 * A part that watches or helps a run without being the run: it starts when the agents start and stops when the run ends.
 * The core knows only this interface; it never imports a component (the composition is in `defaults.ts`).
 */
export interface RunComponent {
  readonly name: string;
  start(context: ComponentContext): void;
  /** Finishes what it is writing. Must not throw; may be called more than once. */
  stop(): Promise<void>;
}
