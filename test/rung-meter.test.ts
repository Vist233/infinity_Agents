import { describe, expect, it } from "vitest";
import { RungMeter, percentile } from "../src/rung-meter.ts";

describe("percentile", () => {
  it("is 0 for no data", () => expect(percentile([], 0.5)).toBe(0));
  it("picks the nearest rank", () => {
    const data = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(data, 0.5)).toBe(50);
    expect(percentile(data, 0.95)).toBe(100);
    expect(percentile([7], 0.95)).toBe(7);
  });
});

describe("RungMeter", () => {
  it("reports replies, throttles, latency and tokens per minute for the rung, then starts over", () => {
    const meter = new RungMeter(0);
    for (const latency of [100, 300, 200]) meter.recordReply(latency, 1000);
    meter.recordThrottle();
    const first = meter.closeRung(30_000);
    expect(first).toEqual({ replies: 3, throttles: 1, latencyP50Ms: 200, latencyP95Ms: 300, tokensPerMinute: 6000 });
    expect(meter.closeRung(90_000)).toEqual({ replies: 0, throttles: 0, latencyP50Ms: 0, latencyP95Ms: 0, tokensPerMinute: 0 });
  });
  it("does not divide by zero when the rung lasted no time", () => {
    const meter = new RungMeter(5);
    meter.recordReply(1, 10);
    expect(Number.isFinite(meter.closeRung(5).tokensPerMinute)).toBe(true);
  });
});
