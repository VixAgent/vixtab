// A tiny hand-drawn diagram kit: rough.js strokes + a handwriting font (Patrick Hand, OFL-1.1) converted to SVG paths, so the
// images look the same everywhere (GitHub, the VS Code Marketplace) without loading fonts. Light and dark palettes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import opentype from "opentype.js";
import rough from "roughjs";

const fontFile = (name: string) => {
  const b = readFileSync(join(import.meta.dir, "..", "..", "node_modules", "@fontsource", name));
  return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
};
const HAND = fontFile("patrick-hand/files/patrick-hand-latin-400-normal.woff");
const HAND_EXT = fontFile("patrick-hand/files/patrick-hand-latin-ext-400-normal.woff");

/** opentype.js toPathData() emits NaN for some coordinates; serialize the commands ourselves. */
function pathData(cmds: any[]): string {
  const n = (v: number) => (Math.round(v * 10) / 10).toString();
  return cmds
    .map((c) =>
      c.type === "M" || c.type === "L" ? `${c.type}${n(c.x)} ${n(c.y)}`
      : c.type === "Q" ? `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`
      : c.type === "C" ? `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`
      : "Z",
    )
    .join("");
}

export type Theme = "light" | "dark";
export type Hue = "ink" | "blue" | "green" | "orange" | "yellow" | "red" | "purple" | "gray" | "paper";

const PALETTE: Record<Theme, Record<Hue, { stroke: string; fill: string }> & { bg: string; muted: string }> = {
  light: {
    bg: "#fdfcf7", muted: "#868e96",
    ink: { stroke: "#1e1e1e", fill: "#ffffff" },
    paper: { stroke: "#1e1e1e", fill: "#fdfcf7" },
    blue: { stroke: "#1971c2", fill: "#d0ebff" },
    green: { stroke: "#2b8a3e", fill: "#d3f9d8" },
    orange: { stroke: "#d9480f", fill: "#ffe8cc" },
    yellow: { stroke: "#e67700", fill: "#fff3bf" },
    red: { stroke: "#c92a2a", fill: "#ffe3e3" },
    purple: { stroke: "#6741d9", fill: "#e5dbff" },
    gray: { stroke: "#495057", fill: "#f1f3f5" },
  },
  dark: {
    bg: "#16181d", muted: "#909296",
    ink: { stroke: "#e9ecef", fill: "#22252b" },
    paper: { stroke: "#e9ecef", fill: "#16181d" },
    blue: { stroke: "#74c0fc", fill: "#1b2e45" },
    green: { stroke: "#8ce99a", fill: "#1b3524" },
    orange: { stroke: "#ffa94d", fill: "#3d2817" },
    yellow: { stroke: "#ffd43b", fill: "#3a3417" },
    red: { stroke: "#ff8787", fill: "#3f1d1f" },
    purple: { stroke: "#b197fc", fill: "#2b2342" },
    gray: { stroke: "#ced4da", fill: "#25282e" },
  },
};

type Opt = { hue?: Hue; fill?: boolean | Hue; dash?: boolean; width?: number; rough?: number; hachure?: boolean };

export class Sketch {
  private parts: string[] = [];
  private gen = rough.generator();
  private seed = 1;
  constructor(public w: number, public h: number, public theme: Theme) {}

  private col(h: Hue = "ink") {
    return PALETTE[this.theme][h];
  }
  get muted() {
    return PALETTE[this.theme].muted;
  }

