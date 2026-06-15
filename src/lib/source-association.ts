// Cross-source association for Phase 1 grouping. v0.5.
//
// Builds a WEIGHTED edge graph (not boolean merge rule) between input items
// so Phase 1 receives soft hints about which items likely describe the same
// study. Codex amended-plan P0 #2 + #3: hard pre-association forces the
// model to preserve bad merges; soft hints leave room to override on
// content contradiction.
//
// Scoring:
//   +10  exact shared NCT id (NCT12345678)
//   +3   exact normalized trial acronym appearing in 2+ items
//        (acronym whitelist filters out genes/endpoints/cohort labels)
//   +0   single-occurrence acronym (ignored)
//
// Output: array of association groups. Each group has slug-friendly id,
// item ids in the group, reason string, and strength (sum of weights).
// Phase 1 prompt receives groups as soft hints; model decides actual
// clustering.

import type { DigestInputItem, DigestInputTweet, DigestInputPaper, DigestInputSlide } from './llm-pipeline.ts';

export type AssociationGroup = {
  group_id: string;
  item_ids: number[]; // synthetic ids (matches the pipeline's tweet_id namespace)
  reason: string;
  strength: number;
};

// Acronyms that are NOT trial names — common shorthand that would over-merge
// if treated as identifiers. Expand as false positives appear in real data.
const ACRONYM_BLACKLIST = new Set([
  // Endpoints
  'OS', 'PFS', 'DFS', 'MFS', 'BFS', 'BFFS', 'BPFS', 'CFFS', 'CPFS', 'EFS',
  'ORR', 'CR', 'PR', 'SD', 'DOR', 'DCR', 'DCB', 'TTR', 'TTP',
  // Statistics
  'HR', 'OR', 'RR', 'CI', 'CIF', 'KM', 'NS',
  // Settings / disease shorthand
  'RT', 'CT', 'PET', 'CT-PET', 'MRI', 'BCS', 'BCT', 'WBI', 'PBI', 'APBI',
  'SBRT', 'EBRT', 'IMRT', 'VMAT', 'IGRT', 'WPRT', 'SRT',
  'ADT', 'ARSI', 'IO', 'TKI', 'PARP', 'CDK', 'CAR-T', 'BTK',
  'HER2', 'ER', 'PR', 'PD-L1', 'TMB', 'MSI', 'BRCA', 'TP53', 'EGFR', 'ALK', 'ROS1',
  'TROP2', 'PSMA', 'CTLA-4', 'PD-1',
  // Grades / scales
  'AE', 'SAE', 'TRAE', 'CR', 'PR', 'SD', 'PD',
  // Generic
  'NCT', 'PMID', 'DOI', 'PMC', 'OS', 'NSCLC', 'CRC', 'HCC', 'mCRPC', 'mUC', 'BCM',
  'ITT', 'PP', 'PPS', 'FAS', 'mITT', 'ECOG', 'KPS', 'AJCC', 'TNM',
  // Time units / abbreviations
  'YR', 'MO', 'WK', 'FX', 'FFS',
]);

// Trial-acronym pattern: 3-12 chars, all caps with optional digits/hyphens.
// Conservative — only exact uppercase tokens. False-positive rate is the
// dominant concern (codex P0 #2: over-merge destroys trust).
const ACRONYM_RE = /\b[A-Z][A-Z0-9]{2,}(?:-[A-Z0-9]+)*\b/g;
const NCT_RE = /\bNCT\d{8}\b/g;

// Staging / grade / version shorthand that carries a digit — so the "must have a
// digit or hyphen" trial-bias check below lets it through — but is NOT a trial
// name: FIGO3, PHASE3, GRADE3, WHO2, ECOG1, COVID19. Pattern-based so we don't
// enumerate every numeric suffix. Two such tokens shared across unrelated items
// would otherwise produce a spurious medium-strength merge hint.
const ACRONYM_PATTERN_BLACKLIST =
  /^(?:(?:FIGO|PHASE|GRADE|WHO|ECOG|RECIST|ASA|NYHA|BCLC|ISUP|AJCC|TNM|KPS)\d+|COVID-?19)$/;

