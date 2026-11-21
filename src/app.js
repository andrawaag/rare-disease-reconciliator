// koetai-reconciliator web app: routing, loading a graph (snapshot or live harvest), and rendering panels.
import { QueryEngine, Store, Parser, Writer, DataFactory } from "../vendor/comunica.js";
import { ASPECTS, ENDPOINTS, fillPanel } from "./aspects.js";
import { normalizeConfig, panelsFor } from "./config.js";
import { parseKey, keyString, iriToKey } from "./model.js";
import { harvest } from "./harvest.js";
import { searchObo } from "./adapters/obo.js";
import { findByStatementsLive, claimValuesLive, statementsLive } from "./wikidata-live.js";
import { gatherFixes, buildFixCommands, fixKey, deprecationEdit, statementValue } from "./wikidata-fix.js";
import { gatherMissingWorks, checkOnWikidata, buildWorkCommands, workStatus, P31_LABEL } from "./wikidata-works.js";
import { sitelinksLive, articleUrl, translateUrl, sourceLanguage, languageName, itemsForOrphaCodes, createDiseaseItems, duplicateCandidates, addOrphanetIds, DEFAULT_LANGUAGES } from "./wikipedia.js";
import { personFacts, profileCandidates, profileCommands } from "./profile-match.js";
import { gatherCandidate, findExisting, searchByName, buildCommands, quickStatementsUrl, propertyLabel, propertyUrl } from "./wikidata-create.js";

const engine = new QueryEngine();
const $ = (sel, el = document) => el.querySelector(sel);
const main = $("#main");

// ---------- instance configuration (site.config.json) ----------
const config = normalizeConfig(await fetch("site.config.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
$(".brand").textContent = config.title;
document.documentElement.style.setProperty("--accent-config", config.accent);

// ---------- settings ----------
const store = {
  get: (k, d) => { try { return localStorage.getItem(`kr.${k}`) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`kr.${k}`, v); } catch {} },
};
const endpoints = { site: { label: `Site default (${new URL(config.wikidataEndpoint).host})`, url: config.wikidataEndpoint }, ...ENDPOINTS };
const settings = { mode: config.liveHarvest ? store.get("mode", "auto") : "snapshot", endpoint: store.get("endpoint", "site") };
if (!endpoints[settings.endpoint]) settings.endpoint = "site";
const endpointSel = $("#endpoint");
for (const [id, e] of Object.entries(endpoints)) endpointSel.add(new Option(e.label, id));
endpointSel.value = settings.endpoint;
$("#mode").value = settings.mode;
if (!config.liveHarvest) $(".settings").hidden = true;
for (const id of ["mode", "endpoint"]) $(`#${id}`).addEventListener("change", (e) => { settings[id] = e.target.value; store.set(id, e.target.value); graphs.clear(); route(); });

// ---------- text resources ----------
const texts = new Map();
const loadText = (p) => texts.get(p) ?? texts.set(p, fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.text(); })).get(p);
let manifest = null;
const getManifest = async () => (manifest ??= await fetch("data/manifest.json").then((r) => (r.ok ? r.json() : { entities: {}, aliases: {} })).catch(() => ({ entities: {}, aliases: {} })));

// ---------- loading graphs ----------
const graphs = new Map(); // key -> Promise<graph>

async function loadSnapshot(entry) {
  const res = await fetch(entry.file);
  if (!res.ok) throw new Error(`snapshot ${entry.file}: HTTP ${res.status}`);
  const text = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text();
  return new Parser({ format: "N-Quads" }).parse(text);
}

function loadGraph(key, aspectHint, onProgress) {
  const id = `${keyString(key)}|${aspectHint ?? ""}`;
  if (!graphs.has(id)) graphs.set(id, (async () => {
    const m = await getManifest();
    const snapKey = m.entities[keyString(key)] ? keyString(key) : m.aliases?.[keyString(key)];
    const entry = snapKey && m.entities[snapKey];
    if (entry && settings.mode !== "live" && (!aspectHint || aspectHint === entry.aspect)) {
      onProgress({ source: "snapshot", what: entry.file, state: "running" });
      const t0 = performance.now();
      const quads = await loadSnapshot(entry);
      onProgress({ source: "snapshot", what: entry.file, state: "done", quads: quads.length });
      return { ...entry, key: snapKey, quads, store: new Store(quads), snapshot: entry, log: [{ source: "snapshot", what: `built ${entry.generated.slice(0, 10)}`, quads: quads.length, ms: Math.round(performance.now() - t0) }, ...entry.log] };
    }
    if (settings.mode === "snapshot") throw new Error("No snapshot for this entity, and the mode is set to snapshots only.");
    const ctx = harvestContext();
    const g = await harvest(ctx, key, aspectHint, onProgress);
    return { ...g, store: new Store(g.quads) };
  })());
  const p = graphs.get(id);
  p.catch(() => graphs.delete(id));
  return p;
}

// ---------- rendering helpers ----------
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v; else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
};

const COLUMN_ASPECT = { work: "work", cited: "work", citing: "work", author: "author", coauthor: "author", venue: "venue", topic: "topic", parent: "term", child: "term", replacedBy: "term", code: "term", gene: "topic" };
const HIDDEN = new Set(["position"]);

function externalUrl(key) {
  return {
    orcid: `https://orcid.org/${key.value}`,
    doi: `https://doi.org/${key.value}`,
    wikidata: `https://www.wikidata.org/wiki/${key.value}`,
    issn: `https://portal.issn.org/resource/ISSN/${key.value}`,
    openalex: `https://openalex.org/${key.value}`,
    obo: /^Orphanet_/.test(key.value) ? `https://www.orpha.net/en/disease/detail/${key.value.slice(9)}` : `http://purl.obolibrary.org/obo/${key.value}`,
    pmid: `https://pubmed.ncbi.nlm.nih.gov/${key.value}/`,
  }[key.scheme];
}

function entityLink(iri, label, column) {
  const key = iriToKey(iri);
  const aspect = COLUMN_ASPECT[column];
  const text = label || (key ? `${key.scheme}:${key.value}` : "(unnamed)");
  // Codes in other terminologies (SNOMED CT, MeSH, ICD, …) have no page here: link to the terminology itself.
  if (!key) return /^https?:\/\//.test(iri) ? h("a", { href: iri, target: "_blank", rel: "noopener", class: "external", title: iri }, label || iri) : h("span", { class: "unlinked", title: iri }, text);
  return h("a", { href: `#/${aspect ? aspect + "/" : ""}${keyString(key)}` }, text);
}

function sourceBadges(value) {
  return h("span", { class: "badges" }, value.split(" ").filter(Boolean).map((s) => h("span", { class: `badge src-${s}` }, s)));
}

function renderTable(rows, vars) {
  const cols = vars.filter((v) => !v.endsWith("Label") && !HIDDEN.has(v));
  if (!rows.length) return h("p", { class: "empty" }, "Nothing found in the merged graph.");
  const body = rows.map((b) => h("tr", {}, cols.map((c) => {
    const t = b.get(c);
    if (!t) return h("td");
    if (c === "sources") return h("td", {}, sourceBadges(t.value));
    if (t.termType === "NamedNode") return h("td", {}, entityLink(t.value, b.get(`${c}Label`)?.value, c));
    const numeric = /integer|int|decimal|double/.test(t.datatype?.value ?? "");
    if (c === "status") return h("td", { class: `check-${t.value.replace(/\W+/g, "-")}` }, t.value);
    return h("td", { class: numeric ? "num" : c === "date" ? "nowrap" : null }, t.value);
  })));
  const table = h("table", {}, h("thead", {}, h("tr", {}, cols.map((c) => h("th", {}, c)))), h("tbody", {}, body));
  return rows.length > 12 ? h("div", { class: "scroll" }, table) : table;
}

