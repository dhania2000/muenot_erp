/**
 * SPEC 20 (req #75) — OPTIONAL model scoring (pure), behind a feature flag.
 * ---------------------------------------------------------------------------
 * Explainable rules are the source of truth. When a tenant opts into model
 * scoring (feature flag resolved in service.ts), this layer ENRICHES each
 * rule-based Finding with a blended model score and records WHY — it never
 * silences a rule finding and never makes an automatic decision. A blended
 * score can raise severity (surface a subtle case) but the alert is still born
 * "open" and always requires human review.
 *
 * The default scorer is a transparent heuristic (no network, deterministic) so
 * the feature works with zero external dependencies. A real model provider can
 * be injected via the `scorer` argument without changing callers.
 */

import { round, severityFromScore, type Finding } from "./model"

export type FindingScorer = (finding: Finding) => { modelScore: number; features: Record<string, number> }

/**
 * Transparent default: derive a few normalized features from the finding's own
 * evidence and combine them logistically. Deterministic and explainable — the
 * contributing features are attached to the finding's evidence.
 */
export const heuristicScorer: FindingScorer = (finding) => {
  const ev = finding.evidence ?? {}
  const z = Number((ev as any).robustZ ?? 0)
  const center = Number((ev as any).baselineCenter ?? 0)
  const observed = Number((ev as any).observedValue ?? finding.observedValue ?? 0)
  const ratio = center > 0 ? observed / center : 1

  const features = {
    // Steepness of the statistical deviation.
    zFeature: round(clamp01(Math.abs(z) / 10), 4),
    // How many times larger than baseline the observation is.
    ratioFeature: round(clamp01((ratio - 1) / 9), 4),
    // The rule score itself, as a prior.
    ruleScore: round(finding.score, 4),
  }

  // Weighted logistic blend of the features.
  const linear = -1.2 + 3.0 * features.zFeature + 2.5 * features.ratioFeature + 1.5 * features.ruleScore
  const modelScore = round(clamp01(1 / (1 + Math.exp(-linear))), 4)
  return { modelScore, features }
}

/**
 * Apply model scoring to findings. Blends the model score with the rule score
 * (max, so the model can only escalate, never hide) and marks the finding's
 * method as "model" with the contributing features recorded for explainability.
 */
export function scoreFindings(findings: Finding[], scorer: FindingScorer = heuristicScorer): Finding[] {
  return findings.map((f) => {
    const { modelScore, features } = scorer(f)
    const blended = round(Math.max(f.score, modelScore), 4)
    return {
      ...f,
      score: blended,
      severity: severityFromScore(blended),
      method: "model",
      evidence: {
        ...f.evidence,
        model: { ruleScore: f.score, modelScore, blendedScore: blended, features, blend: "max(rule, model)" },
      },
    }
  })
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}