  private emit(drawable: any, o: Opt) {
    const outline = this.col(o.hue).stroke;
    for (const p of this.gen.toPaths(drawable)) {
      const dash = o.dash && p.stroke === outline && (!p.fill || p.fill === "none");
      this.parts.push(
        `<path d="${p.d}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" fill="${p.fill || "none"}"${dash ? ' stroke-dasharray="7 6"' : ""} stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    }
  }

  private ro(o: Opt) {
    const c = this.col(o.hue);
    const fillHue = o.fill === true ? o.hue : o.fill || undefined;
    return {
      seed: this.seed++,
      roughness: o.rough ?? 1.1,
      bowing: 0.8,
      stroke: c.stroke,
      strokeWidth: o.width ?? 1.8,
      fill: fillHue ? this.col(fillHue as Hue).fill : undefined,
      fillStyle: o.hachure ? "hachure" : "solid",
      hachureGap: 6,
      fillWeight: 1.2,
    };
  }

  rect(x: number, y: number, w: number, h: number, o: Opt = {}) {
    this.emit(this.gen.rectangle(x, y, w, h, this.ro(o)), o);
    return this;
  }
  /** Rounded rectangle drawn as a rough path. */
  box(x: number, y: number, w: number, h: number, o: Opt & { r?: number } = {}) {
    const r = Math.min(o.r ?? 10, w / 2, h / 2);
    const d = `M${x + r} ${y} L${x + w - r} ${y} Q${x + w} ${y} ${x + w} ${y + r} L${x + w} ${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} L${x + r} ${y + h} Q${x} ${y + h} ${x} ${y + h - r} L${x} ${y + r} Q${x} ${y} ${x + r} ${y} Z`;
    this.emit(this.gen.path(d, this.ro(o)), o);
    return this;
  }
  ellipse(cx: number, cy: number, w: number, h: number, o: Opt = {}) {
    this.emit(this.gen.ellipse(cx, cy, w, h, this.ro(o)), o);
    return this;
  }
  line(x1: number, y1: number, x2: number, y2: number, o: Opt = {}) {
    this.emit(this.gen.line(x1, y1, x2, y2, this.ro(o)), o);
    return this;
  }
  path(d: string, o: Opt = {}) {
    this.emit(this.gen.path(d, this.ro(o)), o);
    return this;
  }
  /** Arrow from (x1,y1) to (x2,y2); `bend` > 0 curves it. */
  arrow(x1: number, y1: number, x2: number, y2: number, o: Opt & { bend?: number; head?: number } = {}) {
    const bend = o.bend ?? 0;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    const cx = mx - (dy / len) * bend, cy = my + (dx / len) * bend;
    this.path(bend ? `M${x1} ${y1} Q${cx} ${cy} ${x2} ${y2}` : `M${x1} ${y1} L${x2} ${y2}`, { ...o, fill: false });
    const ang = Math.atan2(y2 - (bend ? cy : y1), x2 - (bend ? cx : x1)), hl = o.head ?? 12;
    for (const s of [-1, 1]) this.line(x2, y2, x2 - hl * Math.cos(ang + s * 0.45), y2 - hl * Math.sin(ang + s * 0.45), { ...o, dash: false });
    return this;
  }
  check(x: number, y: number, s = 14, o: Opt = {}) {
    return this.path(`M${x} ${y} L${x + s * 0.38} ${y + s * 0.4} L${x + s} ${y - s * 0.55}`, { hue: "green", width: 2.6, ...o });
  }
  cross(x: number, y: number, s = 12, o: Opt = {}) {
    this.line(x - s / 2, y - s / 2, x + s / 2, y + s / 2, { hue: "red", width: 2.4, ...o });
    return this.line(x + s / 2, y - s / 2, x - s / 2, y + s / 2, { hue: "red", width: 2.4, ...o });
  }
  /** Zig-zag scribble standing for text lines. */
  scribble(x: number, y: number, w: number, lines = 3, o: Opt = {}) {
    for (let i = 0; i < lines; i++) {
      const ww = w * (i === lines - 1 ? 0.6 : 0.92 - (i % 2) * 0.1);
      this.line(x, y + i * 12, x + ww, y + i * 12, { hue: "gray", width: 1.3, rough: 1.6, ...o });
    }
    return this;
  }
  textWidth(s: string, size: number) {
    return HAND.getAdvanceWidth(s, size);
  }
  /** Handwritten text as paths. anchor: start | middle | end. */
  text(x: number, y: number, s: string, size = 18, o: { hue?: Hue; color?: string; anchor?: "start" | "middle" | "end"; muted?: boolean; maxWidth?: number } = {}) {
    const color = o.color ?? (o.muted ? this.muted : this.col(o.hue).stroke);
    if (o.maxWidth && this.textWidth(s, size) > o.maxWidth) size = (size * o.maxWidth) / this.textWidth(s, size);
    let cx = x;
    const w = this.textWidth(s, size);
    if (o.anchor === "middle") cx -= w / 2;
    if (o.anchor === "end") cx -= w;
    let d = "";
    for (const ch of s) {
      const font = HAND.charToGlyph(ch).name === ".notdef" && HAND_EXT.charToGlyph(ch).name !== ".notdef" ? HAND_EXT : HAND;
      d += pathData(font.getPath(ch, cx, y, size).commands);
      cx += font.getAdvanceWidth(ch, size);
    }
    this.parts.push(`<path d="${d}" fill="${color}"/>`);
    return this;
  }
  /** Status badge like "DOING" in a little rounded box. */
  badge(x: number, y: number, label: string, hue: Hue, size = 14) {
    const w = this.textWidth(label, size) + 16;
    this.box(x, y - size + 1, w, size + 8, { hue, fill: true, r: 7, width: 1.4 });
    this.text(x + 8, y + 3, label, size, { hue });
    return w;
  }
  svg(title: string) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}" height="${this.h}" viewBox="0 0 ${this.w} ${this.h}" role="img">` +
      `<title>${title}</title><rect width="${this.w}" height="${this.h}" rx="18" fill="${PALETTE[this.theme].bg}"/>` +
      this.parts.join("") +
      `</svg>\n`
    );
  }
}