function renderKv(rows, vars) {
  const b = rows[0];
  if (!b) return h("p", { class: "empty" }, "No details.");
  return h("dl", { class: "kv" }, vars.filter((v) => !v.endsWith("Label") && b.get(v) && b.get(v).value !== "").map((v) => {
    const t = b.get(v);
    const value = t.termType === "NamedNode" ? entityLink(t.value, b.get(`${v}Label`)?.value, v)
      : /^https?:\/\/\S+$/.test(t.value) ? h("a", { href: t.value, target: "_blank", rel: "noopener" }, t.value) : t.value;
    return [h("dt", {}, v), h("dd", {}, value)];
  }));
}

// Bars: first variable is the label, second the value. Integer labels (years) get their gaps filled.
function renderBars(rows, vars) {
  const [lx, ly] = vars;
  const pairs = rows.map((b) => [b.get(lx)?.value, Number(b.get(ly)?.value)]).filter(([x, y]) => x != null && Number.isFinite(y));
  if (!pairs.length) return h("p", { class: "empty" }, "Nothing to chart.");
  let data;
  if (pairs.every(([x]) => /^-?\d{1,4}$/.test(x))) {
    const counts = new Map(pairs.map(([x, y]) => [Number(x), y]));
    const xs = [...counts.keys()];
    data = [];
    for (let x = Math.min(...xs); x <= Math.max(...xs); x++) data.push({ x: String(x), y: counts.get(x) ?? 0 });
  } else data = pairs.map(([x, y]) => ({ x, y }));
  const W = 640, H = 180, pad = 24, max = Math.max(...data.map((d) => d.y));
  const bw = (W - pad) / data.length;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H + 20}`);
  svg.setAttribute("class", "bars");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${ly} by ${lx}, ${data[0].x} to ${data.at(-1).x}`);
  const step = Math.ceil(data.length / 12);
  data.forEach((d, i) => {
    const bh = (d.y / max) * (H - 10);
    const r = document.createElementNS(ns, "rect");
    Object.entries({ x: pad + i * bw + 1, y: H - bh, width: Math.max(bw - 2, 1), height: bh, rx: 2 }).forEach(([k, v]) => r.setAttribute(k, v));
    const title = document.createElementNS(ns, "title"); title.textContent = `${d.x}: ${d.y}`; r.append(title);
    svg.append(r);
    if (i % step === 0) {
      const t = document.createElementNS(ns, "text");
      Object.entries({ x: pad + i * bw + bw / 2, y: H + 15, "text-anchor": "middle" }).forEach(([k, v]) => t.setAttribute(k, v));
      t.textContent = d.x; svg.append(t);
    }
  });
  const yl = document.createElementNS(ns, "text");
  Object.entries({ x: 0, y: 12 }).forEach(([k, v]) => yl.setAttribute(k, v)); yl.textContent = max; svg.append(yl);
  return svg;
}

function renderIds(rows) {
  return h("ul", { class: "ids" }, rows.map((b) => {
    const key = iriToKey(b.get("id").value);
    if (!key) return null;
    return h("li", {}, h("span", { class: "scheme" }, key.scheme), " ", h("a", { href: externalUrl(key), rel: "noopener" }, key.value));
  }));
}

// Vega-Lite: the panel's "spec" from site.config.json, with the query results as data.
// Loaded from a CDN only when a page actually has such a panel.
let vegaReady;
const VEGA = ["https://cdn.jsdelivr.net/npm/vega@5.30.0", "https://cdn.jsdelivr.net/npm/vega-lite@5.21.0", "https://cdn.jsdelivr.net/npm/vega-embed@6.26.0"];
function loadVega() {
  return (vegaReady ??= (async () => {
    for (const src of VEGA) await new Promise((ok, fail) => { const s = h("script", { src }); s.onload = ok; s.onerror = () => fail(new Error(`Could not load ${src}`)); document.head.append(s); });
    return window.vegaEmbed;
  })());
}
async function renderVegaLite(rows, vars, panel, body) {
  if (!rows.length) return h("p", { class: "empty" }, "Nothing to chart.");
  const values = rows.map((b) => Object.fromEntries(vars.map((v) => {
    const t = b.get(v);
    if (!t) return [v, null];
    return [v, /integer|int|decimal|double|float/.test(t.datatype?.value ?? "") ? Number(t.value) : t.value];
  })));
  const css = getComputedStyle(document.documentElement);
  const c = (n) => css.getPropertyValue(n).trim();
  const el = h("div", { class: "vega" });
  body.replaceChildren(el);
  const spec = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json", width: "container", height: 220, background: null,
    ...panel.spec, data: { values },
    config: { axis: { labelColor: c("--muted"), titleColor: c("--muted"), gridColor: c("--line"), domainColor: c("--line"), tickColor: c("--line") }, legend: { labelColor: c("--ink"), titleColor: c("--muted") }, view: { stroke: null }, ...(panel.spec?.config ?? {}) },
  };
  await (await loadVega())(el, spec, { actions: { export: true, source: false, compiled: false, editor: false }, renderer: "svg" });
}

const RENDER = { table: renderTable, kv: renderKv, bars: renderBars, ids: renderIds, "vega-lite": renderVegaLite };

async function runPanel(graph, panel, el) {
  const file = panel.file;
  const body = $(".panel-body", el);
  try {
    const query = fillPanel(await loadText("queries/prefixes.rq"), await loadText(file), graph.iri);
    $(".sparql pre", el).textContent = query;
    const t0 = performance.now();
    const result = await engine.query(query, { sources: [graph.store], unionDefaultGraph: true });
    const vars = (await result.metadata()).variables.map((v) => (v.variable ?? v).value);
    const rows = await (await result.execute()).toArray();
    if (!rows.length && panel.hideEmpty) return el.remove();
    const render = RENDER[panel.render];
    if (!render) throw new Error(`Unknown renderer "${panel.render}". Use one of: ${Object.keys(RENDER).join(", ")}.`);
    const node = await render(rows, vars, panel, body);
    if (node) body.replaceChildren(node);
    $(".timing", el).textContent = `${rows.length} rows · ${Math.round(performance.now() - t0)} ms`;
  } catch (err) {
    body.replaceChildren(h("p", { class: "error" }, String(err.message ?? err)));
  }
}

function panelShell(panel) {
  return h("section", { class: `panel panel-${panel.render}${panel.wide ? " wide" : ""}`, id: `panel-${panel.id}` },
    h("header", {}, h("h2", {}, panel.title), h("span", { class: "timing" })),
    h("div", { class: "panel-body" }, h("p", { class: "loading" }, "Querying…")),
    h("details", { class: "sparql" }, h("summary", {}, "SPARQL"), h("pre")));
}

function downloadGraph(graph) {
  const w = new Writer({ format: "N-Quads" });
  w.addQuads(graph.quads);
  w.end((err, text) => {
    if (err) return;
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "application/n-quads" })), download: `${graph.key.replace(/[^\w.-]/g, "_")}.nq` });
    document.body.append(a); a.click(); a.remove();
  });
}

