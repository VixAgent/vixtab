import { IS_WIN } from "../core/util.ts";
import { linux } from "./linux.ts";
import type { Platform } from "./types.ts";
import { windows } from "./windows.ts";

export const platform: Platform = IS_WIN ? windows : linux;
export type { Platform, Proc } from "./types.ts";
