import pkg from "../../../package.json" with { type: "json" };

// Display branding only — never consumed for API contracts, headers, package
// imports, or DB identifiers (those stay "omniroute"/"OmniRoute" for
// compatibility; see APP_CONFIG.version usages in omnirouteResponseMeta.ts /
// clineAuth.ts). Safe to change for a rebrand; see CUSTOM_CHANGES.md.
export const APP_CONFIG = {
  name: "OmniRoute Custom",
  description: "AI Gateway for Multi-Provider LLMs — customized distribution based on OmniRoute",
  version: pkg.version,
};

export const THEME_CONFIG = {
  storageKey: "theme",
  defaultTheme: "system",
};