// ---------- Add to Wikidata (authors without a Wikidata item) ----------
const normName = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[.\-,']/g, " ").replace(/\s+/g, " ").trim();
async function wikidataPanel(graph) {
  const run = async (file) => (await engine.queryBindings(fillPanel(await loadText("queries/prefixes.rq"), await loadText(file), graph.iri), { sources: [graph.store], unionDefaultGraph: true })).toArray();
  const cand = await gatherCandidate(run, graph.iri);
  if (cand.wikidata.length || graph.iri.startsWith("http://www.wikidata.org/") || !cand.ids.length) return null;

  const status = h("span", { class: "timing" }, "Checking Wikidata…");
  const box = h("div", { class: "panel-body" });
  const el = h("section", { class: "panel wide wd-create", id: "panel-add-to-wikidata" }, h("header", {}, h("h2", {}, "Not on Wikidata yet"), status), box);

  const [existing, byName] = await Promise.all([
    // SPARQL copy plus Wikidata's live search, which also sees items created minutes ago.
    Promise.all([
      findExisting(engine, endpoints[settings.endpoint].url, cand.ids).catch(() => []),
      findByStatementsLive(fetch, cand.ids).catch(() => []),
    ]).then(([a, b]) => [...new Map([...a, ...b].map((e) => [`${e.qid}|${e.property}|${e.value}`, e])).values()]),
    searchByName(cand.label).catch(() => []),
  ]);
  status.textContent = existing.length ? "Identifier already on Wikidata" : `${cand.ids.length} identifiers found`;
  // Everything is already on one item (e.g. created minutes ago): nothing to do but refresh.
  const done = [...new Set(existing.map((e) => e.qid))].find((q) => cand.ids.every((x) => existing.some((e) => e.qid === q && e.property === x.property && e.value === x.value)));
  if (done) {
    el.querySelector("h2").textContent = "On Wikidata";
    status.textContent = done;
    box.replaceChildren(h("p", {}, h("a", { href: `https://www.wikidata.org/wiki/${done}`, target: "_blank", rel: "noopener" }, done),
      " carries all of this person's identifiers. This page's data was gathered before that; ",
      h("button", { type: "button", class: "linkish", onclick: () => { graphs.clear(); route(); } }, "refresh it"), " to link them."));
    return el;
  }

  // An item with exactly this name that is not a publication is most likely the same person: add to it by default
  // rather than creating a duplicate (the visitor can still choose "Create a new item instead").
  const sameName = byName.filter((m) => normName(m.label) === normName(cand.label) && !/article|journal|book|thesis|publication|review|chapter/i.test(m.description ?? ""));
  let target = existing[0]?.qid ?? (sameName.length === 1 ? sameName[0].qid : null);
  const textarea = h("textarea", { class: "qs", rows: 10, spellcheck: "false", "aria-label": "QuickStatements commands" });
  // For an existing item, read its statements live and propose only the identifiers it lacks. An item picked from the
  // name matches was not found through these identifiers, so the lookups above say nothing about what it holds.
  let generation = 0;
  const regenerate = async () => {
    const mine = ++generation;
    if (!target) {
      textarea.value = buildCommands(cand, { target });
      modeLine.replaceChildren(h("span", {}, "Creates a new item for a human researcher with these names and identifiers."));
      return;
    }
    const itemLink = h("a", { href: `https://www.wikidata.org/wiki/${target}`, target: "_blank", rel: "noopener" }, target);
    const createInstead = h("button", { type: "button", class: "linkish", onclick: () => { target = null; regenerate(); } }, "Create a new item instead");
    textarea.value = "";
    modeLine.replaceChildren(h("span", {}, "Reading ", itemLink, " on Wikidata…"));
    let held;
    try { held = await claimValuesLive(fetch, target, cand.ids.map((x) => x.property)); }
    catch { held = new Map(); for (const e of existing.filter((e) => e.qid === target)) (held.get(e.property) ?? held.set(e.property, new Set()).get(e.property)).add(e.value.toUpperCase()); }
    if (mine !== generation) return; // another item was picked meanwhile
    const has = (x) => held.get(x.property)?.has(String(x.value).toUpperCase());
    const ids = cand.ids.filter((x) => !has(x));
    const skipped = cand.ids.filter(has);
    textarea.value = ids.length ? buildCommands({ ...cand, ids }, { target }) : "";
    modeLine.replaceChildren(h("span", {},
      ids.length ? ["Adds the ", ids.length === 1 ? "identifier" : `${ids.length} identifiers`, " that ", itemLink, " lacks. "] : [itemLink, " already has all of these identifiers; there is nothing to add. "],
      skipped.length ? `Already on the item, so left out: ${skipped.map((x) => `${propertyLabel(x.property)} ${x.value}`).join(", ")}. ` : "",
      createInstead));
  };
  const modeLine = h("p", { class: "mode-line" });
  const useItem = (qid) => h("button", { type: "button", class: "linkish", onclick: () => { target = qid; regenerate(); textarea.scrollIntoView({ block: "nearest" }); } }, "add identifiers to this item");

  box.replaceChildren(...h("div", {},
    h("p", {}, "No Wikidata item carries this person's ORCID or OpenAlex ID. You can add them to Wikidata with ",
      h("a", { href: "https://www.wikidata.org/wiki/Help:QuickStatements", target: "_blank", rel: "noopener" }, "QuickStatements"),
      ", which runs the edits under your own Wikimedia account. Check the possible matches first so you don't create a duplicate."),
    existing.length > 0 && h("div", { class: "warn" }, h("b", {}, "Already on Wikidata: "), existing.map((e, i) => [i ? "; " : "",
      h("a", { href: `https://www.wikidata.org/wiki/${e.qid}`, target: "_blank", rel: "noopener" }, e.label ? `${e.label} (${e.qid})` : e.qid), ` has ${propertyLabel(e.property)} ${e.value}`])),
    h("h3", {}, "Identifiers"),
    h("ul", { class: "ids" }, cand.ids.map((x) => h("li", {}, h("span", { class: "scheme" }, propertyLabel(x.property)), " ",
      h("a", { href: propertyUrl(x.property, x.value), target: "_blank", rel: "noopener" }, x.value), " ",
      h("span", { class: "badges" }, [...x.sources].map((s) => h("span", { class: `badge src-${s}` }, s)))))),
    byName.length ? [h("h3", {}, `Possible matches for “${cand.label}”`), h("ul", { class: "matches" }, byName.map((m) => h("li", {},
      h("a", { href: `https://www.wikidata.org/wiki/${m.qid}`, target: "_blank", rel: "noopener" }, `${m.label ?? m.qid} (${m.qid})`),
      m.description ? ` · ${m.description} · ` : " · ", useItem(m.qid))))] : h("p", { class: "muted" }, `No Wikidata items match the name “${cand.label}”.`),
    h("h3", {}, "QuickStatements"),
    modeLine,
    textarea,
    h("div", { class: "actions" },
      h("button", { type: "button", class: "primary", onclick: () => window.open(quickStatementsUrl(textarea.value), "_blank", "noopener") }, "Open in QuickStatements"),
      h("button", { type: "button", onclick: async (e) => { try { await navigator.clipboard.writeText(textarea.value); e.target.textContent = "Copied"; } catch { textarea.select(); } } }, "Copy commands")),
    h("p", { class: "muted small" }, "Review and edit the commands above before running them. In QuickStatements, log in, press Run, and check the new item. Then refresh this page’s data (the Refresh or “Fetch live instead” button at the top) to see it linked.")).childNodes);
  regenerate();
  return el;
}

// ---------- ORCID and OpenAlex profiles for a Wikidata person without them ----------
async function profilePanel(graph) {
  const qid = graph.iri.startsWith(WD_ENTITY) ? graph.iri.slice(WD_ENTITY.length) : null;
  if (!qid || graph.aspect !== "author" || !config.sources.includes("wikidata")) return null;
  const person = await personFacts(fetch, qid);
  if (person.orcid.length && person.openalex.length) return null;
  const cands = await profileCandidates(fetch, person);
  const wd = (q) => h("a", { href: `https://www.wikidata.org/wiki/${q}`, target: "_blank", rel: "noopener" }, q);
  const missing = [!person.orcid.length && "ORCID", !person.openalex.length && "OpenAlex ID"].filter(Boolean).join(" or ");
  const body = h("div", { class: "panel-body" });
  const el = h("section", { class: "panel wide wd-create", id: "panel-profiles" },
    h("header", {}, h("h2", {}, "Find this person's ORCID and OpenAlex profiles"), h("span", { class: "timing" }, `${cands.length} candidate${cands.length === 1 ? "" : "s"}`)), body);
  const intro = h("p", {}, wd(qid), ` has no ${missing} on Wikidata, so this page has only Wikidata's own statements: no works from ORCID, OpenAlex, Crossref or PubMed. `,
    "These profiles carry the same name or an employer of the item", person.employers.length ? ` (${person.employers.map((e) => e.label).join(", ")})` : "", ". Pick the right one to see the person's works, and add its IDs to Wikidata so this page links them.");
  if (!cands.length) { body.replaceChildren(intro, h("p", { class: "muted" }, `No ORCID or OpenAlex profile found for “${person.label}”.`)); return el; }
  let chosen = cands.find((c) => c.likely && !c.onWikidata.length) ?? null;
  const textarea = h("textarea", { class: "qs", rows: 3, spellcheck: "false", "aria-label": "QuickStatements commands" });
  const regenerate = () => { textarea.value = chosen ? profileCommands(qid, chosen, { has: { orcid: person.orcid, openalex: person.openalex } }) : ""; };
  const link = (href, text) => h("a", { href, target: "_blank", rel: "noopener" }, text);
  const rows = cands.slice(0, 8).map((c) => {
    const key = c.orcid ? `orcid:${c.orcid}` : `openalex:${c.openalex}`;
    return h("li", { class: "choice" }, h("label", {},
      h("input", { type: "radio", name: "profile", checked: c === chosen, onchange: () => { chosen = c; regenerate(); } }), " ",
      h("b", {}, c.name), " · ",
      c.orcid ? ["ORCID ", link(`https://orcid.org/${c.orcid}`, c.orcid), " · "] : "",
      c.openalex ? ["OpenAlex ", link(`https://openalex.org/${c.openalex}`, c.openalex), c.works != null ? ` (${c.works} works)` : "", " · "] : "",
      c.institutions.length ? `${c.institutions.slice(0, 3).join("; ")} · ` : "",
      [c.sameName && "same name", c.sharedEmployers.length && `shares employer ${c.sharedEmployers.join(", ")}`].filter(Boolean).join(", "),
      c.onWikidata.length ? h("span", { class: "warn-inline" }, [" · already on ", c.onWikidata.map((x, i) => [i ? ", " : "", wd(x.qid)]), ": probably someone else, or a duplicate item"]) : ""),
      " ", h("a", { href: `#/author/${key}` }, "open this profile's page"));
  });
  body.replaceChildren(intro,
    h("ul", { class: "dups choices" }, rows,
      h("li", { class: "choice" }, h("label", {}, h("input", { type: "radio", name: "profile", checked: !chosen, onchange: () => { chosen = null; regenerate(); } }), " none of these"))),
    h("h3", {}, "QuickStatements"),
    textarea,
    h("div", { class: "actions" },
      h("button", { type: "button", class: "primary", onclick: () => textarea.value && window.open(quickStatementsUrl(textarea.value), "_blank", "noopener") }, "Open in QuickStatements"),
      h("button", { type: "button", onclick: async (e) => { try { await navigator.clipboard.writeText(textarea.value); e.target.textContent = "Copied"; } catch { textarea.select(); } } }, "Copy commands")),
    h("p", { class: "muted small" }, "A profile is preselected only when the name matches and it shares an employer with the item. Check the works on the profile's page first: some names belong to several people. The IDs cite OpenAlex (or ORCID). You run the edits under your own Wikimedia account; then refresh this page to load the works."));
  regenerate();
  return el;
}

// ---------- Works missing on Wikidata (authors) ----------
const PAPER_TYPES = new Set(["Q13442814", "Q23927052", "Q580922", "Q21481766", "Q7318358"]);
async function missingWorksPanel(graph) {
  const run = async (file) => (await engine.queryBindings(fillPanel(await loadText("queries/prefixes.rq"), await loadText(file), graph.iri), { sources: [graph.store], unionDefaultGraph: true })).toArray();
  const found = await gatherMissingWorks(run, graph.iri);
  if (!found.works.length) return null;

  const status = h("span", { class: "timing" }, `${found.works.length} candidates`);
  const body = h("div", { class: "panel-body" });
  const el = h("section", { class: "panel wide wd-create", id: "panel-missing-works" }, h("header", {}, h("h2", {}, "Works missing on Wikidata"), status), body);
  const check = h("button", { type: "button", class: "primary" }, "Check against Wikidata");
  body.append(
    h("p", {}, `${found.works.length} works with a DOI are attributed to this person by ORCID, Crossref, DataCite or OpenAlex but are not linked to `,
      found.authorQid ? h("a", { href: `https://www.wikidata.org/wiki/${found.authorQid}`, target: "_blank", rel: "noopener" }, found.authorQid) : "a Wikidata item for them",
      " (no “author” statement). Check them against Wikidata by DOI to see which need a new item and which only need this author added."),
    h("div", { class: "actions" }, check));
  check.onclick = async () => {
    check.disabled = true; check.textContent = "Checking…";
    try { await checkOnWikidata(engine, endpoints[settings.endpoint].url, found); }
    catch (err) { check.disabled = false; check.textContent = "Check against Wikidata"; body.append(h("p", { class: "error" }, String(err.message ?? err))); return; }
    renderChecked();
  };

  function renderChecked() {
    const groups = { link: [], create: [], claimed: [], skipped: [] };
    for (const w of found.works) {
      const s = workStatus(found, w);
      (groups[s] ?? groups.skipped).push(Object.assign(w, { status: s }));
    }
    const chosen = new Set([...groups.link, ...groups.create.filter((w) => PAPER_TYPES.has(w.p31))].map((w) => w.doi));
    const opts = { removeNameStrings: true, language: "en" };
    const textarea = h("textarea", { class: "qs", rows: 10, spellcheck: "false", "aria-label": "QuickStatements commands" });
    const counter = h("span", { class: "muted small" });
    const regenerate = () => {
      textarea.value = buildWorkCommands(found, chosen, opts);
      const n = found.works.filter((w) => chosen.has(w.doi));
      counter.textContent = `${n.filter((w) => w.status === "create").length} new items, ${n.filter((w) => w.status !== "create").length} author statements on existing items`;
    };
    const boxes = new Map();
    const row = (w, extra) => {
      const box = h("input", { type: "checkbox", checked: chosen.has(w.doi), onchange: (e) => { e.target.checked ? chosen.add(w.doi) : chosen.delete(w.doi); regenerate(); } });
      boxes.set(w.doi, box);
      return h("li", {}, h("label", {}, box, " ",
        h("a", { href: `#/work/doi:${w.doi}` }, w.title || w.doi), " ",
        h("span", { class: "muted" }, [w.date.slice(0, 10), w.p31 ? P31_LABEL[w.p31] : null].filter(Boolean).join(" · ")), " ",
        h("span", { class: `badge src-${w.source}` }, w.source), extra ?? null));
    };
    const toggleAll = (list, on) => { for (const w of list) { on ? chosen.add(w.doi) : chosen.delete(w.doi); boxes.get(w.doi).checked = on; } regenerate(); };
    const group = (title, list, note, extra) => list.length ? [
      h("h3", {}, `${title} (${list.length})`, " ",
        h("button", { type: "button", class: "linkish", onclick: () => toggleAll(list, true) }, "all"), " / ",
        h("button", { type: "button", class: "linkish", onclick: () => toggleAll(list, false) }, "none")),
      note ? h("p", { class: "muted small" }, note) : null,
      h("ul", { class: "fixes worklist" }, list.map((w) => row(w, extra?.(w)))),
    ] : null;
    const wdItem = (w) => [" → ", h("a", { href: `https://www.wikidata.org/wiki/${w.existing.qid}`, target: "_blank", rel: "noopener" }, w.existing.qid),
      w.myPosition ? ` as author #${w.myPosition}` : "", w.removable ? `, replacing name string “${w.removable}”` : ""];
    const skippedWhy = { linked: "on Wikidata, and the item already names this author (a recent edit the SPARQL copy doesn't show yet)", "no-authors": "no author list from Crossref, DataCite or OpenAlex", unsupported: "work type not supported", "link-blocked": "on Wikidata; create this person's item first", duplicate: "same title as another DOI that is on Wikidata or proposed above (e.g. another Zenodo version)" };

    status.textContent = `${groups.create.length} to create · ${groups.link.length} to link`;
    body.replaceChildren(...h("div", {},
      !found.authorQid ? h("p", { class: "warn" }, "This person has no Wikidata item yet, so new items list them as an author name string (P2093). Create their item first (see “Not on Wikidata yet”) to link them properly.") : null,
      group("Add this author to existing items", groups.link, "These works are on Wikidata and their author list names this person, but the item has no author statement for them.", wdItem),
      group("Create new items", groups.create, "Not on Wikidata. Papers are ticked; data sets, software and books are not. Each item gets title, type, DOI, PubMed ID where known, date, venue and all authors in order (Wikidata items where known, otherwise name strings)."),
      group("Only claimed by ORCID", groups.claimed, "On Wikidata, but this person is not in the work's author list (for example a group author). Check before adding.", wdItem),
      groups.skipped.length ? [h("h3", {}, `Not proposed (${groups.skipped.length})`), h("ul", { class: "matches" }, groups.skipped.map((w) => h("li", {}, h("a", { href: `#/work/doi:${w.doi}` }, w.title || w.doi), ` · ${skippedWhy[w.status] ?? w.status}`)))] : null,
      h("h3", {}, "QuickStatements"),
      h("p", { class: "mode-line" },
        h("label", {}, h("input", { type: "checkbox", checked: true, onchange: (e) => { opts.removeNameStrings = e.target.checked; regenerate(); } }), " remove the matching author name string (P2093) when adding the author"),
        " · title language ", h("input", { type: "text", value: "en", size: 3, class: "lang", onchange: (e) => { opts.language = e.target.value.trim() || "en"; regenerate(); } })),
      textarea,
      h("div", { class: "actions" },
        h("button", { type: "button", class: "primary", onclick: () => window.open(quickStatementsUrl(textarea.value), "_blank", "noopener") }, "Open in QuickStatements"),
        h("button", { type: "button", onclick: async (e) => { try { await navigator.clipboard.writeText(textarea.value); e.target.textContent = "Copied"; } catch { textarea.select(); } } }, "Copy commands"),
        counter),
      h("p", { class: "muted small" }, "Statements cite the source of the metadata (Crossref, DataCite, OpenAlex or ORCID) with the DOI and today's date. Large batches are easier to run by copying the commands into QuickStatements than through the link. You run the edits under your own Wikimedia account; review them first.")).childNodes);
    regenerate();
  }
  return el;
}

// ---------- Improve Wikidata (ontology terms) ----------
const harvestContext = () => ({ engine, DF: DataFactory, fetch: window.fetch.bind(window), loadText, endpoint: endpoints[settings.endpoint].url, sources: config.sources, headers: {} });

async function termFixPanel(graph) {
  const run = async (file) => (await engine.queryBindings(fillPanel(await loadText("queries/prefixes.rq"), await loadText(file), graph.iri), { sources: [graph.store], unionDefaultGraph: true })).toArray();
  const fix = await gatherFixes(run, graph.iri, fetch, harvestContext());
  if (!fix.qid) return null;
  // The proposals come from the SPARQL copy, which lags: check the item live, so statements added minutes ago are
  // not proposed again and removals that were already done are dropped.
  const props = [fix.own, ...fix.additions, ...fix.facts, ...fix.removals].filter(Boolean).map((x) => x.property);
  if (props.length) {
    const held = await claimValuesLive(fetch, fix.qid, props).catch(() => null);
    if (held) {
      const has = (x) => held.get(x.property)?.has(String(x.value).toUpperCase());
      if (fix.own && has(fix.own)) fix.own = null;
      fix.additions = fix.additions.filter((x) => !has(x));
      fix.facts = fix.facts.filter((x) => !has(x));
    }
  }
  // Obsolete codes are deprecated, not removed: keep only those the item still holds with a non-deprecated rank.
  if (fix.removals.length) {
    const stmts = await statementsLive(fetch, fix.qid, fix.removals.map((r) => r.property)).catch(() => null);
    if (stmts) {
      for (const r of fix.removals) r.statements = (stmts.get(r.property) ?? []).filter((c) => String(statementValue(c)).toUpperCase() === String(r.value).toUpperCase() && c.rank !== "deprecated");
      fix.removals = fix.removals.filter((r) => r.statements.length);
    }
  }
  const proposals = [fix.own, ...fix.additions, ...fix.facts, ...fix.removals].filter(Boolean);
  if (!proposals.length && !fix.review.length) return null;

  const wdLink = (qid) => h("a", { href: `https://www.wikidata.org/wiki/${qid}`, target: "_blank", rel: "noopener" }, qid);
  const codeLink = (x) => h("a", { href: x.url, target: "_blank", rel: "noopener" }, x.code);
  const chosen = new Set([fix.own, ...fix.additions.filter((a) => !a.optional), ...fix.facts].filter(Boolean).map(fixKey)); // deprecations and broad/narrow mappings stay opt-in
  const textarea = h("textarea", { class: "qs", rows: 6, spellcheck: "false", "aria-label": "QuickStatements commands" });
  const deprecateBox = h("div", { class: "deprecate" });
  const regenerate = () => {
    textarea.value = buildFixCommands(fix, chosen);
    const edit = deprecationEdit(fix.qid, fix.removals.filter((r) => chosen.has(fixKey(r))), fix.label);
    deprecateBox.replaceChildren(...(edit ? [
      h("h3", {}, "Deprecate in Wikidata's API sandbox"),
      h("p", { class: "small" }, `QuickStatements can't change a statement's rank. The button opens Wikidata's API sandbox with an edit that sets ${edit.count === 1 ? "this statement" : `these ${edit.count} statements`} to deprecated, with reason for deprecated rank (P2241) “withdrawn identifier value” (Q21441764). Existing qualifiers and references are kept. Check the request, then press “Make request” while logged in to Wikidata.`),
      h("div", { class: "actions" },
        h("a", { class: "button primary", href: edit.url, target: "_blank", rel: "noopener" }, "Open in API sandbox"),
        h("button", { type: "button", onclick: async (e) => { try { await navigator.clipboard.writeText(edit.data); e.target.textContent = "Copied"; } catch {} } }, "Copy edit JSON")),
    ] : []));
  };
  const option = (x, text) => h("li", {}, h("label", {},
    h("input", { type: "checkbox", checked: chosen.has(fixKey(x)), onchange: (e) => { e.target.checked ? chosen.add(fixKey(x)) : chosen.delete(fixKey(x)); regenerate(); } }),
    " ", text));

  const body = h("div", { class: "panel-body" },
    h("p", {}, "Linked Wikidata item: ", wdLink(fix.qid),
      fix.matchedBy.length ? ` (matched through shared codes: ${fix.matchedBy.join(", ")}; it does not carry this term's own ID).` : "."),
    proposals.length ? [
      h("h3", {}, "Proposed edits"),
      h("ul", { class: "fixes" },
        fix.own && option(fix.own, [h("b", {}, "Add "), `${fix.own.vocabulary} ID `, codeLink(fix.own), ` (${fix.own.property}).`]),
        fix.additions.map((a) => { const by = a.by?.join(" and ") ?? fix.label; return option(a, [h("b", {}, "Add "), `${a.vocabulary} `, codeLink(a), ` (${a.property}): `,
          a.replaces ? `replaces the obsolete ${a.replaces}.` : a.mapping === "broad" ? `${by} maps to it as a broader code; added with mapping relation “broad match”.` : a.mapping === "narrow" ? `${by} maps to it as a narrower code; added with mapping relation “narrow match”.` : `${by} states it as an exact match.`]); }),
        fix.facts.map((f) => option(f, [h("b", {}, "Add "), `${f.vocabulary} `, h("a", { href: `https://www.wikidata.org/wiki/${f.value}`, target: "_blank", rel: "noopener" }, f.code), ` (${f.property} = ${f.value}), as stated by ${fix.label}.`])),
        fix.removals.map((r) => option(r, [h("b", {}, "Deprecate "), `${r.vocabulary} `, codeLink(r), ` (${r.property}): obsolete${r.status.from ? ` according to ${r.status.from}` : ` in ${fix.label}`}${r.status.label ? ` (“${r.status.label}”)` : ""}`, r.status.replacedBy ? [", replaced by ", h("a", { href: r.status.replacedBy, target: "_blank", rel: "noopener" }, r.status.replacedBy.split("/").pop())] : "", ". The statement stays on the item, marked deprecated with reason “withdrawn identifier value”. Unticked by default."]))),
      proposals.length > fix.removals.length ? [
        h("h3", {}, "QuickStatements"),
        textarea,
        h("div", { class: "actions" },
          h("button", { type: "button", class: "primary", onclick: () => window.open(quickStatementsUrl(textarea.value), "_blank", "noopener") }, "Open in QuickStatements"),
          h("button", { type: "button", onclick: async (e) => { try { await navigator.clipboard.writeText(textarea.value); e.target.textContent = "Copied"; } catch { textarea.select(); } } }, "Copy commands")),
      ] : null,
      deprecateBox,
      h("p", { class: "muted small" }, !fix.isTerm ? `${fix.anchors?.length ? `Additions come from the item's own ${fix.anchors.join(", ")} (read in EBI's Ontology Lookup Service) and cite that ontology. ` : ""}Codes were checked in OLS. You run the edits yourself under your own Wikimedia account; review them first.` : `Additions cite ${fix.label} (stated in, reference URL, retrieved) and mark codes with mapping relation type “exact match” (P4390). You run the edits in QuickStatements under your own Wikimedia account; review them first.`),
    ] : h("p", {}, fix.isTerm ? `Wikidata already has this term's ID and every code ${fix.label} states as an exact match.` : "No edits proposed."),
    fix.review.length ? [
      h("h3", {}, "Only on Wikidata (review; no edits proposed)"),
      h("ul", { class: "matches" }, fix.review.map((r) => h("li", {}, `${r.vocabulary} `, codeLink(r), ` · ${r.note}`))),
    ] : null);
  regenerate();
  return h("section", { class: "panel wide wd-create", id: "panel-improve-wikidata" },
    h("header", {}, h("h2", {}, "Improve Wikidata"), h("span", { class: "timing" }, proposals.length ? `${proposals.length} possible edits` : "In agreement")), body);
}

