// Genes associated with a disease, from Wikidata's "genetic association" (P2293) statements, read live from the
// Wikidata API (QLever times out joining statement references). -> graph urn:koetai-reconciliator:source:wikidata.
// Each association is a node with the gene, the sources its references cite (stated in, P248) and how it was
// determined (P459), so the panel shows where a link comes from (OMIM, Orphanet, GWAS Catalog, Gemma, …).
// OLS's copy of Orphanet (ORDO) has no disease–gene links, so Wikidata is the open, queryable source here.
import { NS, iri, quadSink } from "../model.js";

const API = "https://www.wikidata.org/w/api.php";
const MAX_GENES = 500;
const S = NS.schema;
const hgncId = (v) => (/^HGNC:/i.test(v) ? v.toUpperCase() : `HGNC:${v}`); // Wikidata stores the number only
const hgncIri = (v) => `https://www.genenames.org/data/gene-symbol-report/#!/hgnc_id/${hgncId(v)}`;

async function entities(ctx, ids, props) {
  const out = {};
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += 50) {
    const url = `${API}?${new URLSearchParams({ action: "wbgetentities", format: "json", origin: "*", ids: list.slice(i, i + 50).join("|"), props, languages: "en|mul", languagefallback: "1" })}`;
    const res = await ctx.fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Wikidata API HTTP ${res.status}`);
    Object.assign(out, (await res.json()).entities ?? {});
  }
  return out;
}
const itemIds = (snaks) => (snaks ?? []).map((s) => s.datavalue?.value?.id).filter(Boolean);

// Label, HGNC symbol and HGNC ID of gene items, from the SPARQL endpoint (full gene items are large to load).
async function geneDetails(ctx, qids) {
  const out = new Map();
  for (let i = 0; i < qids.length; i += 200) {
    const q = `PREFIX wd: <${NS.wd}> PREFIX wdt: <${NS.wdt}> PREFIX rdfs: <${NS.rdfs}>
SELECT ?gene ?label ?symbol ?hgnc WHERE { VALUES ?gene { ${qids.slice(i, i + 200).map((x) => `wd:${x}`).join(" ")} }
  OPTIONAL { ?gene rdfs:label ?label FILTER(LANG(?label) = "en") } OPTIONAL { ?gene wdt:P353 ?symbol } OPTIONAL { ?gene wdt:P354 ?hgnc } }`;
    const rows = await (await ctx.engine.queryBindings(q, { sources: [{ type: "sparql", value: ctx.endpoint }], httpTimeout: 60000 })).toArray().catch(() => []);
    for (const r of rows) {
      const g = r.get("gene").value.split("/").pop();
      const d = out.get(g) ?? out.set(g, {}).get(g);
      d.label ??= r.get("label")?.value; d.symbol ??= r.get("symbol")?.value; d.hgnc ??= r.get("hgnc")?.value;
    }
  }
  return out;
}

/** Gene associations of the disease item `qid`, attached to `subject` (the page's own IRI). */
export async function harvestGenesLive(ctx, qid, subject = iri.wikidata(qid)) {
  const out = quadSink(ctx.DF, "wikidata");
  const disease = (await entities(ctx, [qid], "claims"))[qid];
  const claims = (disease?.claims?.P2293 ?? []).filter((c) => c.rank !== "deprecated" && c.mainsnak?.datavalue).slice(0, MAX_GENES);
  if (!claims.length) return out.quads;
  const assoc = new Map(); // gene qid -> { sources, methods }
  for (const c of claims) {
    const g = c.mainsnak.datavalue.value.id;
    const a = assoc.get(g) ?? assoc.set(g, { sources: new Set(), methods: new Set() }).get(g);
    for (const r of c.references ?? []) for (const s of itemIds(r.snaks?.P248)) a.sources.add(s);
    for (const m of itemIds(c.qualifiers?.P459)) a.methods.add(m);
  }
  const genes = await geneDetails(ctx, [...assoc.keys()]);
  const named = await entities(ctx, [...assoc.values()].flatMap((a) => [...a.sources, ...a.methods]), "labels");
  const label = (q) => named[q]?.labels?.en?.value ?? named[q]?.labels?.mul?.value ?? Object.values(named[q]?.labels ?? {})[0]?.value ?? q;
  for (const [g, a] of assoc) {
    const e = genes.get(g);
    const gene = iri.wikidata(g);
    const node = `urn:koetai-reconciliator:gene-association:${qid}:${g}`;
    out.add(subject, NS.kr + "geneAssociation", node);
    out.add(node, NS.kr + "gene", gene);
    out.add(gene, NS.rdf + "type", S + "Gene");
    out.lit(gene, S + "name", e?.label);
    if (e?.symbol) out.lit(gene, NS.kr + "geneSymbol", e.symbol);
    if (e?.hgnc) { out.add(gene, NS.kr + "hgnc", hgncIri(e.hgnc)); out.lit(hgncIri(e.hgnc), S + "name", hgncId(e.hgnc)); }
    for (const s of a.sources) out.lit(node, NS.kr + "statedIn", label(s));
    for (const m of a.methods) out.lit(node, NS.kr + "method", label(m));
  }
  return out.quads;
}
