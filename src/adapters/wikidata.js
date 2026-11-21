// Wikidata adapter: runs CONSTRUCT queries through Comunica against a Wikidata SPARQL endpoint,
// then maps the raw wdt: triples onto the schema.org model. The mapping happens here, not in SPARQL:
// minting IRIs inside the query (BIND(IRI(CONCAT(...)))) makes QLever evaluate it over all of Wikidata.
import { NS, iri, quadSink, dateLiteral } from "../model.js";
import { aspectForTypes, TYPE_TO_ASPECT } from "../aspects.js";
import { entityQuadsLive } from "../wikidata-live.js";
import { WD_PROPS, VOCABS, addMapping, canonicalPrefix, parseTargetIri, target, wikidataFormsForObo } from "../vocab.js";

const S = NS.schema;
const LINK = { author: "P50", topic: "P921", venue: "P1433", term: "P921" };
const PREDICATES = {
  [NS.rdfs + "label"]: S + "name",
  [S + "description"]: S + "description",
  [NS.wdt + "P1476"]: S + "name",
  [NS.wdt + "P50"]: S + "author",
  [NS.wdt + "P921"]: S + "about",
  [NS.wdt + "P1433"]: S + "isPartOf",
  [NS.wdt + "P2860"]: S + "citation",
  [NS.wdt + "P856"]: S + "url",
};
const CLASS = { author: "Person", work: "ScholarlyArticle", venue: "Periodical", term: "DefinedTerm" };

async function template(ctx, name, vars) {
  let text = (await ctx.loadText("queries/wikidata/prefixes.rq")) + "\n" + (await ctx.loadText(`queries/wikidata/${name}.rq`));
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[\w.\/:-]+$/.test(v)) throw new Error(`Unsafe template value for ${k}: ${v}`);
    text = text.replaceAll(`{{${k}}}`, v);
  }
  return text;
}

const source = (ctx) => [{ type: "sparql", value: ctx.endpoint }];

// Public endpoints rate-limit bursts (QLever answers HTTP 429), so queries go one at a time with backoff.
let queue = Promise.resolve();
function polite(fn) {
  const run = queue.then(async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); } catch (err) {
        if (!/HTTP status 429/.test(err.message) || attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      }
    }
  });
  queue = run.catch(() => {});
  return run;
}

export async function lookupQid(ctx, scheme, value) {
  const prop = { orcid: "P496", doi: "P356", pmid: "P698", issn: "P236", openalex: "P10283" }[scheme];
  if (!prop) return null;
  const v = scheme === "doi" ? value.toUpperCase() : value; // Wikidata stores DOIs upper-case
  const q = await template(ctx, "lookup", { prop, value: v });
  const rows = await polite(async () => (await ctx.engine.queryBindings(q, { sources: source(ctx), httpTimeout: 60000 })).toArray());
  return rows[0]?.get("item")?.value.replace(NS.wd, "") ?? null;
}

/** Wikidata item for an OBO term, via the ontology's own property (e.g. P5270 for MONDO) or P2888 exact match. */
export async function lookupOboQid(ctx, oboId) {
  const forms = wikidataFormsForObo(oboId);
  const purl = iri.obo(oboId);
  const byProp = forms ? `{ VALUES ?v { ${forms.values.map((v) => JSON.stringify(v)).join(" ")} } ?item wdt:${forms.property} ?v } UNION ` : "";
  const q = `PREFIX wdt: <${NS.wdt}> SELECT ?item WHERE { ${byProp}{ ?item wdt:P2888 <${purl}> } } LIMIT 1`;
  const rows = await polite(async () => (await ctx.engine.queryBindings(q, { sources: source(ctx), httpTimeout: 60000 })).toArray());
  return rows[0]?.get("item")?.value.replace(NS.wd, "") ?? null;
}

/**
 * Wikidata item that carries the most of these codes (exact matches from an ontology), for terms whose own ID is
 * not on Wikidata. codes: [{ prefix, id }]. Returns { qid, matched: ["DOID:9352", …] } or null.
 */
