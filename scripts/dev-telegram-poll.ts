import { runPoller } from "./telegramPoll.ts";

declare const process: { env: Record<string, string | undefined>; exit(code: number): never };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

process.exit(await runPoller({ env: process.env, fetch, sleep, log: console.log }));
