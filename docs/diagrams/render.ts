// bun docs/diagrams/render.ts [name…] — writes docs/images/<name>.svg, <name>-dark.svg and <name>.png (PNG for the Marketplace).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { FIGURES } from "./figures.ts";

const OUT = join(import.meta.dir, "..", "images");
mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
for (const [name, draw] of Object.entries(FIGURES)) {
  if (only.length && !only.includes(name)) continue;
  const light = draw("light"), dark = draw("dark");
  writeFileSync(join(OUT, `${name}.svg`), light);
  writeFileSync(join(OUT, `${name}-dark.svg`), dark);
  writeFileSync(join(OUT, `${name}.png`), new Resvg(light, { fitTo: { mode: "zoom", value: 1.5 } }).render().asPng());
  console.log(`${name}: svg ${(light.length / 1024).toFixed(0)} KB, dark ${(dark.length / 1024).toFixed(0)} KB, png`);
}
