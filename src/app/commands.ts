// One list feeds both the Telegram command menu (scripts/set-commands.ts) and the /help reply.
// Keep it free of imports: the script loads this file straight under Node.
export interface CommandInfo {
  command: string;
  description: string;
  usage: string;
}

export const COMMANDS: readonly CommandInfo[] = [
  { command: "students", description: "Active students with their balance", usage: "/students" },
  { command: "archived", description: "Archived students", usage: "/archived" },
  { command: "adjust", description: "Change a student's balance", usage: "/adjust Name +5 [reason]" },
  { command: "rename", description: "Rename a student", usage: "/rename Old name -> New name" },
  { command: "help", description: "Show this list", usage: "/help" },
];

export const helpText = (): string =>
  [
    "Commands:",
    ...COMMANDS.map((c) => `${c.usage} - ${c.description}`),
    "",
    "Payments arrive here by themselves. Use the buttons under a payment to assign it or correct the balance.",
  ].join("\n");
