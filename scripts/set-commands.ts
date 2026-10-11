import { runSetCommands } from "./setCommands.ts";

declare const process: { env: Record<string, string | undefined>; exit(code: number): never };

process.exit(await runSetCommands({ env: process.env, fetch, log: console.log }));