// ---------- Wikipedia coverage and subtypes (rare diseases) ----------
const WD_ENTITY = "http://www.wikidata.org/entity/";
const RDFS_SUBCLASS = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const SCHEMA_NAME = "http://schema.org/name";
const pageQid = (graph) => graph.iri.startsWith(WD_ENTITY) ? graph.iri.slice(WD_ENTITY.length)
  : graph.quads.find((q) => q.subject.value === graph.iri && q.predicate.value === "http://schema.org/sameAs" && /^http:\/\/www\.wikidata\.org\/entity\/Q\d+$/.test(q.object.value))?.object.value.slice(WD_ENTITY.length) ?? null;
const languages = () => config.wikipediaLanguages ?? DEFAULT_LANGUAGES;
let wpLang = store.get("wpLang", null);
const chosenLanguage = () => wpLang ?? languages()[0] ?? "en";
function languagePicker(onchange) {
  const sel = h("select", { "aria-label": "Wikipedia language", onchange: (e) => { wpLang = e.target.value; store.set("wpLang", wpLang); onchange(); } },
    languages().map((l) => h("option", { value: l, selected: l === chosenLanguage() }, `${languageName(l)} (${l})`)));
  return h("label", { class: "lang-pick" }, "Wikipedia: ", sel);
}

