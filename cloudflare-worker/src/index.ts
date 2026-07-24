interface Env {
  CLIENT_API_KEY: string;
  STEPFUN_API_KEY: string;
  STEPFUN_BASE_URL: string;
  STEPFUN_MODEL: string;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function corsHeaders(request: Request): Headers {
  const headers = new Headers({
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, OPTIONS, POST",
    "access-control-max-age": "86400",
    "vary": "Origin",
  });

  // This API is token-protected, so browser clients can call it from a custom
  // origin until a dedicated frontend domain is configured.
  headers.set("access-control-allow-origin", request.headers.get("origin") ?? "*");
  return headers;
}

function responseJson(request: Request, body: unknown, status = 200): Response {
  const headers = corsHeaders(request);
  for (const [key, value] of Object.entries(JSON_HEADERS)) headers.set(key, value);
  return new Response(JSON.stringify(body), { status, headers });
}

function isAuthorized(request: Request, env: Env): boolean {
  const authorization = request.headers.get("authorization");
  return authorization === `Bearer ${env.CLIENT_API_KEY}`;
}

async function forwardChat(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return responseJson(request, { error: { message: "Unauthorized" } }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json<Record<string, unknown>>();
  } catch {
    return responseJson(request, { error: { message: "Request body must be JSON" } }, 400);
  }

  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return responseJson(request, { error: { message: "messages must be a non-empty array" } }, 400);
  }

  // Keep the deployed plan and model under server-side control. Client input
  // must never be able to select another provider or expose provider secrets.
  const upstreamPayload = { ...payload, model: env.STEPFUN_MODEL };
  const upstream = await fetch(`${env.STEPFUN_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STEPFUN_API_KEY}`,
      "content-type": "application/json",
      accept: payload.stream === true ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(upstreamPayload),
  });

  const headers = corsHeaders(request);
  headers.set("content-type", upstream.headers.get("content-type") ?? "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  if (upstream.headers.get("x-request-id")) {
    headers.set("x-upstream-request-id", upstream.headers.get("x-request-id")!);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return responseJson(request, { status: "ok", service: "infinity-agents-edge", model: env.STEPFUN_MODEL });
    }

    if (request.method === "GET" && url.pathname === "/v1/models") {
      if (!isAuthorized(request, env)) {
        return responseJson(request, { error: { message: "Unauthorized" } }, 401);
      }
      return responseJson(request, { object: "list", data: [{ id: env.STEPFUN_MODEL, object: "model" }] });
    }

    if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat")) {
      return forwardChat(request, env);
    }

    return responseJson(request, { error: { message: "Not found" } }, 404);
  },
} satisfies ExportedHandler<Env>;
