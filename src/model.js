// The koetai-reconciliator data model: schema.org, with one named graph per source.
// Identity: people are keyed by ORCID, works by DOI, venues by ISSN, ontology terms by OBO PURL, everything else by Wikidata QID.
// Adapters mint IRIs from whatever identifiers they have and assert schema:sameAs; src/reconcile.js merges them.

export const NS = {
  schema: "http://schema.org/",
  wd: "http://www.wikidata.org/entity/",
  wdt: "http://www.wikidata.org/prop/direct/",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  kr: "urn:koetai-reconciliator:vocab:",
};

export const SOURCES = ["wikidata", "orcid", "crossref", "datacite", "openalex", "obo", "ols", "rdfportal", "pubmed"];
export const graphFor = (source) => `urn:koetai-reconciliator:source:${source}`;

export const iri = {
  wikidata: (q) => NS.wd + q,
  orcid: (o) => `https://orcid.org/${o.toUpperCase()}`,
  doi: (d) => `https://doi.org/${d.trim().toLowerCase()}`,
  issn: (i) => `urn:issn:${i.trim().toUpperCase()}`,
  openalex: (id) => `https://openalex.org/${id.toUpperCase()}`,
  // Orphanet terms keep their own IRIs (ORDO); every other ontology term is an OBO PURL.
  obo: (id) => (/^Orphanet_\d+$/.test(id) ? `http://www.orpha.net/ORDO/${id}` : `http://purl.obolibrary.org/obo/${id}`),
  pmid: (id) => `http://rdf.ncbi.nlm.nih.gov/pubmed/${id}`,
};
// OBO prefixes keep their case convention: upper case, except a few mixed-case ones.
const OBO_CASE = { ncbitaxon: "NCBITaxon" };
const oboPrefix = (p) => OBO_CASE[p.toLowerCase()] ?? p.toUpperCase();

const PATTERNS = [
  ["wikidata", /^(?:wikidata:|wd:)?(Q\d+)$/i, (m) => m[1].toUpperCase()],
  ["orcid", /^(?:orcid:|https?:\/\/orcid\.org\/)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/i, (m) => m[1].toUpperCase()],
  ["doi", /^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i, (m) => m[1].toLowerCase()],
  ["issn", /^(?:issn:|urn:issn:)?(\d{4}-\d{3}[\dX])$/i, (m) => m[1].toUpperCase()],
  ["openalex", /^(?:openalex:|https?:\/\/(?:api\.)?openalex\.org\/(?:\w+\/)?)?([WASTC]\d{3,})$/i, (m) => m[1].toUpperCase()],
  // PubMed: "pmid:26978244", a PubMed URL or the PubMed RDF IRI. A bare number is not taken as a PMID.
  ["pmid", /^(?:pmid:\s*|https?:\/\/(?:pubmed\.ncbi\.nlm\.nih\.gov|rdf\.ncbi\.nlm\.nih\.gov\/pubmed)\/)(\d{1,9})\/?$/i, (m) => m[1]],
  // Orphanet disease: "ORPHA:558", "Orphanet:558", "Orphanet_558", the ORDO IRI or an orpha.net disease page.
  ["obo", /^(?:obo:)?(?:orpha(?:net)?[:_]\s*|https?:\/\/www\.orpha\.net\/ORDO\/Orphanet_|https?:\/\/www\.orpha\.net\/(?:\w\w\/)?disease\/detail\/)(\d+)\/?$/i, (m) => `Orphanet_${m[1]}`],
  // OBO term: "obo:MONDO_0005148", "MONDO:0005148" or the PURL.
  ["obo", /^(?:obo:|https?:\/\/purl\.obolibrary\.org\/obo\/)?([A-Za-z][A-Za-z]{1,15})[_:](\d{4,}|[A-Z]?\d{3,})$/, (m) => `${oboPrefix(m[1])}_${m[2]}`],
];

/** Parse user input or a route key ("orcid:0000-…", "10.1145/…", "Q42") into { scheme, value }. */
export function parseKey(input) {
  const s = decodeURIComponent(String(input)).trim();
  for (const [scheme, re, norm] of PATTERNS) {
    const m = s.match(re);
    if (m) return { scheme, value: norm(m) };
  }
  const wd = s.match(/^http:\/\/www\.wikidata\.org\/entity\/(Q\d+)$/);
  if (wd) return { scheme: "wikidata", value: wd[1] };
  return null;
}

/** The term id ("MONDO_0005148", "Orphanet_558") of an ontology term IRI, or null. */
export function termIdOf(i) {
  return i.match(/^http:\/\/purl\.obolibrary\.org\/obo\/([A-Za-z]+_\w+)$/)?.[1] ?? i.match(/^http:\/\/www\.orpha\.net\/ORDO\/(Orphanet_\d+)$/)?.[1] ?? null;
}
export const keyString = ({ scheme, value }) => `${scheme}:${value}`;
export const keyToIri = ({ scheme, value }) => iri[scheme](value);
export const iriToKey = (i) => (/^(https?:|urn:issn:)/.test(i) ? parseKey(i) : null);

/** Which aspect an identifier implies on its own (a Wikidata QID needs a type lookup). */
const OPENALEX_ASPECT = { A: "author", W: "work", S: "venue", T: "topic", C: "topic" };
export function aspectForKey({ scheme, value }) {
  if (scheme === "openalex") return OPENALEX_ASPECT[value[0]];
  return { orcid: "author", doi: "work", pmid: "work", issn: "venue", obo: "term" }[scheme];
}

/** Normalise a partial date to an RDF literal: xsd:date, xsd:gYearMonth or xsd:gYear. */
export function dateLiteral(DF, y, m, d) {
  if (!y) return null;
  const p = (n) => String(n).padStart(2, "0");
  if (m && d) return DF.literal(`${y}-${p(m)}-${p(d)}`, DF.namedNode(NS.xsd + "date"));
  if (m) return DF.literal(`${y}-${p(m)}`, DF.namedNode(NS.xsd + "gYearMonth"));
  return DF.literal(String(y), DF.namedNode(NS.xsd + "gYear"));
}

/**
 * External identifiers that have a Wikidata property, as schema:identifier nodes:
 *   <person> schema:identifier <urn:…:id:P1153:123> . <urn:…:id:P1153:123> schema:propertyID "P1153" ; schema:value "123" .
 * The property id doubles as the identifier type, so the Add-to-Wikidata panel can use it directly.
 */
export function addIdentifier(sink, subject, property, value) {
  if (!value) return;
  const v = String(value).trim();
  const node = `urn:koetai-reconciliator:id:${property}:${encodeURIComponent(v)}`;
  sink.add(subject, NS.schema + "identifier", node);
  sink.lit(node, NS.schema + "propertyID", property);
  sink.lit(node, NS.schema + "value", v);
}

/** Small helper that collects quads for one source graph. */
export function quadSink(DF, source) {
  const g = DF.namedNode(graphFor(source));
  const quads = [];
  const term = (x) => (typeof x === "string" ? DF.namedNode(x) : x);
  return {
    quads,
    add(s, p, o) { if (s && o) quads.push(DF.quad(term(s), DF.namedNode(p), term(o), g)); },
    lit(s, p, value, lang) { if (value != null && value !== "") quads.push(DF.quad(term(s), DF.namedNode(p), DF.literal(String(value), lang), g)); },
  };
}