async function wikipediaPanel(graph) {
  const qid = pageQid(graph);
  if (!qid) return null;
  const links = (await sitelinksLive(fetch, [qid], chosenLanguage())).get(qid)?.links ?? new Map();
  const body = h("div", { class: "panel-body" });
  const status = h("span", { class: "timing" });
  const render = () => {
    const missing = languages().filter((l) => !links.has(l));
    status.textContent = `${links.size} language${links.size === 1 ? "" : "s"}`;
    body.replaceChildren(...h("div", {},
      links.size ? h("p", { class: "chips" }, [...links].sort(([a], [b]) => a.localeCompare(b)).map(([l, t]) => h("a", { class: "chip", href: articleUrl(l, t), target: "_blank", rel: "noopener", title: t }, l)))
        : h("p", { class: "warn" }, "No Wikipedia has an article on this disease yet."),
      missing.length ? [h("h3", {}, `Missing in ${missing.length} of your ${languages().length} languages`),
        h("ul", { class: "matches" }, missing.map((l) => {
          const cx = translateUrl(links, l);
          return h("li", {}, `${languageName(l)} (${l})`, cx ? [" · ", h("a", { href: cx, target: "_blank", rel: "noopener" }, `translate from ${languageName(sourceLanguage(links))}`)] : " · no article to translate from yet");
        }))] : h("p", {}, "There is an article in each of your languages."),
      h("p", { class: "muted small" }, "From the Wikidata item's sitelinks, read live. Languages are set in site.config.json (wikipediaLanguages). Translation opens Wikipedia's Content Translation tool under your own account.")).childNodes);
  };
  render();
  return h("section", { class: "panel", id: "panel-wikipedia" }, h("header", {}, h("h2", {}, "Wikipedia articles"), status), body);
}

