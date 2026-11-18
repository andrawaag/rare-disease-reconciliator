// OBO Foundry ontologies via EBI's Ontology Lookup Service (OLS4) -> graph urn:koetai-reconciliator:source:obo.
// One term: label, definition, synonyms (oboInOwl scopes), obsoletion, is-a parents and children, and its
// cross-references to other terminologies (SNOMED CT, MeSH, ICD, UMLS, other OBO ontologies, …) via src/vocab.js.
import { NS, iri, quadSink } from "../model.js";
import { politeJson } from "../http.js";
import { addMapping, parseTargetIri, OBOINOWL, OWL } from "../vocab.js";

const OLS = "https://www.ebi.ac.uk/ols4/api";
const S = NS.schema;
const RDFS = NS.rdfs;
const SYNONYM_SCOPE = { hasExactSynonym: "hasExactSynonym", hasRelatedSynonym: "hasRelatedSynonym", hasBroadSynonym: "hasBroadSynonym", hasNarrowSynonym: "hasNarrowSynonym" };
const enc2 = (s) => encodeURIComponent(encodeURIComponent(s));
const notFound = (err) => { if (/HTTP 404/.test(err.message)) return null; throw err; };

/** Fetch the term from its defining ontology (prefix in lower case), falling back to a lookup by IRI. */
const ONTOLOGY_OF = { orphanet: "ordo" }; // prefixes whose OLS ontology id differs
async function fetchTerm(ctx, termIri, prefix) {
  const ont = ONTOLOGY_OF[prefix.toLowerCase()] ?? prefix.toLowerCase();
  const direct = await politeJson(ctx, `${OLS}/ontologies/${ont}/terms/${enc2(termIri)}`, "OLS").catch(notFound);
  if (direct) return direct;
  const any = await politeJson(ctx, `${OLS}/terms?iri=${encodeURIComponent(termIri)}&size=50`, "OLS");
  const terms = any?._embedded?.terms ?? [];
  return terms.find((t) => t.is_defining_ontology) ?? terms[0] ?? null;
}

