// The model of a run: the official providers, chosen by INFINITY_PROVIDER; the key is taken out of the environment the agents inherit.
import { describe, expect, it } from "vitest";
import { modelFromEnv } from "../bin/model.ts";

describe("modelFromEnv", () => {
  it("DeepSeek by default, and every provider key leaves the environment", () => {
    const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "d", OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a", PATH: "/bin" };
    const model = modelFromEnv(env);
    expect(model).toMatchObject({ baseUrl: "https://api.deepseek.com", apiKey: "d", model: "deepseek-flash" });
    expect(env).toEqual({ PATH: "/bin" });
  });
  it("OpenAI or Anthropic by INFINITY_PROVIDER, and INFINITY_MODEL replaces the default model", () => {
    expect(modelFromEnv({ INFINITY_PROVIDER: "openai", OPENAI_API_KEY: "o" })).toMatchObject({ baseUrl: "https://api.openai.com/v1", model: "gpt-5" });
    expect(modelFromEnv({ INFINITY_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "a", INFINITY_MODEL: "claude-x" })).toMatchObject({ model: "claude-x" });
  });
  it("says what is missing: an unknown provider, a key that is not set", () => {
    expect(() => modelFromEnv({ INFINITY_PROVIDER: "opencode" })).toThrow(/must be one of deepseek, openai, anthropic/);
    expect(() => modelFromEnv({})).toThrow(/DEEPSEEK_API_KEY is not set/);
  });
});
