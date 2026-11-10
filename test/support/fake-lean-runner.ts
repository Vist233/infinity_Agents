import type { LeanRunRequest, LeanRunResult, LeanRunner } from "../../src/lean-runner.ts";

export type FakeLeanHandler = (request: LeanRunRequest, index: number) => Partial<LeanRunResult> | Promise<Partial<LeanRunResult>>;

/** A stand-in for Lean: answers each run from a handler and remembers the requests. */
export class FakeLeanRunner implements LeanRunner {
  readonly sandboxed = false;
  readonly requests: LeanRunRequest[] = [];
  private readonly handler: FakeLeanHandler;

  constructor(handler: FakeLeanHandler = () => ({})) {
    this.handler = handler;
  }

  async run(request: LeanRunRequest): Promise<LeanRunResult> {
    const index = this.requests.length;
    this.requests.push(request);
    const answer = await this.handler(request, index);
    return { exitCode: 0, output: "", timedOut: false, ...answer };
  }
}