export function buildAssociationGraph(items: DigestInputItem[]): AssociationGroup[] {
  const groups: AssociationGroup[] = [];
  const itemTexts = items.map((i) => ({ id: itemId(i), text: itemTextForExtraction(i) }));

  // NCT-based grouping (strong)
  const nctIndex = new Map<string, number[]>();
  for (const { id, text } of itemTexts) {
    const matches = new Set<string>();
    for (const m of text.matchAll(NCT_RE)) matches.add(m[0]!);
    for (const nct of matches) {
      const arr = nctIndex.get(nct) ?? [];
      if (!arr.includes(id)) arr.push(id);
      nctIndex.set(nct, arr);
    }
  }
  for (const [nct, idList] of nctIndex) {
    if (idList.length >= 2) {
      groups.push({
        group_id: nct.toLowerCase(),
        item_ids: [...idList].sort((a, b) => a - b),
        reason: `shared ${nct}`,
        strength: 10,
      });
    }
  }

  // Acronym-based grouping (medium)
  const acronymIndex = new Map<string, number[]>();
  for (const { id, text } of itemTexts) {
    const matches = new Set<string>();
    for (const m of text.matchAll(ACRONYM_RE)) {
      const acr = m[0]!;
      if (ACRONYM_BLACKLIST.has(acr)) continue;
      if (ACRONYM_PATTERN_BLACKLIST.test(acr)) continue; // FIGO3 / PHASE3 / COVID19, not a trial
      // Require at least one digit or a hyphen to bias toward trial names
      // like "PRESTIGE-PSMA" or "EORTC22922" and away from gene shorthand.
      // This is heuristic — false-positive cost dominates.
      if (!/\d/.test(acr) && !acr.includes('-')) continue;
      matches.add(acr);
    }
    for (const acr of matches) {
      const arr = acronymIndex.get(acr) ?? [];
      if (!arr.includes(id)) arr.push(id);
      acronymIndex.set(acr, arr);
    }
  }
  for (const [acr, idList] of acronymIndex) {
    if (idList.length >= 2) {
      // Skip if these items are already in an NCT group together — NCT is
      // strictly more informative.
      const alreadyGrouped = groups.some(
        (g) => idList.every((x) => g.item_ids.includes(x)),
      );
      if (alreadyGrouped) continue;
      groups.push({
        group_id: acr.toLowerCase(),
        item_ids: [...idList].sort((a, b) => a - b),
        reason: `shared acronym ${acr}`,
        strength: 3,
      });
    }
  }

  return groups;
}

// Returns the synthetic id the pipeline uses internally. Tweets pass through;
// papers and slides need their offsets applied.
function itemId(i: DigestInputItem): number {
  if (!i.source_type || i.source_type === 'tweet') return (i as DigestInputTweet).id;
  if (i.source_type === 'paper') return 1_000_000_000 + (i as DigestInputPaper).id;
  return 2_000_000_000 + (i as DigestInputSlide).id;
}

// The text we search for NCT / acronym matches. Pulls from item-specific
// fields to maximize signal.
function itemTextForExtraction(i: DigestInputItem): string {
  if (!i.source_type || i.source_type === 'tweet') {
    const t = i as DigestInputTweet;
    return [t.text, ...(t.image_ocr_texts ?? [])].join(' ');
  }
  if (i.source_type === 'paper') {
    const p = i as DigestInputPaper;
    return [p.title, p.abstract ?? '', p.fulltext_excerpt_md ?? '', (p.mesh_terms ?? []).join(' ')].join(
      ' ',
    );
  }
  const s = i as DigestInputSlide;
  return [s.ocr_text ?? '', s.source_label ?? ''].join(' ');
}

// Render association groups as a soft-hint string for inclusion in the
// Phase 1 prompt. Groups are advisory: the model may cluster differently
// if content disagrees.
export function renderGroupsForPrompt(groups: AssociationGroup[]): string {
  if (groups.length === 0) return 'No pre-computed associations found.';
  const lines: string[] = ['ASSOCIATION HINTS (soft — override on content contradiction):'];
  for (const g of groups) {
    const strengthLabel = g.strength >= 10 ? 'STRONG' : g.strength >= 3 ? 'medium' : 'weak';
    lines.push(`  [${strengthLabel}] ${g.reason} → items: ${g.item_ids.join(', ')}`);
  }
  return lines.join('\n');
}
