// Researchers on Wikidata without an ORCID or OpenAlex ID: find the profiles that are probably theirs, so the page
// can link them. Candidates come from OpenAlex's author search and ORCID's name search (both CORS-open, no key).
// A candidate is "likely" when the name matches exactly and it shares an employer with the item (P108). Nothing is
// linked automatically: the visitor picks a profile, and the QuickStatements adding its IDs run under their account.
import { findByStatementsLive } from "./wikidata-live.js";

const WD_API = "https://www.wikidata.org/w/api.php";
const OPENALEX = "Q107507571";
const ORCID = "Q51044";
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[.\-,']/g, " ").replace(/\s+/g, " ").trim();
const clean = (s) => String(s).replace(/["\t\n\r|]/g, " ").trim();

async function json(fetchFn, url, init) {
  const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).host}`);
  return res.json();
}

/** The item's label, aliases, employers (labels) and whether it already has an ORCID (P496) or OpenAlex ID (P10283). */
export async function personFacts(fetchFn, qid) {
  const q = (p) => `${WD_API}?${new URLSearchParams({ format: "json", origin: "*", ...p })}`;
  const e = (await json(fetchFn, q({ action: "wbgetentities", ids: qid, props: "labels|aliases|claims", languages: "en|nl|de|fr|mul", languagefallback: "1" }))).entities?.[qid];
  const ids = (p) => (e?.claims?.[p] ?? []).map((c) => c.mainsnak?.datavalue?.value).filter(Boolean);
  const employerIds = ids("P108").map((v) => v.id).filter(Boolean);
  const emp = employerIds.length ? (await json(fetchFn, q({ action: "wbgetentities", ids: employerIds.slice(0, 50).join("|"), props: "labels|aliases", languages: "en|nl|de|fr|mul", languagefallback: "1" }))).entities ?? {} : {};
  const employers = employerIds.map((id) => ({ id, label: emp[id]?.labels?.en?.value ?? Object.values(emp[id]?.labels ?? {})[0]?.value ?? id, names: [...Object.values(emp[id]?.labels ?? {}), ...Object.values(emp[id]?.aliases ?? {}).flat()].map((x) => x.value) }));
  const labels = Object.values(e?.labels ?? {}).map((x) => x.value);
  const aliases = Object.values(e?.aliases ?? {}).flat().map((x) => x.value);
  return { qid, label: e?.labels?.en?.value ?? labels[0] ?? qid, names: [...new Set([...labels, ...aliases])], employers, orcid: ids("P496"), openalex: ids("P10283") };
}

/**
 * Candidate profiles for a person: [{ name, orcid, openalex, works, institutions, sameName, sharedEmployers,
 * likely, onWikidata: [{qid, property}] }], most likely first.
 */
export async function profileCandidates(fetchFn, person) {
  const names = new Set(person.names.map(norm));
  const employerNames = person.employers.map((e) => ({ id: e.id, label: e.label, names: new Set(e.names.map(norm)) }));
  const byKey = new Map();
  const add = (c) => {
    const key = c.orcid ?? c.openalex;
    const prev = byKey.get(key) ?? (c.orcid && [...byKey.values()].find((x) => x.orcid === c.orcid));
    if (prev) { prev.openalex ??= c.openalex; prev.works ??= c.works; for (const i of c.institutions) if (!prev.institutions.includes(i)) prev.institutions.push(i); return; }
    byKey.set(key, c);
  };
  const [oa, orcid] = await Promise.all([
    json(fetchFn, `https://api.openalex.org/authors?${new URLSearchParams({ search: person.label, per_page: "10" })}`).catch(() => null),
    json(fetchFn, `https://pub.orcid.org/v3.0/expanded-search/?${new URLSearchParams({ rows: "10", q: `given-and-family-names:"${person.label.replace(/"/g, "")}"` })}`, { headers: { Accept: "application/json" } }).catch(() => null),
  ]);
  for (const a of oa?.results ?? []) {
    const insts = [...(a.last_known_institutions ?? []), ...(a.affiliations ?? []).map((x) => x.institution)].map((i) => i?.display_name).filter(Boolean);
    add({ name: a.display_name, altNames: a.display_name_alternatives ?? [], orcid: a.orcid?.replace("https://orcid.org/", "") ?? null, openalex: a.id.split("/").pop(), works: a.works_count, institutions: [...new Set(insts)] });
  }
  for (const r of orcid?.["expanded-result"] ?? []) {
    add({ name: [r["given-names"], r["family-names"]].filter(Boolean).join(" "), altNames: r["other-name"] ?? [], orcid: r["orcid-id"], openalex: null, works: null, institutions: r["institution-name"] ?? [] });
  }
  const list = [...byKey.values()];
  for (const c of list) {
    c.sameName = [c.name, ...c.altNames].some((n) => names.has(norm(n)));
    const insts = c.institutions.map(norm);
    c.sharedEmployers = employerNames.filter((e) => insts.some((i) => e.names.has(i) || [...e.names].some((n) => n.length > 8 && (i.includes(n) || n.includes(i))))).map((e) => e.label);
    c.likely = c.sameName && c.sharedEmployers.length > 0;
  }
  // Profiles that already sit on another Wikidata item belong to someone else (or to a duplicate item).
  const pairs = list.flatMap((c) => [c.orcid && { property: "P496", value: c.orcid }, c.openalex && { property: "P10283", value: c.openalex }]).filter(Boolean);
  const hits = pairs.length ? await findByStatementsLive(fetchFn, pairs).catch(() => []) : [];
  for (const c of list) c.onWikidata = hits.filter((h) => h.qid !== person.qid && ((h.property === "P496" && h.value === c.orcid) || (h.property === "P10283" && String(h.value).toUpperCase() === c.openalex))).map((h) => ({ qid: h.qid, property: h.property }));
  const score = (c) => (c.likely ? 4 : 0) + (c.sameName ? 2 : 0) + (c.sharedEmployers.length ? 1 : 0) - (c.onWikidata.length ? 5 : 0);
  return list.filter((c) => c.sameName || c.sharedEmployers.length).sort((a, b) => score(b) - score(a) || (b.works ?? 0) - (a.works ?? 0));
}

/** QuickStatements adding a profile's ORCID and OpenAlex IDs to the item, citing where they were found. */
export function profileCommands(qid, c, { today = new Date().toISOString().slice(0, 10), has = { orcid: [], openalex: [] } } = {}) {
  const date = `S813\t+${today}T00:00:00Z/11`;
  const lines = [];
  // OpenAlex states the ORCID when it has one; otherwise the ORCID record itself is the source.
  if (c.orcid && !has.orcid.includes(c.orcid)) lines.push(`${qid}\tP496\t"${clean(c.orcid)}"\t` + (c.openalex ? `S248\t${OPENALEX}\tS854\t"https://openalex.org/${c.openalex}"` : `S248\t${ORCID}\tS854\t"https://orcid.org/${clean(c.orcid)}"`) + `\t${date}`);
  if (c.openalex && !has.openalex.includes(c.openalex)) lines.push(`${qid}\tP10283\t"${clean(c.openalex)}"\tS248\t${OPENALEX}\tS854\t"https://openalex.org/${c.openalex}"\t${date}`);
  return lines.join("\n");
}
