// Gathers everything koetai-reconciliator knows about one entity from all sources and returns one merged RDF graph.
// Runs unchanged in the browser (live mode) and in Node (the snapshot GitHub Action).
// ctx = { engine (Comunica), DF (RDF/JS DataFactory), fetch, loadText(path), endpoint, headers,
//         sources? (names to use; default all), openalexKey? (Node only) }
import { NS, iri, keyToIri, keyString, aspectForKey, graphFor, SOURCES } from "./model.js";
import { parseTargetIri, SKOS, OBOINOWL } from "./vocab.js";
import { lookupQid, lookupOboQid, matchQidByCodes, detectAspect, harvestWikidata } from "./adapters/wikidata.js";
import { harvestObo } from "./adapters/obo.js";
import { checkConceptsOls } from "./adapters/ols.js";
import { harvestTogoid, checkNando, togoidIri } from "./adapters/rdfportal.js";
import { harvestPubmedWork, harvestPubmedForDois, doiForPmid } from "./adapters/pubmed.js";
import { findByStatementsLive } from "./wikidata-live.js";
import { wikidataFormsForObo } from "./vocab.js";
import { harvestOrcid } from "./adapters/orcid.js";
import { harvestCrossref } from "./adapters/crossref.js";
import { harvestDatacite } from "./adapters/datacite.js";
import { harvestOpenalex, resolveOpenalex } from "./adapters/openalex.js";
import { reconcile } from "./reconcile.js";

