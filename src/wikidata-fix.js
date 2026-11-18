// "Improve Wikidata" for ontology terms: compare the term's codes with the linked Wikidata item and propose
// QuickStatements (V1) edits. The visitor reviews them and runs them under their own Wikimedia account.
//   - add the term's own ID when the item was only matched through shared codes;
//   - add codes the ontology states as exact matches but the item lacks (with qualifier P4390 = exact match);
//   - optionally remove an ID of the same ontology that the item holds but the ontology has made obsolete.
// Codes that only Wikidata has are listed for review; nothing is proposed for them.
import { VOCABS, canonicalPrefix, parseTargetIri, target } from "./vocab.js";
import { oboTermStatus, harvestObo } from "./adapters/obo.js";
import { checkConceptsOls } from "./adapters/ols.js";
import { termIdOf, NS } from "./model.js";

// Values for P4390 "mapping relation type".
const MAPPING_ITEM = { exact: "Q39893449", broad: "Q39894595", narrow: "Q39893967" };
// Orphanet's modes of inheritance -> Wikidata items, for P1199 "mode of inheritance".
const INHERITANCE = {
  "Autosomal dominant": "Q116406", "Autosomal recessive": "Q15729064", "X-linked recessive": "Q1988987",
  "X-linked dominant": "Q3731276", "Mitochondrial inheritance": "Q3537727", "Y-linked": "Q2598585",
};
const clean = (s) => String(s).replace(/["\t\n\r|]/g, " ").trim();

// Ontologies whose current term on a Wikidata item is read on topic pages, to propose the codes it maps to.
const ANCHORS = ["ORPHANET", "MONDO", "DOID"];
const SKOS = "http://www.w3.org/2004/02/skos/core#";
const ANCHOR_RELATION = { [SKOS + "exactMatch"]: "exact", [SKOS + "broadMatch"]: "broad", [SKOS + "narrowMatch"]: "narrow" };

/**
 * Topic pages (a Wikidata item): the item's current Orphanet, MONDO and Disease Ontology terms are read from OLS,
 * and the codes they map to that the item lacks are proposed, citing the ontology that states them. Codes OLS
 * reports obsolete or unknown are left out. `ctx`: the harvest context (OLS fetches).
 */
async function anchorAdditions(ctx, anchors) {
  const found = new Map(); // property|value -> addition
  for (const a of anchors.slice(0, 3)) {
    const quads = await harvestObo(ctx, a.termId).catch(() => []);
    const me = a.iri;
    for (const q of quads) {
      const mapping = q.subject.value === me && ANCHOR_RELATION[q.predicate.value];
      if (!mapping) continue;
      const t = parseTargetIri(q.object.value);
      const canon = t && canonicalPrefix(t.prefix);
      const vocab = canon && VOCABS[canon];
      // Not for ontologies the item already has a current term of: MONDO's Orphanet code is not a second Orphanet ID.
      if (!vocab?.wd || anchors.some((x) => x.canon === canon)) continue;
      const tg = target(t.prefix, t.id);
      const value = vocab.wdForms ? vocab.wdForms(tg.code)[0] : tg.code;
      const key = `${vocab.wd}|${value}`;
      const prev = found.get(key);
      if (prev) { if (!prev.by.includes(a.label)) prev.by.push(a.label); if (mapping === "exact") { prev.mapping = "exact"; prev.optional = false; } continue; }
      found.set(key, { vocabulary: vocab.label, code: tg.code, url: tg.iri, property: vocab.wd, value, mapping, optional: mapping !== "exact", by: [a.label], reference: a.reference });
    }
  }
  if (!found.size) return [];
  const checked = await checkConceptsOls(ctx, [...found.values()].map((x) => x.url)).catch(() => []);
  const bad = new Set([].concat(checked?.quads ?? checked ?? []).filter((q) => q.predicate.value === NS.kr + "checkStatus" && q.object.value !== "current").map((q) => q.subject.value));
  return [...found.values()].filter((x) => !bad.has(x.url));
}

export async function gatherFixes(run, pageIri, fetchFn, ctx = null) {
  // Term pages (an OBO PURL) get all kinds of edit. Topic pages (a Wikidata item) get the codes the item's own
  // current ontology terms map to, replacements of obsolete codes, and the deprecation of obsolete codes.
  const oboId = termIdOf(pageIri);
  const isTerm = !!oboId;
  const [prefix, local] = oboId ? oboId.split("_") : [null, null];
  const ownCanon = prefix ? canonicalPrefix(prefix) : null;
  const own = ownCanon ? VOCABS[ownCanon] : null;
  const [fixRows, mapRows] = await Promise.all([run("queries/term/wikidata-fix.rq"), run("queries/term/mappings.rq")]);

  let qid = isTerm ? null : pageIri.match(/\/(Q\d+)$/)?.[1] ?? null, ownOnWikidata = false;
  const matchedBy = [], wdValues = new Map();
  for (const b of fixRows) {
    const kind = b.get("kind").value;
    if (kind === "item" && isTerm) qid = b.get("item").value.split("/").pop();
    else if (kind === "own") ownOnWikidata = true;
    else if (kind === "matchedBy") matchedBy.push(b.get("value").value);
    else if (kind === "value") {
      const code = b.get("code").value, v = b.get("value").value;
      if (!/^https?:/.test(v)) (wdValues.get(code) ?? wdValues.set(code, []).get(code)).push(v);
    }
  }
  const result = { qid, oboId, isTerm, label: own?.label ?? prefix, matchedBy, own: null, additions: [], facts: [], removals: [], review: [] };
  if (!qid) return result;

  // Orphanet statements cite the disorder's page on orpha.net; other ontologies their term IRI.
  const reference = { item: own?.wdItem ?? null, url: ownCanon === "ORPHANET" ? `https://www.orpha.net/en/disease/detail/${local}` : pageIri };
  if (own?.wd && !ownOnWikidata) {
    result.own = { property: own.wd, value: own.wdForms ? own.wdForms(local)[0] : local, vocabulary: own.label, code: `${prefix}:${local}`, url: pageIri, reference };
  }

  const anchors = [];
  for (const b of mapRows) {
    const code = b.get("code")?.value;
    if (!code) continue;
    const sources = new Set((b.get("sources")?.value ?? "").split(" "));
    const relation = b.get("relation")?.value ?? "";
    const label = b.get("codeLabel")?.value ?? code;
    const t = parseTargetIri(code);
    const canon = t && canonicalPrefix(t.prefix);
    const vocab = canon && VOCABS[canon];
    const row = { vocabulary: vocab?.label ?? b.get("vocabulary")?.value ?? "", code: label, url: code };
    // What OLS (src/adapters/ols.js) or RDF Portal (NANDO) says about the code; null when neither covers it or was asked.
    const checked = b.get("status")?.value ?? null;
    const from = b.get("checkedIn")?.value ?? "OLS";
    let status = checked ? { label: b.get("checkedName")?.value ?? null, obsolete: checked === "obsolete", missing: checked === "not found", replacedBy: b.get("replacedBy")?.value ?? null, from } : null;
    const named = status?.label ? ` (“${status.label}” in ${from})` : "";
    if (sources.has("obo") && !sources.has("wikidata")) {
      // Exact matches are proposed (ticked); Orphanet's broader / narrower mappings too, with that relation, unticked.
      const mapping = relation.includes("exact") ? "exact" : relation.includes("broad") ? "broad" : relation.includes("narrow") ? "narrow" : null;
      if (vocab?.wd && mapping && canon !== ownCanon) {
        if (status?.obsolete || status?.missing) result.review.push({ ...row, note: `${status.obsolete ? "obsolete" : "not found"} in ${status.from}${named}, so not proposed although ${result.label} maps to it` });
        else result.additions.push({ ...row, property: vocab.wd, value: vocab.wdForms ? vocab.wdForms(label)[0] : label, reference, status, mapping, optional: mapping !== "exact" });
      }
    } else if (sources.has("wikidata") && !sources.has("obo")) {
      if (vocab?.wd && wdValues.has(code)) {
        // Without an OLS result (source switched off, old snapshot), still check same-ontology IDs directly.
        if (!status && canon === ownCanon) status = await oboTermStatus(fetchFn, `${prefix}_${label}`).catch(() => null);
        if (status?.obsolete) {
          for (const value of wdValues.get(code)) result.removals.push({ ...row, property: vocab.wd, value, status });
          // The ontology's replacement for the obsolete code, when it names one.
          const rt = status.replacedBy && parseTargetIri(status.replacedBy);
          const rc = rt && canonicalPrefix(rt.prefix);
          if (rc && VOCABS[rc]?.wd) {
            const tg = target(rt.prefix, rt.id), rv = VOCABS[rc];
            result.additions.push({ vocabulary: rv.label, code: tg.code, url: tg.iri, property: rv.wd, value: rv.wdForms ? rv.wdForms(tg.code)[0] : tg.code, mapping: "exact", optional: false, by: [rv.label], replaces: `${row.vocabulary} ${label}`, reference: { item: rv.wdItem ?? null, url: tg.iri } });
          }
          continue;
        }
        if (!isTerm && ANCHORS.includes(canon) && status && !status.missing) {
          const termId = termIdOf(code);
          if (termId) anchors.push({ termId, iri: code, canon, label: vocab.label, reference: { item: vocab.wdItem ?? null, url: canon === "ORPHANET" ? `https://www.orpha.net/en/disease/detail/${label}` : code } });
        }
        if (status?.missing) { result.review.push({ ...row, note: `not found in ${status.from}: check the code on Wikidata` }); continue; }
        if (canon === ownCanon) { result.review.push({ ...row, note: status?.label ? `“${status.label}”, a different ${own.label} term` : `a different ${own.label} term` }); continue; }
      }
      if (isTerm) result.review.push({ ...row, note: `only on Wikidata${named}` });
    }
  }
  if (!isTerm && ctx && anchors.length) {
    anchors.sort((x, y) => ANCHORS.indexOf(x.canon) - ANCHORS.indexOf(y.canon));
    const held = new Set([...wdValues.values()].flat().map((v) => v.toUpperCase()));
    const have = new Set(result.additions.map((x) => `${x.property}|${x.value}`));
    for (const x of await anchorAdditions(ctx, anchors)) if (!held.has(String(x.value).toUpperCase()) && !have.has(`${x.property}|${x.value}`)) result.additions.push(x);
    result.anchors = anchors.map((a) => `${a.label} ${a.termId.split("_").pop()}`);
  }
  // Orphanet disorders: Orphanet's mode of inheritance (P1199), when Wikidata has an item for it.
  if (ownCanon === "ORPHANET") {
    const details = await run("queries/term/details.rq").catch(() => []);
    for (const mode of (details[0]?.get("inheritance")?.value ?? "").split(", ").filter(Boolean)) {
      const item = INHERITANCE[mode];
      if (item) result.facts.push({ property: "P1199", value: item, item: true, vocabulary: "mode of inheritance", code: mode, url: pageIri, reference });
    }
  }
  return result;
}

/** QuickStatements V1 for the chosen fixes. `chosen` holds the keys returned by fixKey(). */
export function buildFixCommands(fix, chosen, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const q = fix.qid;
  const ref = (r) => [r.item ? `S248\t${r.item}` : null, `S854\t"${clean(r.url)}"`, `S813\t+${today}T00:00:00Z/11`].filter(Boolean).join("\t");
  const lines = [];
  if (fix.own && chosen.has(fixKey(fix.own))) lines.push(`${q}\t${fix.own.property}\t"${clean(fix.own.value)}"\t${ref(fix.own.reference)}`);
  for (const a of fix.additions) if (chosen.has(fixKey(a))) lines.push(`${q}\t${a.property}\t"${clean(a.value)}"\tP4390\t${MAPPING_ITEM[a.mapping ?? "exact"]}\t${ref(a.reference)}`);
  for (const f of fix.facts ?? []) if (chosen.has(fixKey(f))) lines.push(`${q}\t${f.property}\t${f.item ? f.value : `"${clean(f.value)}"`}\t${ref(f.reference)}`);
  // Obsolete codes are deprecated, not removed: QuickStatements can't set ranks, see deprecationEdit().
  return lines.join("\n");
}

// Reason for deprecated rank (P2241): withdrawn identifier value. Deprecating keeps the code findable on the item
// (and in other databases that cite it) while marking it as no longer valid.
const WITHDRAWN = "Q21441764";
const statementValue = (c) => { const v = c.mainsnak?.datavalue?.value; return typeof v === "string" ? v : v?.id ?? null; };

/**
 * Deprecate statements holding obsolete codes. QuickStatements can't change a statement's rank, so this is a
 * wbeditentity edit the visitor runs in Wikidata's API sandbox, under their own account (the sandbox adds the
 * edit token). `removals`: chosen fix.removals, each with `statements` (live statement JSON holding the value).
 * Returns { url, data } or null.
 */
export function deprecationEdit(qid, removals, label) {
  const claims = [];
  for (const r of removals) for (const c of r.statements ?? []) {
    if (c.rank === "deprecated") continue;
    const reason = { snaktype: "value", property: "P2241", datavalue: { type: "wikibase-entityid", value: { "entity-type": "item", "numeric-id": Number(WITHDRAWN.slice(1)), id: WITHDRAWN } } };
    const held = c.qualifiers?.P2241 ?? [];
    const qualifiers = { ...(c.qualifiers ?? {}), P2241: held.some((x) => x.datavalue?.value?.id === WITHDRAWN) ? held : [...held, reason] };
    const order = [...new Set([...(c["qualifiers-order"] ?? []), "P2241"])];
    claims.push({ ...c, rank: "deprecated", qualifiers, "qualifiers-order": order });
  }
  if (!claims.length) return null;
  const codes = removals.map((r) => `${r.property} ${r.value}`).join(", ");
  const by = [...new Set(removals.map((r) => r.status?.from ?? label).filter(Boolean))].join(", ") || "its source";
  const data = JSON.stringify({ claims });
  const params = new URLSearchParams({ action: "wbeditentity", format: "json", id: qid, data, summary: `Deprecate ${codes}: obsolete according to ${by} (reason: withdrawn identifier value)` });
  return { url: `https://www.wikidata.org/wiki/Special:ApiSandbox#${params.toString().replace(/\+/g, "%20")}`, data, count: claims.length };
}
export { statementValue };

export const fixKey = (x) => `${x.property}|${x.value}`;
