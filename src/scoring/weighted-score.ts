import {
  SEVERITY_WEIGHTS,
  CRITICAL_CAP,
  HIGH_CAP,
  categoryForIssueType,
  isSiteLevelIssueType,
  type ScoreCategory,
  type Severity,
} from "./weights";

/** One open issue type's aggregate, as fed to the scorer (P1.2). */
export interface IssueAggregate {
  issueType: string;
  severity: Severity;
  /** Distinct scored pages this issue type affects (ignored for site-level). */
  affectedPages: number;
}

/** A single deduction, surfaced for the "How is this calculated?" breakdown. */
export interface Deduction {
  issueType: string;
  category: ScoreCategory;
  severity: Severity;
  affectedPages: number;
  scoredPages: number;
  share: number; // 0..1
  penalty: number; // points removed
  siteLevel: boolean;
}

export type CapSeverity = "critical" | "high" | null;

export interface WeightedScore {
  overall: number;
  categories: Record<ScoreCategory, number>;
  deductions: Deduction[];
  capped: CapSeverity;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Severity × volume score (P1.2):
 *   share   = site/template ? 1 : min(1, affectedPages / scoredPages)
 *   penalty = W[severity] × sqrt(share)   (a few pages still matter; diminishing after)
 *   score   = clamp(100 − Σ penalty), then cap: any critical → ≤79, any high → ≤89
 * Each check contributes at most W[severity] (sqrt(share) ≤ 1), so one noisy check
 * can't sink the score. Category scores use the same formula over that category's
 * checks only.
 */
export function computeWeightedScore(
  aggregates: IssueAggregate[],
  scoredPages: number,
): WeightedScore {
  const deductions: Deduction[] = [];
  let hasCritical = false;
  let hasHigh = false;

  for (const agg of aggregates) {
    const siteLevel = isSiteLevelIssueType(agg.issueType);
    const share = siteLevel
      ? 1
      : scoredPages <= 0
        ? 0
        : Math.min(1, agg.affectedPages / scoredPages);
    if (share <= 0) continue;
    const weight = SEVERITY_WEIGHTS[agg.severity] ?? 0;
    const penalty = weight * Math.sqrt(share);
    if (agg.severity === "critical") hasCritical = true;
    if (agg.severity === "high") hasHigh = true;
    deductions.push({
      issueType: agg.issueType,
      category: categoryForIssueType(agg.issueType),
      severity: agg.severity,
      affectedPages: siteLevel ? scoredPages : agg.affectedPages,
      scoredPages,
      share,
      penalty,
      siteLevel,
    });
  }

  // Overall = 100 − all penalties.
  const totalPenalty = deductions.reduce((s, d) => s + d.penalty, 0);
  const capped: CapSeverity = hasCritical ? "critical" : hasHigh ? "high" : null;
  let overall = clamp(100 - totalPenalty);
  if (capped === "critical") overall = Math.min(overall, CRITICAL_CAP);
  else if (capped === "high") overall = Math.min(overall, HIGH_CAP);

  // Per-category = 100 − that category's penalties.
  const categories: Record<ScoreCategory, number> = {
    technical: 100,
    content: 100,
    media: 100,
    aeo: 100,
  };
  for (const cat of Object.keys(categories) as ScoreCategory[]) {
    const catPenalty = deductions
      .filter((d) => d.category === cat)
      .reduce((s, d) => s + d.penalty, 0);
    categories[cat] = clamp(100 - catPenalty);
  }

  // Biggest deductions first — this is the "why" shown to users.
  deductions.sort((a, b) => b.penalty - a.penalty);

  return { overall, categories, deductions, capped };
}
