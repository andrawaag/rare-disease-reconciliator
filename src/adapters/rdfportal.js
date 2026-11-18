// RDF Portal (https://rdfportal.org, DBCLS) -> graph urn:koetai-reconciliator:source:rdfportal.
// Two datasets on its "primary" SPARQL endpoint:
//   - TogoID: ID links between life-science databases, one named graph per pair of databases (mondo-mesh, nando-mondo,
//     mondo-doid, …). For a term page, its links become mappings next to the ontology's and Wikidata's:
//     TIO_000002 "is equivalent to" -> skos:exactMatch, TIO_000001 "is nearly equivalent to" -> skos:closeMatch.
//   - NANDO, the Japanese rare-disease ontology, which OLS does not load: NANDO codes on a page are checked here,
//     with the same terms the OLS check uses (kr:checkStatus, kr:checkedName).
// The endpoints are Virtuoso with open CORS. Queries stay anchored on known IRIs: open patterns time out.
import { NS, quadSink } from "../model.js";
import { addMapping, parseTargetIri } from "../vocab.js";

export const RDFPORTAL_SPARQL = "https://rdfportal.org/primary/sparql";
const TIO = "http://togoid.dbcls.jp/ontology#";
const RELATION = { [TIO + "TIO_000002"]: "exact", [TIO + "TIO_000001"]: "close" };
const TOGOID_GRAPHS = "http://rdfportal.org/dataset/togoid/relation/";
const NANDO_GRAPH = "http://nanbyodata.jp/ontology/nando";
const safeIri = (s) => /^https?:\/\/[^\s<>"{}|\\^`]+$/.test(s);

/** SELECT on an RDF Portal endpoint ("primary", "ncbi", …), returning SPARQL JSON bindings. */
export async function rdfPortalSelect(ctx, query, endpoint = RDFPORTAL_SPARQL) {
  for (let attempt = 0; ; attempt++) {
    const res = await ctx.fetch(endpoint, {
      method: "POST",
      headers: { Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded", ...ctx.headers },
      body: new URLSearchParams({ query }).toString(),
      signal: AbortSignal.timeout(30000), // Virtuoso can be slow under load; the page goes on without RDF Portal
    });
    if (res.ok) return (await res.json()).results.bindings;
    if (![429, 503].includes(res.status) || attempt >= 3) throw new Error(`RDF Portal HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

/** The IRI TogoID uses for a term: Orphanet codes are identifiers.org IRIs there, OBO terms their PURLs. */
export const togoidIri = (termId) => (/^Orphanet_\d+$/.test(termId) ? `http://identifiers.org/orphanet.ordo/${termId}` : `http://purl.obolibrary.org/obo/${termId}`);

/** TogoID equivalence links of one term, in both directions, as mappings from `subject`. */
export async function harvestTogoid(ctx, subject, termIri) {
  if (!safeIri(termIri)) return [];
  const out = quadSink(ctx.DF, "rdfportal");
  const rows = await rdfPortalSelect(ctx, `SELECT DISTINCT ?x ?p ?g WHERE {
  VALUES ?p { <${TIO}TIO_000001> <${TIO}TIO_000002> }
  { GRAPH ?g { ?x ?p <${termIri}> } } UNION { GRAPH ?g { <${termIri}> ?p ?x } }
  FILTER(STRSTARTS(STR(?g), "${TOGOID_GRAPHS}"))
}`);
  // A pair can be stated both as nearly equivalent and as equivalent: keep the stronger one.
  const best = new Map();
  for (const b of rows) {
    const x = b.x.value, rel = RELATION[b.p.value];
    if (x === termIri || !rel) continue;
    if (best.get(x) !== "exact") best.set(x, rel);
  }
  for (const [x, rel] of best) {
    const t = parseTargetIri(x);
    if (t) addMapping(out, subject, t.prefix, t.id, rel); // skips a link back to the page's own term
  }
  // ClinVar variants that TogoID links to the disease ("has related phenotype"): how much variant evidence exists.
  const cv = await rdfPortalSelect(ctx, `SELECT (COUNT(DISTINCT ?v) AS ?n) WHERE { GRAPH ?g { ?v <${TIO}TIO_000010> <${termIri}> } FILTER(STRSTARTS(STR(?g), "${TOGOID_GRAPHS}clinvar-")) }`).catch(() => []);
  const n = Number(cv[0]?.n?.value ?? 0);
  if (n) out.add(subject, NS.kr + "clinvarVariantCount", ctx.DF.literal(String(n), ctx.DF.namedNode(NS.xsd + "integer")));
  return out.quads;
}

/** Look NANDO codes up in NANDO itself: English (else Japanese) label, and whether the class is deprecated. */
export async function checkNando(ctx, nandoIris) {
  const iris = [...new Set(nandoIris)].filter((i) => safeIri(i) && i.startsWith("http://nanbyodata.jp/ontology/NANDO_"));
  const out = quadSink(ctx.DF, "rdfportal");
  if (!iris.length) return out.quads;
  const rows = await rdfPortalSelect(ctx, `SELECT ?c ?label ?lang ?dep WHERE {
  VALUES ?c { ${iris.map((i) => `<${i}>`).join(" ")} }
  GRAPH <${NANDO_GRAPH}> { ?c a ?type OPTIONAL { ?c <http://www.w3.org/2000/01/rdf-schema#label> ?label BIND(LANG(?label) AS ?lang) } OPTIONAL { ?c <http://www.w3.org/2002/07/owl#deprecated> ?dep } }
}`);
  const found = new Map();
  for (const b of rows) {
    const c = b.c.value, f = found.get(c) ?? found.set(c, { en: null, ja: null, deprecated: false }).get(c);
    if (b.label) { if (b.lang?.value === "en") f.en ??= b.label.value; else if (b.lang?.value === "ja" && !/^[぀-ゟ\s\d]+$/.test(b.label.value)) f.ja ??= b.label.value; }
    if (b.dep?.value === "true") f.deprecated = true;
  }
  for (const c of iris) {
    const f = found.get(c);
    if (!f) { out.lit(c, NS.kr + "checkStatus", "not found"); continue; }
    out.lit(c, NS.kr + "checkStatus", f.deprecated ? "obsolete" : "current");
    out.lit(c, NS.kr + "checkedName", f.en && f.ja ? `${f.en} (${f.ja})` : f.en ?? f.ja);
    out.lit(c, NS.kr + "checkedOntology", "nando");
  }
  return out.quads;
}
