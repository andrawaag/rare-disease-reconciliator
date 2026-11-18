// Terminologies the reconciliator can map between (OBO ontologies, SNOMED CT, MeSH, ICD, UMLS, …).
// Every source that states a code for a concept (an OBO cross-reference, a Wikidata external ID) turns it into
// the same target IRI here, so agreement between sources shows up as one node with several provenance graphs.
//
//   <term> skos:exactMatch | oboInOwl:hasDbXref <target> .
//   <target> kr:vocabulary "SNOMED CT" ; kr:code "44054006" .
import { NS } from "./model.js";

export const SKOS = "http://www.w3.org/2004/02/skos/core#";
export const OBOINOWL = "http://www.geneontology.org/formats/oboInOwl#";
export const OWL = "http://www.w3.org/2002/07/owl#";
export const OBO = "http://purl.obolibrary.org/obo/";

const obo = (P) => (id) => `${OBO}${P}_${id}`;
// Canonical prefix -> label, IRI builder, Wikidata property, and how Wikidata writes the value.
// wdForms(id) lists the spellings Wikidata uses for that property, most common first (the one new statements use),
// e.g. "GO:0008150", "MONDO_0005148" or "0001718". wdItem: the ontology's own Wikidata item, for "stated in" references.
export const VOCABS = {
  SCTID: { label: "SNOMED CT", iri: (id) => `http://snomed.info/id/${id}`, wd: "P5806", aliases: ["SNOMEDCT", "SNOMEDCT_US", "SNOMED", "SNOMEDCT_US_2023_09_01"] },
  MESH: { label: "MeSH", iri: (id) => `http://id.nlm.nih.gov/mesh/${id}`, wd: "P486", aliases: ["MSH"] },
  ICD10WHO: { label: "ICD-10", iri: (id) => `https://icd.who.int/browse10/2019/en#/${id}`, wd: "P494", aliases: ["ICD10", "ICD-10"] },
  ICD10CM: { label: "ICD-10-CM", iri: (id) => `http://purl.bioontology.org/ontology/ICD10CM/${id}`, wd: "P4229", aliases: ["ICD-10-CM"] },
  ICD9CM: { label: "ICD-9-CM", iri: (id) => `http://purl.bioontology.org/ontology/ICD9CM/${id}`, wd: "P493", aliases: ["ICD9", "ICD-9", "ICD9CM_2006"] },
  ICD11: { label: "ICD-11", iri: (id) => `http://id.who.int/icd/entity/${id}`, wd: "P7807", aliases: ["icd11.foundation", "ICD11.FOUNDATION"] },
  UMLS: { label: "UMLS", iri: (id) => `http://linkedlifedata.com/resource/umls/id/${id}`, wd: "P2892", aliases: ["UMLS_CUI"] },
  OMIM: { label: "OMIM", iri: (id) => `https://omim.org/entry/${id}`, wd: "P492", aliases: ["MIM", "OMIMPS"] },
  ORPHANET: { label: "Orphanet", iri: (id) => `http://www.orpha.net/ORDO/Orphanet_${id}`, wd: "P1550", wdForms: (id) => [id], wdItem: "Q1515833", aliases: ["ORPHA", "ORDO", "Orphanet", "ORPHANET.ORDO"] },
  MEDDRA: { label: "MedDRA", iri: (id) => `http://identifiers.org/meddra/${id}`, wd: "P3201" },
  GARD: { label: "GARD", iri: (id) => `https://rarediseases.info.nih.gov/diseases/${id}/index`, wd: "P4317" },
  MEDGEN: { label: "MedGen", iri: (id) => `https://www.ncbi.nlm.nih.gov/medgen/${id}` },
  // Japanese rare-disease ontology (NanbyoData); not in OLS, checked through RDF Portal (src/adapters/rdfportal.js).
  NANDO: { label: "NANDO", iri: (id) => `http://nanbyodata.jp/ontology/NANDO_${id}` },
  // OBO Foundry ontologies with a Wikidata property.
  MONDO: { label: "MONDO", iri: obo("MONDO"), wd: "P5270", wdForms: (id) => [`MONDO_${id}`, `MONDO:${id}`], wdItem: "Q27468140" },
  DOID: { label: "Disease Ontology", iri: obo("DOID"), wd: "P699", wdForms: (id) => [`DOID:${id}`], wdItem: "Q5282129" },
  HP: { label: "HPO", iri: obo("HP"), wd: "P3841", wdForms: (id) => [`HP:${id}`], wdItem: "Q17027854" },
  GO: { label: "Gene Ontology", iri: obo("GO"), wd: "P686", wdForms: (id) => [`GO:${id}`], wdItem: "Q135085" },
  NCIT: { label: "NCI Thesaurus", iri: obo("NCIT"), wd: "P1748", wdForms: (id) => [id], aliases: ["NCI"] },
  UBERON: { label: "UBERON", iri: obo("UBERON"), wd: "P1554", wdForms: (id) => [id, `UBERON:${id}`] },
  CL: { label: "Cell Ontology", iri: obo("CL"), wd: "P7963", wdForms: (id) => [`CL_${id}`, `CL:${id}`] },
  CHEBI: { label: "ChEBI", iri: obo("CHEBI"), wd: "P683", wdForms: (id) => [id, `CHEBI:${id}`] },
  NCBITaxon: { label: "NCBI Taxonomy", iri: obo("NCBITaxon"), wd: "P685", wdForms: (id) => [id] },
  SO: { label: "Sequence Ontology", iri: obo("SO"), wd: "P3986", wdForms: (id) => [`SO:${id}`] },
  ENVO: { label: "ENVO", iri: obo("ENVO"), wd: "P3859", wdForms: (id) => [id, `ENVO:${id}`] },
};
const ALIAS = new Map();
for (const [k, v] of Object.entries(VOCABS)) for (const a of [k, ...(v.aliases ?? [])]) ALIAS.set(a.toUpperCase(), k);
export const WD_PROPS = new Map(Object.entries(VOCABS).filter(([, v]) => v.wd).map(([k, v]) => [v.wd, k]));

