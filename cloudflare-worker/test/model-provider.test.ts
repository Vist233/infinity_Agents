// @ts-ignore test-only Node builtin
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { modelProvider } from "../src/env";
import { makeEnv } from "./fake-d1";

declare const process: { cwd(): string };

describe("modelProvider", () => {
  it("keeps the legacy provider as the rollback-safe default", () => {
    const { env } = makeEnv();
    expect(modelProvider(env)).toEqual({
      baseUrl: "https://stepfun.test/v1",
      model: "step-test",
      apiKey: "sk-test",
    });
  });

  it("uses the replacement provider only when all replacement values are supplied", () => {
    const { env } = makeEnv({
      MODEL_BASE_URL: "https://api.moonshot.cn/v1/",
      MODEL_ID: "kimi-k2.6",
      MODEL_API_KEY: "replacement-key",
    });
    expect(modelProvider(env)).toEqual({
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2.6",
      apiKey: "replacement-key",
    });
  });

  it("falls back entirely when a replacement credential is absent", () => {
    const { env } = makeEnv({
      MODEL_BASE_URL: "https://api.moonshot.cn/v1",
      MODEL_ID: "kimi-k2.6",
    });
    expect(modelProvider(env)).toEqual({
      baseUrl: "https://stepfun.test/v1",
      model: "step-test",
      apiKey: "sk-test",
    });
  });

  it("pins the deployed Kimi K2.6 contract to the mainland API", () => {
    const wranglerConfig = readFileSync(`${process.cwd()}/wrangler.jsonc`, "utf8");
    expect(wranglerConfig).toContain('"MODEL_BASE_URL": "https://api.moonshot.cn/v1"');
    expect(wranglerConfig).not.toContain('"MODEL_BASE_URL": "https://api.moonshot.ai/v1"');
    expect(wranglerConfig).toContain('"MODEL_ID": "kimi-k2.6"');
  });
});
