import type { Env } from "./env";
import type { AuthedUser } from "./auth";
import { ensureUserSettings, getUserSettings } from "./db";
import { json, nowSeconds, serializeCookie } from "./http";

export type SupportedLocale = "zh" | "en";

export function localeFromAcceptLanguage(value: string | null): SupportedLocale {
  return /^zh(?:[-_,]|$)/i.test(value ?? "") ? "zh" : "en";
}

export async function handleUserSettings(request: Request, env: Env, user: AuthedUser): Promise<Response> {
  let settings = await getUserSettings(env, user.userId);
  if (!settings) {
    settings = await ensureUserSettings(env, user.userId, localeFromAcceptLanguage(request.headers.get("accept-language")));
  }
  const headers = new Headers();
  headers.append(
    "set-cookie",
    serializeCookie("ia_locale", settings.locale, { maxAge: 60 * 60 * 24 * 365, sameSite: "Lax", httpOnly: false }),
  );
  return json(
    { settings: { user_id: settings.user_id, locale: settings.locale, updated_at: settings.updated_at }, server_time: nowSeconds() },
    200,
    headers,
  );
}