async function subtypesPanel(graph) {
  const kids = new Map();
  for (const q of graph.quads) {
    if (q.predicate.value === RDFS_SUBCLASS && q.object.value === graph.iri) {
      const code = q.subject.value.match(/^http:\/\/www\.orpha\.net\/ORDO\/Orphanet_(\d+)$/)?.[1];
      if (code) kids.set(code, { code, iri: q.subject.value, label: null });
    }
  }
  for (const q of graph.quads) if (q.predicate.value === SCHEMA_NAME) { const c = q.subject.value.match(/Orphanet_(\d+)$/)?.[1]; if (c && kids.has(c) && !kids.get(c).label) kids.get(c).label = q.object.value; }
  if (!kids.size) return null;
  const parentQid = pageQid(graph);
  const status = h("span", { class: "timing" }, "Checking Wikidata…");
  const body = h("div", { class: "panel-body" }, h("p", { class: "loading" }, `Looking up ${kids.size} subtypes on Wikidata and Wikipedia…`));
  const el = h("section", { class: "panel wide wd-create", id: "panel-subtypes" }, h("header", {}, h("h2", {}, "Subtypes on Wikidata and Wikipedia"), status), body);
  (async () => {
    const qids = await itemsForOrphaCodes(engine, endpoints[settings.endpoint].url, fetch, [...kids.keys()]);
    const links = await sitelinksLive(fetch, [...qids.values()], chosenLanguage()).catch(() => new Map());
    const list = [...kids.values()].map((k) => ({ ...k, qid: qids.get(k.code) ?? null })).sort((a, b) => (a.label ?? "").localeCompare(b.label ?? ""));
    const notOnWikidata = list.filter((k) => !k.qid);
    // Before proposing a new item, look for the disorder under other identifiers and names: Orphanet's exact
    // mappings (OMIM, MONDO, UMLS, …), its label and synonyms. Only subtypes with no candidate at all are ticked;
    // for the others, adding the Orphanet ID to the existing item is offered instead.
    status.textContent = `Checking ${notOnWikidata.length} subtypes for existing items…`;
    let next = 0;
    const worker = async () => { while (next < notOnWikidata.length) { const k = notOnWikidata[next++]; k.dups = await duplicateCandidates(fetch, k).catch(() => ({ byId: [], byName: [], synonyms: [] })); } };
    await Promise.all(Array.from({ length: Math.min(4, notOnWikidata.length) }, worker));
    const chosen = new Set(notOnWikidata.filter((k) => !k.dups.byId.length && !k.dups.byName.length).map((k) => k.code));
    const linkTo = new Map(); // code -> qid to add the Orphanet ID to
    for (const k of notOnWikidata) { const c = k.dups.byId.find((c) => !c.orphanet.length); if (c) linkTo.set(k.code, c.qid); }
    const textarea = h("textarea", { class: "qs", rows: 8, spellcheck: "false", "aria-label": "QuickStatements commands" });
    const regenerate = () => {
      textarea.value = [addOrphanetIds([...linkTo].map(([code, qid]) => ({ code, qid }))), createDiseaseItems(notOnWikidata.filter((k) => chosen.has(k.code) && !linkTo.has(k.code)), { parentQid })].filter(Boolean).join("\n");
    };
    const wd = (c) => h("a", { href: `https://www.wikidata.org/wiki/${c.qid}`, target: "_blank", rel: "noopener" }, `${c.label ?? c.qid} (${c.qid})`);
    const radio = (k, value, checked, text) => h("label", { class: "choice" }, h("input", { type: "radio", name: `dup-${k.code}`, checked, onchange: () => {
      linkTo.delete(k.code); chosen.delete(k.code);
      if (value === "create") chosen.add(k.code); else if (value !== "skip") linkTo.set(k.code, value);
      regenerate();
    } }), " ", text);
    const subtypeChoice = (k) => {
      const { byId, byName } = k.dups;
      const searchLink = h("a", { href: `https://www.wikidata.org/w/index.php?${new URLSearchParams({ search: k.label ?? k.code })}`, target: "_blank", rel: "noopener" }, "search Wikidata yourself");
      const cands = [...byId.map((c) => ({ ...c, why: `shares ${c.shared.join(", ")}` })), ...byName.map((c) => ({ ...c, why: `name match on “${c.matched}”` }))];
      const head = [h("b", {}, k.label ?? k.code), h("span", { class: "muted" }, ` ORPHA:${k.code}`)];
      if (!cands.length) return h("li", {}, ...head, h("div", { class: "choices" },
        radio(k, "create", true, "create a new item"), radio(k, "skip", false, "skip"),
        h("span", { class: "muted small" }, " No item found by Orphanet ID, mapped codes, name or synonyms. "), searchLink));
      return h("li", { class: "dup" }, ...head, h("div", { class: "choices" },
        cands.map((c) => radio(k, c.qid, linkTo.get(k.code) === c.qid, ["add Orphanet ID to ", wd(c), c.description ? ` · ${c.description}` : "", ` · ${c.why}`,
          c.orphanet.length ? h("span", { class: "check-obsolete" }, ` · already has Orphanet ID ${c.orphanet.join(", ")}`) : ""])),
        radio(k, "create", false, "none of these: create a new item"), radio(k, "skip", !linkTo.has(k.code), "skip"), " ", searchLink));
    };
    const render = () => {
      const lang = chosenLanguage();
      const withArticle = list.filter((k) => k.qid && links.get(k.qid)?.links.has(lang)).length;
      status.textContent = `${list.length - notOnWikidata.length}/${list.length} on Wikidata · ${withArticle} with ${lang} article`;
      const rows = list.map((k) => {
        const l = k.qid ? links.get(k.qid)?.links ?? new Map() : new Map();
        const cx = l.has(lang) ? null : translateUrl(l, lang);
        return h("tr", {},
          h("td", {}, h("a", { href: `#/term/obo:Orphanet_${k.code}` }, k.label ?? `ORPHA:${k.code}`)),
          h("td", {}, k.qid ? h("a", { href: `https://www.wikidata.org/wiki/${k.qid}`, target: "_blank", rel: "noopener" }, k.qid) : h("span", { class: "check-not-found" }, "not on Wikidata")),
          h("td", { class: "num" }, String(l.size)),
          h("td", {}, l.has(lang) ? h("a", { href: articleUrl(lang, l.get(lang)), target: "_blank", rel: "noopener" }, l.get(lang))
            : cx ? h("a", { href: cx, target: "_blank", rel: "noopener", class: "check-obsolete" }, `missing · translate from ${sourceLanguage(l)}`) : h("span", { class: "check-not-found" }, "missing")));
      });
      body.replaceChildren(...h("div", {},
        h("p", { class: "mode-line" }, languagePicker(() => render()), " ", h("span", { class: "muted" }, "Subtypes are Orphanet's classification children; articles are read live from Wikidata's sitelinks.")),
        h("div", { class: list.length > 12 ? "scroll" : null }, h("table", {}, h("thead", {}, h("tr", {}, ["subtype", "Wikidata", "Wikipedias", `${lang} article`].map((c) => h("th", {}, c)))), h("tbody", {}, rows))),
        notOnWikidata.length ? [
          h("h3", {}, `${notOnWikidata.length} subtype${notOnWikidata.length === 1 ? "" : "s"} without an item carrying the Orphanet ID`),
          h("p", {}, "Each was looked up on Wikidata by the codes Orphanet maps it to (exactly), by name and by Orphanet's synonyms. Where an item turned up, the default is to add the Orphanet ID to it (when it shares a code and has no other Orphanet ID) or to skip; a new item is proposed only when nothing was found."),
          h("ul", { class: "fixes dups" }, notOnWikidata.map(subtypeChoice)),
          textarea,
          h("div", { class: "actions" },
            h("button", { type: "button", class: "primary", onclick: () => window.open(quickStatementsUrl(textarea.value), "_blank", "noopener") }, "Open in QuickStatements"),
            h("button", { type: "button", onclick: async (e) => { try { await navigator.clipboard.writeText(textarea.value); e.target.textContent = "Copied"; } catch { textarea.select(); } } }, "Copy commands")),
          h("p", { class: "muted small" }, `Adding to an existing item adds the Orphanet ID (P1550) citing Orphanet. Each new item gets the Orphanet name as label, “rare disease” as description, instance of “type of disease” (Q112193867), its Orphanet ID (P1550)${parentQid ? ` and subclass of ${parentQid} (P279)` : ""}, all citing Orphanet. Name matches are suggestions: check them before choosing. You run the edits under your own Wikimedia account.`),
        ] : null).childNodes);
      regenerate();
    };
    render();
  })().catch((err) => { status.textContent = "Error"; body.replaceChildren(h("p", { class: "error" }, String(err.message ?? err))); });
  return el;
}