export async function harvestObo(ctx, oboId) {
  const out = quadSink(ctx.DF, "obo");
  const me = iri.obo(oboId);
  const prefix = oboId.split("_")[0];
  const term = await fetchTerm(ctx, me, prefix);
  if (!term) throw new Error(`OLS has no term ${oboId}`);
  const ont = term.ontology_name;
  const base = `${OLS}/ontologies/${ont}/terms/${enc2(me)}`;

  // Orphanet classifies disorders with part-of links (OLS's "hierarchical" parents and children); its plain is-a
  // parents are the disorder's type ("Disease", "Malformation syndrome", "Group of disorders", …).
  const isOrdo = ont === "ordo";
  const [ontology, parents, children, types, v2] = await Promise.all([
    politeJson(ctx, `${OLS}/ontologies/${ont}`, "OLS").catch(() => null),
    politeJson(ctx, `${base}/${isOrdo ? "hierarchicalParents" : "parents"}?size=100`, "OLS").catch(notFound),
    politeJson(ctx, `${base}/${isOrdo ? "hierarchicalChildren" : "children"}?size=500`, "OLS").catch(notFound),
    isOrdo ? politeJson(ctx, `${base}/parents?size=50`, "OLS").catch(() => null) : null,
    isOrdo ? politeJson(ctx, `${OLS}/v2/ontologies/ordo/entities/${enc2(me)}`, "OLS").catch(() => null) : null,
  ]);
  const typeIris = new Set((types?._embedded?.terms ?? []).map((t) => t.iri));

  out.add(me, NS.rdf + "type", S + "DefinedTerm");
  out.lit(me, S + "name", term.label);
  // OLS's description list can start with a comment; the OBO definition is the reliable one.
  out.lit(me, S + "description", term.obo_definition_citation?.[0]?.definition ?? term.description?.[0]);
  out.lit(me, S + "termCode", term.obo_id);
  const set = ontology?.config?.id ? `${NS.kr}ontology:${ontology.config.id}` : null;
  if (set) {
    out.add(me, S + "inDefinedTermSet", set);
    out.lit(set, S + "name", ontology.config.title ?? ont);
    out.lit(set, S + "url", ontology.config.homepage);
    out.lit(set, S + "version", ontology.config.versionIri ?? ontology.config.version);
  }
  if (term.is_obsolete) out.add(me, OWL + "deprecated", ctx.DF.literal("true", ctx.DF.namedNode(NS.xsd + "boolean")));
  const replaced = term.term_replaced_by;
  if (replaced) out.add(me, "http://purl.obolibrary.org/obo/IAO_0100001", /^https?:/.test(replaced) ? replaced : iri.obo(String(replaced).replace(":", "_")));

  // Synonyms with their OBO scope; exact ones also become schema:alternateName.
  for (const syn of term.obo_synonym ?? []) {
    const scope = SYNONYM_SCOPE[syn.scope] ?? "hasRelatedSynonym";
    out.lit(me, OBOINOWL + scope, syn.name);
    if (scope === "hasExactSynonym") out.lit(me, S + "alternateName", syn.name);
  }
  if (!term.obo_synonym) for (const name of term.synonyms ?? []) out.lit(me, OBOINOWL + "hasRelatedSynonym", name);

  // is-a hierarchy (one level up and down).
  const related = (list, up) => {
    for (const t of list?._embedded?.terms ?? []) {
      if (!t.iri) continue;
      if (up && typeIris.has(t.iri)) { out.lit(me, NS.kr + "orphanetType", t.label); continue; }
      out.add(up ? me : t.iri, RDFS + "subClassOf", up ? t.iri : me);
      out.add(t.iri, NS.rdf + "type", S + "DefinedTerm");
      out.lit(t.iri, S + "name", t.label);
      out.lit(t.iri, S + "termCode", t.obo_id);
    }
  };
  related(parents, true);
  related(children, false);
  if (children?.page?.totalElements > (children?._embedded?.terms?.length ?? 0)) out.lit(me, NS.kr + "childCount", children.page.totalElements);

  // Cross-references. "Exact" when the ontology says so (MONDO's "has exact match" / equivalentTo), otherwise a plain xref.
  const exact = new Set();
  for (const x of term.annotation?.["has exact match"] ?? []) {
    const t = typeof x === "string" ? parseTargetIri(x) : null;
    if (t) { addMapping(out, me, t.prefix, t.id, "exact"); exact.add(`${t.prefix}:${t.id}`.toUpperCase()); }
  }
  const xrefs = term.obo_xref?.length
    ? term.obo_xref.map((x) => ({ prefix: x.database, id: x.id, equivalent: /equivalentTo/i.test(x.description ?? "") }))
    : (term.annotation?.database_cross_reference ?? []).map((s) => { const [prefix, ...rest] = String(s).split(":"); return { prefix, id: rest.join(":") }; });
  // Orphanet states a mapping type on each cross-reference (OLS v2 axioms): E exact, NTBT (the Orphanet code is
  // narrower than the target, so the target is a broad match), BTNT (narrow match), ND (not yet decided), W (wrong).
  const ordoRelation = new Map();
  for (const x of v2?.["http://www.geneontology.org/formats/oboInOwl#hasDbXref"] ?? []) {
    const note = (x.axioms ?? []).map((a) => a["http://purl.obolibrary.org/obo/ECO_0000218"]).join(" ");
    const rel = /\bE \(Exact/.test(note) ? "exact" : /\bNTBT\b/.test(note) ? "broad" : /\bBTNT\b/.test(note) ? "narrow" : /\bW \(/.test(note) ? "wrong" : "xref";
    if (typeof x.value === "string") ordoRelation.set(x.value.toUpperCase(), rel);
  }
  for (const x of xrefs) {
    if (!x.prefix || !x.id) continue;
    const ordo = ordoRelation.get(`${x.prefix}:${x.id}`.toUpperCase());
    if (ordo === "wrong") continue;
    const isExact = x.equivalent || exact.has(`${x.prefix}:${x.id}`.toUpperCase());
    addMapping(out, me, x.prefix, x.id, ordo ?? (isExact ? "exact" : "xref"));
  }
  if (isOrdo && v2) orphanetFacts(out, me, v2);
  return out.quads;
}

// Orphanet's own annotations: inheritance, age of onset, prevalence, and its disease page.
const C = "http://www.orpha.net/ORDO/Orphanet_";
function orphanetFacts(out, me, v2) {
  const list = (k) => [].concat(v2[C + k] ?? []).map((v) => (typeof v === "object" ? v.value : v)).filter((v) => typeof v === "string");
  for (const v of list("C016")) out.lit(me, NS.kr + "inheritance", v);
  for (const v of list("C017")) out.lit(me, NS.kr + "ageOfOnset", v);
  for (const v of list("C022")) out.lit(me, NS.kr + "prevalence", v.replace(/ AND has_/g, "; ").replace(/_/g, " "));
  for (const v of list("C059")) out.lit(me, NS.schema + "url", v);
}

/** Label and obsolete status of a term, for checking IDs that Wikidata holds. */
export async function oboTermStatus(fetchFn, oboId) {
  const termIri = iri.obo(oboId);
  const res = await fetchFn(`${OLS}/terms?iri=${encodeURIComponent(termIri)}&size=50`).then((r) => r.json());
  const terms = res?._embedded?.terms ?? [];
  const t = terms.find((x) => x.is_defining_ontology) ?? terms[0];
  return t ? { label: t.label, obsolete: !!t.is_obsolete, replacedBy: t.term_replaced_by ?? null } : null;
}

/** OLS search, for the site's search box: terms whose label or synonym matches. */
export async function searchObo(fetchFn, text, rows = 6, ontologies = null) {
  const only = ontologies?.length ? `&ontology=${encodeURIComponent(ontologies.join(","))}` : "";
  const url = `${OLS}/search?q=${encodeURIComponent(text)}&rows=${rows * 3}&local=true${only}&fieldList=iri,label,obo_id,ontology_prefix,short_form`;
  const res = await fetchFn(url).then((r) => r.json());
  // OBO PURLs, and Orphanet's own IRIs (ORDO), which OLS lists with the short form "ORDO_558".
  return (res?.response?.docs ?? []).map((d) => {
    const orpha = d.iri?.match(/^http:\/\/www\.orpha\.net\/ORDO\/(Orphanet_\d+)$/)?.[1];
    if (orpha) return { id: orpha, label: d.label, oboId: `ORPHA:${orpha.slice(9)}`, ontology: "Orphanet" };
    if (d.iri?.startsWith("http://purl.obolibrary.org/obo/") && /^[A-Za-z]+_\w+$/.test(d.short_form ?? "")) return { id: d.short_form, label: d.label, oboId: d.obo_id, ontology: d.ontology_prefix };
    return null;
  }).filter(Boolean)
    // Orphanet first (stable sort keeps OLS's ranking within each group): it is the reference terminology here.
    .sort((a, b) => (b.ontology === "Orphanet") - (a.ontology === "Orphanet")).slice(0, rows);
}
