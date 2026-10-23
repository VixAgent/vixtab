// Minimal argument parsing: positionals, --flag, --key value, --key=value, and everything after `--` kept verbatim.
export type Args = { _: string[]; flags: Record<string, string | true>; rest: string[] };

export function parseArgs(argv: string[], valued: string[] = []): Args {
  const out: Args = { _: [], flags: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.rest = argv.slice(i + 1);
      break;
    }
    const m = /^--([a-z][\w-]*)(?:=(.*))?$/i.exec(a);
    if (m) {
      if (m[2] !== undefined) out.flags[m[1]] = m[2];
      else if (valued.includes(m[1]) && i + 1 < argv.length) out.flags[m[1]] = argv[++i];
      else out.flags[m[1]] = true;
    } else out._.push(a);
  }
  return out;
}
export const str = (a: Args, k: string) => (typeof a.flags[k] === "string" ? (a.flags[k] as string) : undefined);
export const has = (a: Args, k: string) => a.flags[k] !== undefined;