// ---------- pages ----------
let routeId = 0;
async function entityPage(aspectHint, rawKey) {
  const myRoute = routeId;
  const key = parseKey(rawKey);
  if (!key) return notFound(`"${rawKey}" is not an ORCID, DOI, PMID, ISSN, Wikidata QID or ontology term ID.`);
  const progress = h("ol", { class: "progress" });
  const steps = new Map();
  const onProgress = (p) => {
    const id = `${p.source}|${p.what}`;
    const li = steps.get(id) ?? progress.appendChild(h("li"));
    steps.set(id, li);
    li.className = p.state;
    li.replaceChildren(h("span", { class: `badge src-${p.source}` }, p.source), ` ${p.what} `,
      p.state === "done" ? h("span", { class: "muted" }, `${p.quads} quads`) : p.state === "error" ? h("span", { class: "error" }, p.error.slice(0, 160)) : h("span", { class: "muted" }, "…"));
  };
  main.replaceChildren(h("div", { class: "loading-page" }, h("h1", {}, keyString(key)), h("p", { class: "muted" }, "Gathering the graph…"), progress));

  let graph;
  try { graph = await loadGraph(key, aspectHint, onProgress); }
  catch (err) { return notFound(String(err.message ?? err)); }
  if (myRoute !== routeId) return; // navigated away meanwhile

  const aspect = graph.aspect;
  const prefixes = await loadText("queries/prefixes.rq");
  const head = await (await engine.queryBindings(fillPanel(prefixes, await loadText("queries/common/header.rq"), graph.iri), { sources: [graph.store], unionDefaultGraph: true })).toArray();
  const name = head[0]?.get("name")?.value || keyString(key);
  const description = head[0]?.get("description")?.value;
  document.title = `${name} · ${config.title}`;

  const log = h("ul", { class: "log" }, graph.log.map((l) => h("li", {},
    h("span", { class: `badge src-${l.source}` }, l.source), ` ${l.what} `,
    l.error ? h("span", { class: "error" }, l.error.slice(0, 200)) : h("span", { class: "muted" }, `${l.quads} quads · ${l.ms} ms`))));

  const panels = panelsFor(config, aspect);
  const grid = h("div", { class: "grid" });
  main.replaceChildren(
    h("article", { class: "entity" },
      h("div", { class: "entity-head" },
        h("span", { class: "aspect" }, ASPECTS[aspect].title),
        h("h1", {}, name),
        description && h("p", { class: "description" }, description),
        h("div", { class: "meta" },
          h("span", { class: graph.snapshot ? "mode snap" : "mode live" }, graph.snapshot ? "Static snapshot" : "Live harvest"),
          h("span", { class: "muted" }, `${graph.quads.length.toLocaleString()} quads · canonical IRI `), h("code", {}, graph.iri),
          h("button", { type: "button", onclick: () => downloadGraph(graph) }, "Download graph (N-Quads)"),
          graph.snapshot && settings.mode !== "live" && h("button", { type: "button", onclick: () => { settings.mode = "live"; $("#mode").value = "live"; store.set("mode", "live"); graphs.clear(); route(); } }, "Fetch live instead"),
          !graph.snapshot && h("button", { type: "button", title: "Harvest this page again from all sources", onclick: () => { graphs.clear(); route(); } }, "Refresh")),
        h("details", { class: "provenance" }, h("summary", {}, "How this graph was gathered"), log)),
      grid));
  for (const p of panels) {
    const el = panelShell(p);
    grid.append(el);
    runPanel(graph, p, el);
  }
  if (aspect === "author" && config.wikidataCreate && config.sources.includes("wikidata"))
    wikidataPanel(graph).then((el) => { if (el && myRoute === routeId) grid.prepend(el); }).catch((err) => console.warn("Add-to-Wikidata panel:", err));
    profilePanel(graph).then((el) => { if (el && myRoute === routeId) grid.prepend(el); }).catch((err) => console.warn("Profiles panel:", err));
  if (aspect === "author" && config.wikidataWorks && config.sources.includes("wikidata"))
    missingWorksPanel(graph).then((el) => {
      if (!el || myRoute !== routeId) return;
      const after = grid.querySelector("#panel-works");
      after ? after.after(el) : grid.append(el);
    }).catch((err) => console.warn("Missing-works panel:", err));
  if ((aspect === "term" || aspect === "topic") && config.wikipediaCoverage !== false && config.sources.includes("wikidata")) {
    wikipediaPanel(graph).then((el) => { if (el && myRoute === routeId) { const after = grid.querySelector("#panel-details"); after ? after.after(el) : grid.prepend(el); } }).catch((err) => console.warn("Wikipedia panel:", err));
    subtypesPanel(graph).then((el) => { if (el && myRoute === routeId) { const after = grid.querySelector("#panel-children"); after ? after.after(el) : grid.append(el); } }).catch((err) => console.warn("Subtypes panel:", err));
  }
  if ((aspect === "term" || aspect === "topic") && config.wikidataFixes && config.sources.includes("wikidata"))
    termFixPanel(graph).then((el) => {
      if (!el || myRoute !== routeId) return;
      const after = grid.querySelector(aspect === "term" ? "#panel-agreement" : "#panel-mappings");
      after ? after.after(el) : grid.prepend(el);
    }).catch((err) => console.warn("Improve-Wikidata panel:", err));
}

