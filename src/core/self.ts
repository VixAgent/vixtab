// How to invoke this very program again (child processes, generated config): the compiled binary, or `bun src/cli.ts` in dev.
import { basename, join, resolve } from "node:path";
import { IS_WIN, norm } from "./util.ts";

export const isCompiled = () => !/^bun(\.exe)?$/i.test(basename(process.execPath));
export function selfArgv(): string[] {
  return isCompiled() ? [process.execPath] : [process.execPath, norm(resolve(join(import.meta.dir, "..", "cli.ts")))];
}
/** The same as one shell-safe command line (for config files). */
export const selfLine = () => selfArgv().map((x) => (/[\s"'$\\]/.test(x) || IS_WIN ? JSON.stringify(norm(x)) : x)).join(" ");
