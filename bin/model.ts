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
function commandcodeModel(apiKey: string): ModelConfig {
  return {
    baseUrl: "https://api.commandcode.ai/provider/v1",
    apiKey,
    model: "deepseek/deepseek-v4.1-flash",
    contextWindow: 128_000,
    compat: compatPresets.deepseek,
  };
}

/** Picks the provider, keeps its key in the model configuration and removes both provider keys from the worker environment. */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const useCommandcode = env.INFINITY_PROVIDER === "commandcode";
  const name = useCommandcode ? "COMMANDCODE_API_KEY" : "OPENCODE_API_KEY";
  const apiKey = env[name];
  if (!apiKey) throw new Error(`${name} is not set`);
  delete env.OPENCODE_API_KEY;
  delete env.COMMANDCODE_API_KEY;
  return useCommandcode ? commandcodeModel(apiKey) : opencodeModel(apiKey);
}