async function home() {
  document.title = config.title;
  const m = await getManifest();
  const byAspect = {};
  for (const [k, e] of Object.entries(m.entities)) (byAspect[e.aspect] ??= []).push([k, e]);
  main.replaceChildren(h("section", { class: "home" },
    h("h1", {}, config.tagline),
    config.intro && h("p", { class: "lede" }, config.intro),
    h("p", {}, config.liveHarvest ? "Search above, or paste an Orphanet code (e.g. ORPHA:558), an ontology term ID (e.g. MONDO:0007947), a Wikidata QID, ORCID, DOI or PMID." : "This site shows the pre-built pages below."),
    h("h2", {}, "Featured"),
    Object.keys(byAspect).length ? h("div", { class: "snapshots" }, Object.entries(byAspect).map(([a, list]) => h("div", {},
      h("h3", {}, ASPECTS[a]?.title ?? a),
      h("ul", {}, list.map(([k, e]) => h("li", {}, h("a", { href: `#/${a}/${k}` }, e.name ?? k), h("span", { class: "muted" }, ` ${k} · ${e.quads.toLocaleString()} quads`))))))) : h("p", { class: "muted" }, "None yet. Run npm run snapshot."),
    m.generated && h("p", { class: "muted" }, `Snapshots generated ${m.generated.slice(0, 16).replace("T", " ")} UTC.`)));
}

function notFound(msg) {
  main.replaceChildren(h("section", { class: "home" }, h("h1", {}, "Can't show that"), h("p", { class: "error" }, msg), h("p", {}, h("a", { href: "#/" }, "Back to the start"))));
}

function route() {
  routeId++;
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  window.scrollTo(0, 0);
  if (!parts.length) return home();
  if (ASPECTS[parts[0]]) return entityPage(parts[0], decodeURIComponent(parts.slice(1).join("/")));
  return entityPage(null, decodeURIComponent(parts.join("/")));
}
window.addEventListener("hashchange", route);
route();

// ---------- search ----------
const input = $("#q"), suggest = $("#suggest");
let timer;
$("#search").addEventListener("submit", (e) => {
  e.preventDefault();
  const key = parseKey(input.value);
  if (key) { location.hash = `#/${keyString(key)}`; suggest.hidden = true; }
  else suggest.querySelector("a")?.click();
});
input.addEventListener("input", () => {
  clearTimeout(timer);
  const term = input.value.trim();
  if (term.length < 3 || parseKey(term)) { suggest.hidden = true; return; }
  timer = setTimeout(async () => {
    // Name search: Wikidata's search API, plus ontology terms from OLS when the OBO source is on.
    const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&origin=*&language=en&uselang=en&limit=8&search=${encodeURIComponent(term)}`;
    const [res, terms] = await Promise.all([
      fetch(url).then((r) => r.json()).catch(() => null),
      config.sources.includes("obo") ? searchObo(fetch, term, 5, config.searchOntologies).catch(() => []) : [],
    ]);
    if (input.value.trim() !== term) return;
    const pick = () => { suggest.hidden = true; input.value = ""; };
    const hits = [
      ...(res?.search ?? []).map((s) => h("li", {}, h("a", { href: `#/wikidata:${s.id}`, onclick: pick }, h("b", {}, s.label ?? s.id), s.description ? ` · ${s.description}` : ""))),
      ...terms.map((t) => h("li", { class: "obo-hit" }, h("a", { href: `#/term/obo:${t.id}`, onclick: pick }, h("b", {}, t.label), ` · ${t.oboId} `, h("span", { class: "badge src-obo" }, t.ontology)))),
    ];
    suggest.replaceChildren(...hits);
    suggest.hidden = !hits.length;
  }, 250);
});
document.addEventListener("click", (e) => { if (!e.target.closest("#search")) suggest.hidden = true; });