/** Canonical prefix for a CURIE prefix, or null. Uppercase all-letter prefixes are assumed to be OBO ontologies. */
export function canonicalPrefix(prefix) {
  // Versioned prefixes such as "SNOMEDCT_US_2025_09_01" (Disease Ontology) name the same terminology.
  const p = String(prefix).toUpperCase().replace(/_\d{4}_\d{2}_\d{2}$/, "");
  return ALIAS.get(p) ?? null;
}

/** Strip the prefix that some sources repeat inside the local id ("GO:0008150", "MONDO_0005148"). */
function localId(prefix, value) {
  const v = String(value).trim();
  const m = v.match(/^([A-Za-z][\w.-]*)[:_](.+)$/);
  return m && canonicalPrefix(m[1]) === prefix ? m[2] : v;
}

/** Target IRI and labels for prefix + id, or null when the id is unusable. */
export function target(prefix, id) {
  if (!id) return null;
  const canon = canonicalPrefix(prefix);
  if (canon) { const code = localId(canon, id); return { iri: VOCABS[canon].iri(code), vocabulary: VOCABS[canon].label, code }; }
  if (/^[A-Z][A-Za-z]*$/.test(prefix) && /^\d{5,}$/.test(id)) return { iri: obo(prefix)(id), vocabulary: prefix, code: id }; // other OBO ontologies
  return { iri: `https://bioregistry.io/${encodeURIComponent(prefix)}:${encodeURIComponent(id)}`, vocabulary: prefix, code: id };
}

