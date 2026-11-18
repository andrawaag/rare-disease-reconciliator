// Wikipedia coverage of rare diseases, and Wikidata items for Orphanet disorders that don't have one yet.
//   - Which Wikipedias have an article on a disease (Wikidata sitelinks, read live), and in which of the visitor's
//     languages it is missing, with a link to translate it (Content Translation) from the best existing article.
//   - For an Orphanet group or disorder: its subtypes, whether each is on Wikidata, and whether it has an article
//     in the chosen language. Subtypes without an item can be created with QuickStatements (run by the visitor).
import { findByStatementsLive } from "./wikidata-live.js";
import { target as vocabTarget, canonicalPrefix, VOCABS } from "./vocab.js";

const API = "https://www.wikidata.org/w/api.php";
// Wikipedias that are not language editions (all other "<code>wiki" sites are).
const NOT_WIKIPEDIA = new Set(["commonswiki", "specieswiki", "wikidatawiki", "metawiki", "mediawikiwiki", "sourceswiki", "wikimaniawiki", "outreachwiki", "foundationwiki", "wikifunctionswiki", "incubatorwiki"]);
export const DEFAULT_LANGUAGES = ["en", "de", "fr", "es", "it", "nl", "pt", "pl", "ru", "ja", "zh", "ar"];
const LANG_NAMES = (() => { try { return new Intl.DisplayNames(["en"], { type: "language" }); } catch { return null; } })();
export const languageName = (code) => { try { return LANG_NAMES?.of(code.replace(/_/g, "-")) ?? code; } catch { return code; } };

async function api(fetchFn, params) {
  const res = await fetchFn(`${API}?${new URLSearchParams({ format: "json", origin: "*", ...params })}`);
  if (!res.ok) throw new Error(`Wikidata API HTTP ${res.status}`);
  return res.json();
}

/** Map qid -> { label, links: Map(language -> article title) }, read live (50 items per request). */
export async function sitelinksLive(fetchFn, qids, language = "en") {
  const out = new Map();
  const ids = [...new Set(qids)];
  for (let i = 0; i < ids.length; i += 50) {
    const res = await api(fetchFn, { action: "wbgetentities", ids: ids.slice(i, i + 50).join("|"), props: "sitelinks|labels", languages: `${language}|en`, languagefallback: "1" });
    for (const [qid, e] of Object.entries(res?.entities ?? {})) {
      const links = new Map();
      for (const [site, s] of Object.entries(e.sitelinks ?? {})) {
        if (!site.endsWith("wiki") || NOT_WIKIPEDIA.has(site)) continue;
        links.set(site.slice(0, -4).replace(/_/g, "-"), s.title);
      }
      out.set(qid, { label: e.labels?.[language]?.value ?? e.labels?.en?.value ?? null, links });
    }
  }
  return out;
}

export const articleUrl = (lang, title) => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;

/** Content Translation: start the `to` article from an existing one. The best source is English, else the first one. */
export function translateUrl(links, to) {
  const from = links.has("en") ? "en" : [...links.keys()][0];
  if (!from) return null;
  return `https://${to}.wikipedia.org/wiki/Special:ContentTranslation?${new URLSearchParams({ page: links.get(from), from, to })}`;
}
export const sourceLanguage = (links) => (links.has("en") ? "en" : [...links.keys()][0] ?? null);

/** Wikidata items for Orphanet codes ("558"): Map code -> qid. SPARQL first, then Wikidata's live search for the rest. */
export async function itemsForOrphaCodes(engine, endpoint, fetchFn, codes) {
  const out = new Map();
  const list = [...new Set(codes)];
  for (let i = 0; i < list.length; i += 200) {
    const values = list.slice(i, i + 200).map((c) => JSON.stringify(c)).join(" ");
    const q = `PREFIX wdt: <http://www.wikidata.org/prop/direct/> SELECT ?item ?code WHERE { VALUES ?code { ${values} } ?item wdt:P1550 ?code }`;
    const rows = await engine.queryBindings(q, { sources: [{ type: "sparql", value: endpoint }], httpTimeout: 60000 }).then((r) => r.toArray()).catch(() => []);
    for (const r of rows) if (!out.has(r.get("code").value)) out.set(r.get("code").value, r.get("item").value.split("/").pop());
  }
  const rest = list.filter((c) => !out.has(c));
  if (rest.length) for (const hit of await findByStatementsLive(fetchFn, rest.map((c) => ({ property: "P1550", value: c }))).catch(() => [])) if (!out.has(hit.value)) out.set(hit.value, hit.qid);
  return out;
}

