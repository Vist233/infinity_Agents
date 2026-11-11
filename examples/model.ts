import { randomUUID } from "node:crypto";
import { type ModelConfig, compatPresets } from "sakura-agent";

/** The model of the real runs: DeepSeek through OpenCode Go. The key comes from the environment and goes nowhere else. */
export function opencodeModel(apiKey: string): ModelConfig {
  return {
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey,
    model: "deepseek-v4.1-flash",
    contextWindow: 128_000,
    compat: compatPresets.deepseek,
    headers: { "x-opencode-session": randomUUID() },
  };
}
