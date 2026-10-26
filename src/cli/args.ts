/** Flags that take a value, so `--repo o/r` works as well as `--repo=o/r`. */
export const VALUE_FLAGS = new Set([
  "mode",
  "repo",
  "interval",
  "lang",
  "proxy",
  "limit",
  "prefer",
  "trigger",
]);

export interface Args {
  command: string;
  positional: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    const clean = arg.replace(/^--?/, "");
    const eq = clean.indexOf("=");
    if (eq !== -1) {
      values.set(clean.slice(0, eq), clean.slice(eq + 1));
    } else if (VALUE_FLAGS.has(clean) && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
      values.set(clean, argv[++i]!);
    } else {
      flags.add(clean);
    }
  }

  let command = positional.shift() ?? "menu";
  if (command === "menu" && (flags.has("help") || flags.has("h"))) command = "help";
  return { command, positional, flags, values };
}
