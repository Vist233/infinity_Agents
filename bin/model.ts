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

/** The same DeepSeek model through Command Code, for when the OpenCode Go quota is used up. Chosen with INFINITY_PROVIDER=commandcode. */
export function commandcodeModel(apiKey: string): ModelConfig {
  return {
    baseUrl: "https://api.commandcode.ai/provider/v1",
    apiKey,
    model: "deepseek/deepseek-v4.1-flash",
    contextWindow: 128_000,
    compat: compatPresets.deepseek,
  };
}

/** Picks the provider from INFINITY_PROVIDER (opencode by default), reads its key from the environment, removes the key from the environment and returns the model. */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const useCommandcode = env.INFINITY_PROVIDER === "commandcode";
  const name = useCommandcode ? "COMMANDCODE_API_KEY" : "OPENCODE_API_KEY";
  const apiKey = env[name];
  if (!apiKey) throw new Error(`${name} is not set`);
  delete env[name];
  return useCommandcode ? commandcodeModel(apiKey) : opencodeModel(apiKey);
}
