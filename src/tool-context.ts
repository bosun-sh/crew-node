import type { Config } from "./config.js";
import type { EffectivePolicy } from "./policy.js";

export type ToolContext = {
  config: Config;
  root: string;
  policy: EffectivePolicy;
};
