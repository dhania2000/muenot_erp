// Turn `pnpm audit --json` output into an actionable Markdown report.
//
//   pnpm audit --prod --json > audit.json; node scripts/ci/audit-report.mjs audit.json
//
// Fails (exit 1) when any advisory is at or above AUDIT_FAIL_LEVEL
// (default: high). Lower severities are listed but do not block.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"

const LEVELS = ["info", "low", "moderate", "high", "critical"]
const failAt = LEVELS.indexOf(process.env.AUDIT_FAIL_LEVEL ?? "high")
const raw = readFileSync(process.argv[2] ?? "audit.json", "utf8")
const data = JSON.parse(raw || "{}")
const advisories = Object.values(data.advisories ?? {})

advisories.sort((a, b) => LEVELS.indexOf(b.severity) - LEVELS.indexOf(a.severity))
const blocking = advisories.filter((a) => LEVELS.indexOf(a.severity) >= failAt)

const out = [`## Dependency audit`, ``]
if (!advisories.length) {
  out.push(`No known vulnerabilities in production dependencies.`)
} else {
  out.push(`${advisories.length} advisories, ${blocking.length} at or above \`${LEVELS[failAt]}\` (blocking).`, ``)
  out.push(`| Severity | Package | Vulnerable | Fix | Path | Advisory |`, `|---|---|---|---|---|---|`)
  for (const a of advisories) {
    const path = a.findings?.[0]?.paths?.[0] ?? ""
    const fix = a.patched_versions && a.patched_versions !== "<0.0.0" ? `upgrade to \`${a.patched_versions}\`` : "no patch — replace or accept"
    out.push(`| ${a.severity} | \`${a.module_name}\` | \`${a.vulnerable_versions}\` | ${fix} | \`${path}\` | [${a.github_advisory_id ?? a.id}](${a.url}) |`)
  }
  out.push(``, `Fix direct dependencies with \`pnpm up <pkg>\`; for transitive ones add a \`pnpm.overrides\` entry in package.json.`)
}
const text = out.join("\n")
writeFileSync("audit-report.md", `${text}\n`)
console.log(text)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
process.exit(blocking.length ? 1 : 0)
