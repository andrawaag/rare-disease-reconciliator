// Merges nodes that different sources describe under different IRIs, using schema:sameAs links.
// Canonical IRI per cluster: ORCID > DOI > PMID > OBO term > Wikidata > ISSN > OpenAlex > anything else. sameAs links are kept for provenance.
import { NS } from "./model.js";
const SAME_AS = NS.schema + "sameAs";

function rank(i) {
  if (i.startsWith("https://orcid.org/")) return 0;
  if (i.startsWith("https://doi.org/")) return 1;
  if (i.startsWith("http://rdf.ncbi.nlm.nih.gov/pubmed/")) return 1.2;
  if (i.startsWith("http://www.orpha.net/ORDO/")) return 1.4; // the reference terminology here
  if (i.startsWith("http://purl.obolibrary.org/obo/")) return 1.5;
  if (i.startsWith(NS.wd)) return 2;
  if (i.startsWith("urn:issn:")) return 3;
  if (i.startsWith("https://openalex.org/")) return 4;
  return 5;
}

export function reconcile(DF, quads) {
  const parent = new Map();
  const find = (x) => { while (parent.has(x) && parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)) ?? parent.get(x)); x = parent.get(x); } return x; };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    const [keep, drop] = rank(ra) < rank(rb) || (rank(ra) === rank(rb) && ra < rb) ? [ra, rb] : [rb, ra];
    parent.set(drop, keep); parent.set(keep, keep);
  };
  for (const q of quads) if (q.predicate.value === SAME_AS && q.object.termType === "NamedNode") union(q.subject.value, q.object.value);
  mergeAnonymousAuthors(quads, find, union);
  const canonical = (i) => find(i);
  const node = (t) => (t.termType === "NamedNode" ? DF.namedNode(canonical(t.value)) : t);
  const seen = new Set(), out = [], sameAsPairs = new Set();
  for (const q of quads) {
    const s = node(q.subject);
    const o = q.predicate.value === SAME_AS ? q.object : node(q.object);
    if (q.predicate.value === SAME_AS && o.value === s.value) continue;
    const k = `${s.value} ${q.predicate.value} ${o.termType}:${o.value}@${o.language ?? ""}^${o.datatype?.value ?? ""} ${q.graph.value}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (q.predicate.value === SAME_AS) sameAsPairs.add(`${s.value} ${o.value}`);
    out.push(DF.quad(s, q.predicate, o, q.graph));
  }
  // Make every member of a cluster discoverable from the canonical node.
  for (const member of parent.keys()) {
    const c = canonical(member);
    if (member !== c && !sameAsPairs.has(`${c} ${member}`)) { sameAsPairs.add(`${c} ${member}`); out.push(DF.quad(DF.namedNode(c), DF.namedNode(SAME_AS), DF.namedNode(member), DF.namedNode("urn:koetai-reconciliator:source:reconcile"))); }
  }
  return { quads: out, canonical };
}

// Authors without an ORCID can arrive under several local ids for one paper: per-work URNs (Crossref,
// DataCite), OpenAlex author ids, Wikidata items. Within one (already merged) work, join authors whose names
// match: exact normalised full name between two identified authors, or also family name + first initial
// when one side is only a per-work URN. Matching never crosses works, so namesakes on different papers stay apart.
const isAnon = (i) => /^urn:koetai-reconciliator:(crossref|datacite|openalex|pubmed)-author:/.test(i);
const norm = (n) => n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z\s-]/g, " ").replace(/-/g, " ").replace(/\s+/g, " ").trim();
const fullKey = (n) => norm(n);
const initialKey = (n) => { const p = norm(n).split(" ").filter(Boolean); return p.length > 1 ? `${p[0][0]} ${p.at(-1)}` : null; };
function mergeAnonymousAuthors(quads, find, union) {
  const names = new Map(), authors = new Map();
  for (const q of quads) {
    if (q.predicate.value === NS.schema + "name") (names.get(q.subject.value) ?? names.set(q.subject.value, []).get(q.subject.value)).push(q.object.value);
    if (q.predicate.value === NS.schema + "author") {
      const w = find(q.subject.value);
      (authors.get(w) ?? authors.set(w, new Set()).get(w)).add(q.object.value);
    }
  }
  for (const list of authors.values()) {
    if (list.size > 300) continue; // consortium papers: not worth the risk or the time
    const full = new Map(), initial = new Map();
    for (const a of list) {
      if (isAnon(a)) continue;
      for (const n of names.get(a) ?? []) {
        const f = fullKey(n), i = initialKey(n);
        if (full.has(f) && find(full.get(f)) !== find(a)) union(full.get(f), a); else full.set(f, a);
        if (i) initial.set(i, a);
      }
    }
    for (const a of list) {
      if (!isAnon(a)) continue;
      for (const n of names.get(a) ?? []) {
        const match = full.get(fullKey(n)) ?? initial.get(initialKey(n));
        if (match) { union(match, a); break; }
      }
    }
  }
}