/** Parse a cross-reference IRI (OBO PURL, identifiers.org, BioPortal, WHO, …) back to { prefix, id }. */
export function parseTargetIri(iriString) {
  const rules = [
    [/^http:\/\/purl\.obolibrary\.org\/obo\/([A-Za-z]+)_(\w+)$/, (m) => [m[1], m[2]]],
    [/^https?:\/\/identifiers\.org\/orphanet(?:\.ordo)?[/:](?:Orphanet_)?(\d+)$/, (m) => ["ORPHANET", m[1]]],
    [/^https?:\/\/identifiers\.org\/meddra[/:](\d+)$/, (m) => ["MEDDRA", m[1]]],
    [/^http:\/\/nanbyodata\.jp\/ontology\/NANDO_(\d+)$/, (m) => ["NANDO", m[1]]],
    // MedGen concept IDs that look like CUIs are UMLS CUIs (TogoID writes them this way); numeric ones are MedGen UIDs.
    [/^https?:\/\/identifiers\.org\/medgen[/:](C\d+)$/, (m) => ["UMLS", m[1]]],
    [/^https?:\/\/identifiers\.org\/mesh[/:](\w+)$/, (m) => ["MESH", m[1]]],
    [/^https?:\/\/identifiers\.org\/([\w.]+)[/:](.+)$/, (m) => [m[1], m[2]]],
    [/^http:\/\/purl\.bioontology\.org\/ontology\/(\w+)\/(.+)$/, (m) => [m[1], m[2]]],
    [/^http:\/\/linkedlifedata\.com\/resource\/umls\/id\/(\w+)$/, (m) => ["UMLS", m[1]]],
    [/^https?:\/\/icd\.who\.int\/browse10\/\d+\/en#\/(.+)$/, (m) => ["ICD10WHO", m[1]]],
    [/^https?:\/\/id\.who\.int\/icd\/entity\/(\d+)$/, (m) => ["ICD11", m[1]]],
    [/^https?:\/\/omim\.org\/entry\/(\d+)$/, (m) => ["OMIM", m[1]]],
    [/^http:\/\/snomed\.info\/id\/(\d+)$/, (m) => ["SCTID", m[1]]],
    [/^http:\/\/id\.nlm\.nih\.gov\/mesh\/(\w+)$/, (m) => ["MESH", m[1]]],
    [/^http:\/\/www\.orpha\.net\/ORDO\/Orphanet_(\d+)$/, (m) => ["ORPHANET", m[1]]],
  ];
  for (const [re, f] of rules) { const m = iriString.match(re); if (m) { const [prefix, id] = f(m); return { prefix, id }; } }
  return null;
}

/** Emit a mapping from `subject` to the code prefix:id. `relation` is "exact", "close", "broad", "narrow" or "xref". Returns the target IRI. */
export function addMapping(sink, subject, prefix, id, relation) {
  const t = target(prefix, id);
  if (!t || t.iri === subject) return null;
  const pred = { exact: "exactMatch", close: "closeMatch", broad: "broadMatch", narrow: "narrowMatch" }[relation];
  sink.add(subject, pred ? SKOS + pred : OBOINOWL + "hasDbXref", t.iri);
  sink.lit(t.iri, NS.kr + "vocabulary", t.vocabulary);
  sink.lit(t.iri, NS.kr + "code", t.code);
  return t.iri;
}

/** Wikidata spellings of an OBO id ("MONDO_0005148" -> property P5270, values ["MONDO:0005148", "MONDO_0005148"]). */
export function wikidataFormsForObo(oboId) {
  const [P, id] = oboId.split("_");
  const canon = canonicalPrefix(P);
  const v = canon && VOCABS[canon];
  if (!v?.wd || !v.wdForms) return null;
  return { property: v.wd, values: v.wdForms(id) };
}

// Which mapping targets EBI's Ontology Lookup Service can check, and under which IRI. OLS uses the same IRIs as
// src/vocab.js for OBO ontologies, SNOMED CT, MeSH, Orphanet and EFO; there "not found" means the code does not exist
// in the version OLS loaded. UMLS CUIs are looked up through MedGen, which reuses them but does not hold all of them,
// so a miss there proves nothing. Other vocabularies (ICD, OMIM, …) are not in OLS and are not checked.
const OLS_HOSTED = [/^http:\/\/purl\.obolibrary\.org\/obo\/[A-Za-z]+_\w+$/, /^http:\/\/snomed\.info\/id\/\d+$/, /^http:\/\/id\.nlm\.nih\.gov\/mesh\/\w+$/, /^http:\/\/www\.orpha\.net\/ORDO\/Orphanet_\d+$/, /^http:\/\/www\.ebi\.ac\.uk\/efo\/EFO_\d+$/];
export function olsLookup(targetIri) {
  if (OLS_HOSTED.some((re) => re.test(targetIri))) return { iri: targetIri, authoritative: true };
  const umls = targetIri.match(/^http:\/\/linkedlifedata\.com\/resource\/umls\/id\/(C\d+)$/);
  if (umls) return { iri: `${OBO}MEDGENCUI_${umls[1]}`, authoritative: false, via: "MedGen" };
  return null;
}
