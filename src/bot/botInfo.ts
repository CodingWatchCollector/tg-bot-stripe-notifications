import { Api } from "grammy";
import type { UserFromGetMe } from "grammy/types";

// Only resolved values are cached: a promise started in one Workers request can hang another.
const cache = new Map<string, UserFromGetMe>();

export async function getBotInfo(token: string, api: Api = new Api(token, { timeoutSeconds: 8 })): Promise<UserFromGetMe> {
  const cached = cache.get(token);
  if (cached) return cached;
  const info = await api.getMe();
  cache.set(token, info);
  return info;
}