const clean = (s) => String(s).replace(/["\t\n\r|]/g, " ").trim();
const TYPE_OF_DISEASE = "Q112193867"; // what most Wikidata items with an Orphanet ID are an instance of
const ORPHANET = "Q1515833";

/**
 * QuickStatements V1 creating items for Orphanet disorders: label, description, instance of "type of disease",
 * Orphanet ID and, when the parent is on Wikidata, subclass of the parent. Every statement cites Orphanet.
 */
export function createDiseaseItems(disorders, { parentQid = null, language = "en", today = new Date().toISOString().slice(0, 10) } = {}) {
  const lines = [];
  for (const d of disorders) {
    const ref = `S248\t${ORPHANET}\tS854\t"https://www.orpha.net/en/disease/detail/${clean(d.code)}"\tS813\t+${today}T00:00:00Z/11`;
    lines.push("CREATE");
    lines.push(`LAST\tL${language}\t"${clean(d.label)}"`);
    if (language === "en") lines.push(`LAST\tDen\t"rare disease"`);
    lines.push(`LAST\tP31\t${TYPE_OF_DISEASE}\t${ref}`);
    lines.push(`LAST\tP1550\t"${clean(d.code)}"\t${ref}`);
    if (parentQid) lines.push(`LAST\tP279\t${parentQid}\t${ref}`);
  }
  return lines.join("\n");
}

// ---------- duplicate checks before creating items ----------
const OLS_V2 = "https://www.ebi.ac.uk/ols4/api/v2/ontologies/ordo/entities/";
const enc2 = (s) => encodeURIComponent(encodeURIComponent(s));
// Search hits that are not diseases: scholarly works and people.
const NOT_A_DISEASE = /scientific article|scholarly|journal|thesis|book|preprint|conference|patent|clinical trial|Wikimedia|family name|given name|researcher|physician|scientist|gene\b|protein/i;

/** Orphanet's synonyms and cross-references (with Orphanet's mapping type) for one code. */
export async function orphanetTermInfo(fetchFn, code) {
  const res = await fetchFn(OLS_V2 + enc2(`http://www.orpha.net/ORDO/Orphanet_${code}`));
  if (!res.ok) throw new Error(`OLS HTTP ${res.status}`);
  const t = await res.json();
  const synonyms = [].concat(t.synonym ?? []).map((s) => (typeof s === "object" ? s.value : s)).filter((s) => typeof s === "string");
  const xrefs = [];
  for (const x of t["http://www.geneontology.org/formats/oboInOwl#hasDbXref"] ?? []) {
    const value = typeof x === "object" ? x.value : x;
    if (typeof value !== "string" || !value.includes(":")) continue;
    const note = (x.axioms ?? []).map((a) => a["http://purl.obolibrary.org/obo/ECO_0000218"]).join(" ");
    const [prefix, ...rest] = value.split(":");
    xrefs.push({ prefix, id: rest.join(":"), exact: /\bE \(Exact/.test(note), wrong: /\bW \(/.test(note) });
  }
  return { synonyms, xrefs };
}

/**
 * Wikidata items that may already describe an Orphanet disorder that has no item with its Orphanet ID:
 *   byId:   items holding a code Orphanet maps the disorder to exactly (OMIM, MONDO, MeSH, ICD-10, UMLS, GARD, …);
 *   byName: items whose label or alias matches the disorder's name or one of its synonyms (Wikidata's entity search),
 *           plus full-text hits, leaving out scholarly works and people.
 * Each candidate carries the Orphanet IDs it already has, if any.
 */
export async function duplicateCandidates(fetchFn, { code, label }) {
  const info = await orphanetTermInfo(fetchFn, code).catch(() => ({ synonyms: [], xrefs: [] }));
  const pairs = [];
  for (const x of info.xrefs) {
    if (!x.exact || x.wrong) continue;
    const canon = canonicalPrefix(x.prefix);
    const v = canon && VOCABS[canon];
    if (!v?.wd || canon === "ORPHANET") continue;
    const local = vocabTarget(x.prefix, x.id)?.code ?? x.id;
    for (const value of v.wdForms ? v.wdForms(local) : [local]) pairs.push({ property: v.wd, value, vocabulary: v.label });
  }
  const byId = new Map();
  for (const hit of pairs.length ? await findByStatementsLive(fetchFn, pairs).catch(() => []) : []) {
    const p = pairs.find((x) => x.property === hit.property && x.value.toUpperCase() === String(hit.value).toUpperCase());
    const c = byId.get(hit.qid) ?? byId.set(hit.qid, { qid: hit.qid, label: hit.label, shared: [] }).get(hit.qid);
    c.shared.push(`${p?.vocabulary ?? hit.property} ${hit.value}`);
  }

  const names = [...new Set([label, ...info.synonyms].filter(Boolean))].slice(0, 6);
  const byName = new Map();
  for (const name of names) {
    const res = await api(fetchFn, { action: "wbsearchentities", search: name, language: "en", type: "item", limit: "5" }).catch(() => null);
    for (const s of res?.search ?? []) {
      if (byId.has(s.id) || NOT_A_DISEASE.test(s.description ?? "")) continue;
      if (!byName.has(s.id)) byName.set(s.id, { qid: s.id, label: s.label, description: s.description ?? "", matched: name });
    }
  }
  // Full-text search finds names that are not a prefix of a label or alias; scholarly articles and people are excluded.
  const text = await api(fetchFn, { action: "query", list: "search", srsearch: `${label.replace(/["|]/g, " ")} -haswbstatement:P31=Q13442814 -haswbstatement:P31=Q5`, srlimit: "5", srprop: "" }).catch(() => null);
  const fulltext = (text?.query?.search ?? []).map((s) => s.title).filter((q) => /^Q\d+$/.test(q) && !byId.has(q) && !byName.has(q));
  if (fulltext.length) {
    const res = await api(fetchFn, { action: "wbgetentities", ids: fulltext.join("|"), props: "labels|descriptions", languages: "en" }).catch(() => null);
    for (const q of fulltext) {
      const e = res?.entities?.[q];
      const description = e?.descriptions?.en?.value ?? "";
      if (!e || NOT_A_DISEASE.test(description)) continue;
      byName.set(q, { qid: q, label: e.labels?.en?.value ?? q, description, matched: "full-text search" });
    }
  }
  // Orphanet IDs the candidates already hold: an item for a different Orphanet code is a weaker match.
  const all = [...byId.values(), ...byName.values()];
  if (all.length) {
    const res = await api(fetchFn, { action: "wbgetentities", ids: all.map((c) => c.qid).slice(0, 50).join("|"), props: "claims|descriptions", languages: "en" }).catch(() => null);
    for (const c of all) {
      const e = res?.entities?.[c.qid];
      c.orphanet = (e?.claims?.P1550 ?? []).map((x) => x.mainsnak?.datavalue?.value).filter(Boolean);
      c.description ??= e?.descriptions?.en?.value ?? "";
    }
  }
  return { byId: [...byId.values()], byName: [...byName.values()], synonyms: info.synonyms };
}

/** QuickStatements adding an Orphanet ID to existing items, instead of creating new ones: [{ qid, code }]. */
export function addOrphanetIds(links, { today = new Date().toISOString().slice(0, 10) } = {}) {
  return links.map(({ qid, code }) => `${qid}\tP1550\t"${clean(code)}"\tS248\t${ORPHANET}\tS854\t"https://www.orpha.net/en/disease/detail/${clean(code)}"\tS813\t+${today}T00:00:00Z/11`).join("\n");
}