export async function matchQidByCodes(ctx, codes) {
  const branches = [];
  for (const c of codes) {
    const canon = canonicalPrefix(c.prefix);
    const v = canon && VOCABS[canon];
    if (!v?.wd) continue;
    const t = target(c.prefix, c.id);
    const forms = v.wdForms ? v.wdForms(t.code) : [t.code];
    const label = JSON.stringify(`${canon}:${t.code}`);
    branches.push(`{ VALUES ?v { ${forms.map((f) => JSON.stringify(f)).join(" ")} } ?item wdt:${v.wd} ?v BIND(${label} AS ?code) }`);
  }
  if (!branches.length) return null;
  const q = `PREFIX wdt: <${NS.wdt}> SELECT ?item ?code WHERE { ${branches.slice(0, 30).join(" UNION ")} }`;
  const rows = await polite(async () => (await ctx.engine.queryBindings(q, { sources: source(ctx), httpTimeout: 60000 })).toArray());
  const byItem = new Map();
  for (const r of rows) {
    const qid = r.get("item").value.replace(NS.wd, "");
    (byItem.get(qid) ?? byItem.set(qid, new Set()).get(qid)).add(r.get("code").value);
  }
  const [best] = [...byItem].sort((a, b) => b[1].size - a[1].size);
  return best ? { qid: best[0], matched: [...best[1]].sort(), candidates: byItem.size } : null;
}

export async function detectAspect(ctx, qid) {
  const q = await template(ctx, "types", { q: qid });
  const rows = await polite(async () => (await ctx.engine.queryBindings(q, { sources: source(ctx), httpTimeout: 60000 })).toArray());
  return aspectForTypes(rows.map((r) => r.get("type").value));
}

// opts.obo: the OBO id of the page's own term, so its Wikidata property becomes identity (sameAs), not a mapping.
export async function harvestWikidata(ctx, qid, aspect, opts = {}) {
  const runs = aspect === "work"
    ? [["entity", {}], ["work", {}], ["citations", {}]]
    : [["entity", {}], ["works", { link: LINK[aspect] }], ["works-people", { link: LINK[aspect] }], ["works-context", { link: LINK[aspect] }]]
      .map(([name, vars]) => [aspect === "term" && name !== "entity" ? `${name}-recent` : name, vars]);
  const raw = (await Promise.all(runs.map(async ([name, vars]) => {
    const q = await template(ctx, name, { q: qid, ...vars });
    return polite(async () => (await ctx.engine.queryQuads(q, { sources: source(ctx), httpTimeout: 60000 })).toArray());
  }))).flat();
  // An item too new for the SPARQL copy: read its own statements from Wikidata directly.
  const main = iri.wikidata(qid);
  const live = raw.some((q) => q.subject.value === main) ? [] : await entityQuadsLive(ctx.fetch, ctx.DF, qid).catch(() => []);
  raw.push(...live);
  if (aspect === "author") return mapToSchema(ctx.DF, raw, qid, aspect).concat(await externalIds(ctx, qid).catch(() => []));
  if (!["term", "topic"].includes(aspect)) return mapToSchema(ctx.DF, raw, qid, aspect);
  const codes = await polite(async () => (await ctx.engine.queryQuads(mappingQuery(qid), { sources: source(ctx), httpTimeout: 60000 })).toArray()).catch(() => []);
  return mapToSchema(ctx.DF, raw, qid, aspect).concat(mapCodes(ctx.DF, codes.length ? codes : live, qid, opts.obo));
}

// A person's other identifiers on Wikidata (library authorities, profiles, …), each with its link from the
// property's formatter URL (P1630). Shown on author pages, which otherwise depend on ORCID and OpenAlex.
async function externalIds(ctx, qid) {
  const q = `PREFIX wd: <${NS.wd}> PREFIX wdt: <${NS.wdt}> PREFIX wikibase: <http://wikiba.se/ontology#> PREFIX rdfs: <${NS.rdfs}>
SELECT ?prop ?label ?value (SAMPLE(?f) AS ?fmt) WHERE { wd:${qid} ?d ?value . ?prop wikibase:directClaim ?d ; wikibase:propertyType wikibase:ExternalId .
  OPTIONAL { ?prop rdfs:label ?label FILTER(LANG(?label) = "en") } OPTIONAL { ?prop wdt:P1630 ?f } } GROUP BY ?prop ?label ?value`;
  const rows = await polite(async () => (await ctx.engine.queryBindings(q, { sources: source(ctx), httpTimeout: 60000 })).toArray());
  const out = quadSink(ctx.DF, "wikidata");
  const main = iri.wikidata(qid);
  for (const r of rows) {
    const p = r.get("prop").value.split("/").pop(), v = r.get("value").value, fmt = r.get("fmt")?.value;
    const node = `urn:koetai-reconciliator:id:${p}:${encodeURIComponent(v)}`;
    out.add(main, S + "identifier", node);
    out.lit(node, S + "propertyID", p);
    out.lit(node, S + "value", v);
    out.lit(node, S + "name", r.get("label")?.value ?? p);
    if (fmt) out.add(node, S + "url", fmt.replace("$1", encodeURIComponent(v).replace(/%2F/g, "/")));
  }
  return out.quads;
}

