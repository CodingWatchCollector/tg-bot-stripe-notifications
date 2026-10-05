export function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

// Logging allowlist: only error names, NotifyError.safeDetail, signature messages, event ids, event types and update_id.
// Error objects, messages, causes and payloads can carry the bot token or customer data.
export function errName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export function safeDetail(err: unknown): string | undefined {
  const detail = (err as { safeDetail?: unknown } | null)?.safeDetail;
  return typeof detail === "string" ? detail : undefined;
}