export async function harvest(ctx, key, aspectHint, onProgress = () => {}) {
  const enabled = new Set(ctx.sources ?? SOURCES);
  const on = (s) => enabled.has(s);
  const ids = { [key.scheme]: key.value };
  const log = [];
  const quads = [];
  const step = async (source, what, fn) => {
    const t0 = Date.now();
    onProgress({ source, what, state: "running" });
    try {
      const got = await fn();
      const list = Array.isArray(got) ? got : got?.quads ?? [];
      for (const q of list) quads.push(q); // not push(...list): large lists overflow the call stack
      log.push({ source, what, quads: list.length, ms: Date.now() - t0 });
      onProgress({ source, what, state: "done", quads: list.length });
      return got;
    } catch (err) {
      log.push({ source, what, error: String(err.message ?? err), ms: Date.now() - t0 });
      onProgress({ source, what, state: "error", error: String(err.message ?? err) });
      return null;
    }
  };
  const fill = (more) => { for (const [k, v] of Object.entries(more ?? {})) if (v && !ids[k]) ids[k] = v; };

  // 1. Cross-identifiers. OpenAlex ids are resolved via OpenAlex; everything else is looked up on Wikidata.
  if (key.scheme === "openalex" && on("openalex")) fill(await resolveOpenalex(ctx, key.value).catch(() => null));
  if (key.scheme === "pmid" && on("pubmed")) fill({ doi: await doiForPmid(ctx, key.value).catch(() => null) });
  if (!ids.wikidata && on("wikidata")) {
    for (const scheme of ["orcid", "doi", "pmid", "issn", "openalex"]) {
      if (!ids[scheme]) continue;
      ids.wikidata = await lookupQid(ctx, scheme, ids[scheme]).catch(() => null);
      if (ids.wikidata) break;
    }
    if (!ids.wikidata && ids.obo) ids.wikidata = await lookupOboQid(ctx, ids.obo).catch(() => null);
    // The SPARQL copy can lag behind Wikidata by hours or days: ask Wikidata's own search for items created since.
    if (!ids.wikidata) {
      const pairs = [];
      if (ids.orcid) pairs.push({ property: "P496", value: ids.orcid });
      if (ids.doi) pairs.push({ property: "P356", value: ids.doi.toUpperCase() });
      if (ids.pmid) pairs.push({ property: "P698", value: ids.pmid });
      if (ids.issn) pairs.push({ property: "P236", value: ids.issn });
      if (ids.openalex) pairs.push({ property: "P10283", value: ids.openalex });
      const forms = ids.obo && wikidataFormsForObo(ids.obo);
      if (forms) for (const value of forms.values) pairs.push({ property: forms.property, value });
      const hit = pairs.length ? (await findByStatementsLive(ctx.fetch, pairs).catch(() => []))[0] : null;
      if (hit) {
        ids.wikidata = hit.qid;
        log.push({ source: "wikidata", what: `${hit.qid} found by live search (${hit.property} ${hit.value}); not yet in the SPARQL copy`, quads: 0, ms: 0 });
      }
    }
  }
  const aspect = aspectHint || aspectForKey(key)
    || (ids.wikidata && on("wikidata") ? await detectAspect(ctx, ids.wikidata).catch(() => "topic") : "topic");

  // 1b. Ontology terms: fetch the term first. If its own ID is not on Wikidata, match an item through the term's
  // exact cross-references (DOID, MeSH, SNOMED CT, …) and record how, so the page can show the match and any mismatch.
  if (aspect === "term" && ids.obo && on("obo")) {
    const before = quads.length;
    await step("obo", "term, hierarchy and cross-references (OLS)", () => harvestObo(ctx, ids.obo));
    if (!ids.wikidata && on("wikidata")) {
      const codes = exactCodes(quads.slice(before), iri.obo(ids.obo));
      const match = await matchQidByCodes(ctx, codes).catch(() => null);
      if (match) {
        ids.wikidata = match.qid;
        const g = ctx.DF.namedNode(graphFor("reconcile"));
        const me = ctx.DF.namedNode(iri.obo(ids.obo)), wd = ctx.DF.namedNode(iri.wikidata(match.qid));
        quads.push(ctx.DF.quad(me, ctx.DF.namedNode(NS.schema + "sameAs"), wd, g));
        for (const m of match.matched) quads.push(ctx.DF.quad(me, ctx.DF.namedNode(NS.kr + "wikidataMatchedBy"), ctx.DF.literal(m), g));
        log.push({ source: "reconcile", what: `Wikidata ${match.qid} matched by ${match.matched.join(", ")}`, quads: 1 + match.matched.length, ms: 0 });
      }
    }
  }

  // 2. Wikidata, the hub for topics and for further identifiers.
  if (ids.wikidata && on("wikidata")) await step("wikidata", `${aspect} neighbourhood`, () => harvestWikidata(ctx, ids.wikidata, aspect, { obo: ids.obo }));
  const me = iri.wikidata(ids.wikidata ?? "");
  for (const q of quads) {
    if (q.subject.value !== me || q.predicate.value !== NS.schema + "sameAs") continue;
    const v = q.object.value;
    if (v.startsWith("https://orcid.org/")) fill({ orcid: v.slice(18) });
    if (v.startsWith("https://doi.org/")) fill({ doi: v.slice(16) });
    if (v.startsWith("urn:issn:")) fill({ issn: v.slice(9) });
    if (v.startsWith("https://openalex.org/")) fill({ openalex: v.slice(21) });
  }
  if (ids.openalex && ids.openalex[0] !== { author: "A", work: "W", venue: "S", topic: "T" }[aspect] && !(aspect === "topic" && ids.openalex[0] === "C")) delete ids.openalex;

  // 2a. RDF Portal: TogoID's ID links for the term, a third view on its mappings next to the ontology's and Wikidata's.
  if (aspect === "term" && ids.obo && on("rdfportal")) await step("rdfportal", "TogoID links and ClinVar variants", () => harvestTogoid(ctx, iri.obo(ids.obo), togoidIri(ids.obo)));

  // 2b. Check every code the page maps to: in EBI's OLS, and NANDO codes (not in OLS) in RDF Portal.
  if (aspect === "term" || aspect === "topic") {
    const own = ids.obo ? iri.obo(ids.obo) : null;
    const MAP = new Set(["exactMatch", "closeMatch", "broadMatch", "narrowMatch"].map((p) => SKOS + p).concat(OBOINOWL + "hasDbXref"));
    const codes = [...new Set(quads.filter((q) => MAP.has(q.predicate.value) && q.object.value !== own).map((q) => q.object.value))];
    const nando = codes.filter((c) => c.startsWith("http://nanbyodata.jp/ontology/NANDO_"));
    await Promise.all([
      codes.length && on("ols") ? step("ols", "codes checked in OLS", () => checkConceptsOls(ctx, codes)) : null,
      nando.length && on("rdfportal") ? step("rdfportal", "NANDO codes checked", () => checkNando(ctx, nando)) : null,
    ]);
  }

  // 3. Source-specific enrichment; independent hosts, so in parallel.
  const jobs = [];
  if (aspect === "author" && ids.orcid) {
    if (on("orcid")) jobs.push(step("orcid", "record and works", () => harvestOrcid(ctx, ids.orcid)));
    if (on("crossref")) jobs.push(step("crossref", "works with this ORCID", () => harvestCrossref(ctx, { orcid: ids.orcid })));
    if (on("datacite")) jobs.push(step("datacite", "works with this ORCID", () => harvestDatacite(ctx, { orcid: ids.orcid })));
  }
  if (aspect === "author" && (ids.orcid || ids.openalex) && on("openalex")) jobs.push(step("openalex", "works by this author", () => harvestOpenalex(ctx, aspect, ids)));
  if (aspect === "work" && ids.doi) {
    if (on("crossref")) jobs.push(step("crossref", "work and references", () => harvestCrossref(ctx, { dois: [ids.doi], references: true })));
    if (on("datacite")) jobs.push(step("datacite", "work and relations", () => harvestDatacite(ctx, { dois: [ids.doi] })));
  }
  if (aspect === "work" && (ids.doi || ids.pmid) && on("pubmed")) jobs.push(step("pubmed", "PubMed record, authors and MeSH (RDF Portal)", () => harvestPubmedWork(ctx, { doi: ids.doi, pmid: ids.pmid })));
  if (aspect === "work" && (ids.doi || ids.openalex) && on("openalex")) jobs.push(step("openalex", "work, references, citing works", () => harvestOpenalex(ctx, aspect, ids)));
  if (aspect === "venue" && ids.issn && on("crossref")) jobs.push(step("crossref", "journal and recent works", () => harvestCrossref(ctx, { issn: ids.issn })));
  if (aspect === "venue" && (ids.issn || ids.openalex) && on("openalex")) jobs.push(step("openalex", "source and recent works", () => harvestOpenalex(ctx, aspect, ids)));
  if (aspect === "topic" && ids.openalex && on("openalex")) jobs.push(step("openalex", "topic and recent works", () => harvestOpenalex(ctx, aspect, ids)));
  const results = await Promise.all(jobs);

  // 4. DOIs listed in ORCID that no source has described yet: try Crossref, then DataCite.
  if (aspect === "author") {
    const orcidDois = results.find((r) => r?.dois)?.dois ?? [];
    // "Described" means a source with author lists has the work; ORCID's own work summaries have titles but no authors.
    const orcidGraph = graphFor("orcid");
    const described = () => new Set(quads.filter((q) => q.predicate.value === NS.schema + "name" && q.graph.value !== orcidGraph).map((q) => q.subject.value));
    let missing = orcidDois.filter((d) => !described().has(iri.doi(d)));
    if (missing.length && on("crossref")) await step("crossref", `${missing.length} more DOIs from ORCID`, () => harvestCrossref(ctx, { dois: missing }));
    missing = orcidDois.filter((d) => !described().has(iri.doi(d)));
    if (missing.length && on("datacite")) await step("datacite", `${missing.length} more DOIs from ORCID`, () => harvestDatacite(ctx, { dois: missing }));
  }

  // 4b. PubMed (via RDF Portal): PMIDs and MeSH subjects of the author's works, found by DOI.
  if (aspect === "author" && on("pubmed")) {
    const authored = new Set(quads.filter((q) => q.predicate.value === NS.schema + "author" && q.subject.value.startsWith("https://doi.org/")).map((q) => q.subject.value.slice(16)));
    const dois = [...authored].slice(0, 1000);
    if (dois.length) await step("pubmed", `${dois.length} DOIs looked up in PubMed (RDF Portal)`, () => harvestPubmedForDois(ctx, dois));
  }

  // 5. Merge.
  const merged = reconcile(ctx.DF, quads);
  return { key: keyString(key), aspect, iri: merged.canonical(keyToIri(key)), ids, quads: merged.quads, log };
}

// Exact-match codes of the term, as { prefix, id }, from the ontology's own quads.
function exactCodes(quads, termIri) {
  const out = [];
  for (const q of quads) {
    if (q.subject.value !== termIri || q.predicate.value !== SKOS + "exactMatch") continue;
    const t = parseTargetIri(q.object.value);
    if (t) out.push(t);
  }
  return out;
}