// Terminology codes on the item itself (SNOMED CT, MeSH, ICD, UMLS, OBO ontologies, …) and P2888 exact match.
function mappingQuery(qid) {
  const props = [...WD_PROPS.keys(), "P2888"].map((p) => `wdt:${p}`).join(" ");
  return `PREFIX wdt: <${NS.wdt}> PREFIX wd: <${NS.wd}>
CONSTRUCT { wd:${qid} ?p ?code } WHERE { VALUES ?p { ${props} } wd:${qid} ?p ?code }`;
}
function mapCodes(DF, raw, qid, selfObo) {
  const out = quadSink(DF, "wikidata");
  const main = iri.wikidata(qid);
  const self = selfObo ? iri.obo(selfObo) : null;
  for (const { predicate: { value: p }, object: o } of raw) {
    const prop = p.replace(NS.wdt, "");
    let t = null;
    if (prop === "P2888") t = o.termType === "NamedNode" ? parseTargetIri(o.value) : null;
    else if (WD_PROPS.has(prop)) t = { prefix: WD_PROPS.get(prop), id: o.value };
    if (!t) continue;
    const tgt = target(t.prefix, t.id);
    if (tgt?.iri === self) { out.add(main, NS.schema + "sameAs", self); out.lit(main, NS.kr + "wikidataOwnId", o.value); }
    else {
      const at = addMapping(out, main, t.prefix, t.id, "exact");
      if (at) out.lit(at, NS.kr + "wikidataValue", o.value); // as written on Wikidata, needed to remove a statement
    }
  }
  return out.quads;
}

function mapToSchema(DF, raw, qid, aspect) {
  const out = quadSink(DF, "wikidata");
  const typeOf = new Map(TYPE_TO_ASPECT.flatMap(([a, iris]) => iris.map((i) => [i, a])));
  const roles = { [NS.wdt + "P50"]: ["work", "author"], [NS.wdt + "P921"]: ["work", null], [NS.wdt + "P1433"]: ["work", "venue"], [NS.wdt + "P2860"]: ["work", "work"] };
  const typed = new Set();
  const type = (s, a) => { if (CLASS[a] && !typed.has(s + a)) { typed.add(s + a); out.add(s, NS.rdf + "type", S + CLASS[a]); } };
  const main = iri.wikidata(qid);
  type(main, aspect);
  for (const { subject: s, predicate: { value: p }, object: o } of raw) {
    if (PREDICATES[p]) out.add(s, PREDICATES[p], o);
    if (roles[p]) { type(s.value, roles[p][0]); if (roles[p][1]) type(o.value, roles[p][1]); }
    switch (p) {
      case NS.wdt + "P577": {
        const m = o.value.match(/^(-?\d{1,4})-(\d\d)-(\d\d)/);
        if (m) out.add(s, S + "datePublished", dateLiteral(DF, m[1], m[2], m[3]));
        break;
      }
      case NS.wdt + "P496": out.add(s, S + "sameAs", iri.orcid(o.value)); type(s.value, "author"); break;
      // A DOI identifies a work. Journals and people sometimes carry one on Wikidata; it must not become their identity.
      case NS.wdt + "P10283": if (/^[WASTC]\d+$/.test(o.value)) out.add(s, S + "sameAs", iri.openalex(o.value)); break;
      case NS.wdt + "P356": if (s.value !== main || aspect === "work") out.add(s, S + "sameAs", iri.doi(o.value)); break;
      case NS.wdt + "P236": out.add(s, S + "sameAs", iri.issn(o.value)); out.lit(s, S + "issn", o.value); type(s.value, "venue"); break;
      case NS.wdt + "P31": out.add(s, S + "additionalType", o); if (typeOf.has(o.value)) type(s.value, typeOf.get(o.value)); break;
    }
  }
  return out.quads;
}
