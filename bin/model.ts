import { type ModelConfig, compatPresets } from "sakura-agent";

/**
 * The providers a run can use: the official APIs of DeepSeek (the default), OpenAI and Anthropic (its OpenAI-compatible endpoint), the same built-ins as
 * sakuracode. INFINITY_PROVIDER picks one, INFINITY_MODEL replaces its default model. The key comes from the environment once and goes nowhere else.
 */
const PROVIDERS = {
  deepseek: {
    keyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    contextWindow: 128_000,
    compat: compatPresets["deepseek-flash"],
  },
  openai: { keyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1", model: "gpt-5", contextWindow: 400_000, compat: compatPresets.openai },
  anthropic: {
    keyEnv: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1/",
    model: "claude-sonnet-5-5",
    contextWindow: 200_000,
    compat: compatPresets.anthropic,
  },
} as const;

export type ProviderName = keyof typeof PROVIDERS;
export const PROVIDER_NAMES = Object.keys(PROVIDERS) as ProviderName[];
const KEY_VARIABLES = PROVIDER_NAMES.map((name) => PROVIDERS[name].keyEnv);

/** Picks the provider, keeps its key in the model configuration and removes every provider key from the environment the agents' commands inherit. */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const name = (env.INFINITY_PROVIDER || "deepseek") as ProviderName;
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`INFINITY_PROVIDER must be one of ${PROVIDER_NAMES.join(", ")} (it is "${env.INFINITY_PROVIDER}")`);
  const apiKey = env[provider.keyEnv];
  if (!apiKey)
    throw new Error(`${provider.keyEnv} is not set (the key of the ${name} provider; INFINITY_PROVIDER chooses another: ${PROVIDER_NAMES.join(", ")})`);
  for (const variable of KEY_VARIABLES) delete env[variable];
  return { baseUrl: provider.baseUrl, apiKey, model: env.INFINITY_MODEL || provider.model, contextWindow: provider.contextWindow, compat: provider.compat };
}
