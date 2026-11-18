// Instance configuration. Everything a site owner normally changes lives in site.config.json;
// this module fills in defaults and works out which panels each page shows.
import { ASPECTS, COMMON_PANELS, ENDPOINTS } from "./aspects.js";
import { SOURCES } from "./model.js";

export const DEFAULT_CONFIG = {
  title: "koetai-reconciliator",
  tagline: "Scholarly profiles without a server",
  intro: "",
  accent: "#2f6f5e",
  sources: SOURCES,
  wikidataEndpoint: ENDPOINTS.qlever.url,
  liveHarvest: true,
  wikidataCreate: true,
  wikidataFixes: true,
  wikidataWorks: true,
  searchOntologies: null, // OLS ontologies the search box covers (null: all)
  wikipediaCoverage: true, // Wikipedia articles and subtype panels on disease pages
  wikipediaLanguages: ["en", "de", "fr", "es", "it", "nl", "pt", "pl", "ru", "ja", "zh", "ar"],
  seeds: [],
  panels: {},
};

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG, ...raw };
  c.sources = (c.sources ?? SOURCES).filter((s) => SOURCES.includes(s));
  c.seeds = (c.seeds ?? []).map((s) => (typeof s === "string" ? { key: s } : s));
  return c;
}

/**
 * Panels for one aspect: built-in panels minus `hide`, plus `add` (inserted after `after`, else appended),
 * then the common panels. Each panel gets `file`, the path of its SPARQL query.
 *   "panels": { "author": { "hide": ["venues"], "add": [{ "id": "…", "title": "…", "query": "queries/custom/…", "render": "vega-lite", "spec": {…} }] } }
 */
export function panelsFor(config, aspect) {
  const conf = config.panels?.[aspect] ?? {};
  const hide = new Set(conf.hide ?? []);
  const list = ASPECTS[aspect].panels.filter((p) => !hide.has(p.id)).map((p) => ({ ...p, file: `queries/${aspect}/${p.id}.rq` }));
  for (const p of conf.add ?? []) {
    const panel = { render: "table", ...p, file: p.query ?? `queries/custom/${aspect}/${p.id}.rq`, custom: true };
    const at = p.after ? list.findIndex((x) => x.id === p.after) : -1;
    if (at >= 0) list.splice(at + 1, 0, panel); else list.push(panel);
  }
  const hideCommon = new Set(config.panels?.common?.hide ?? []);
  return list.concat(COMMON_PANELS.filter((p) => !hideCommon.has(p.id)).map((p) => ({ ...p, file: `queries/common/${p.id}.rq` })));
}
