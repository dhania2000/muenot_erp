// Typecheck gate with a per-file ratchet.
//
//   node scripts/ci/typecheck-ratchet.mjs            check against baseline
//   node scripts/ci/typecheck-ratchet.mjs --update   rewrite baseline (only after fixing errors)
//
// `main` carries pre-existing TypeScript errors (next.config sets
// ignoreBuildErrors). A plain `tsc` gate would be permanently red, so instead
// every file's error count is capped at its baseline: new files must be
// clean, touched files may not get worse, and fixes are locked in by
// --update. Delete the baseline once it reaches zero and gate on plain tsc.
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"

const BASELINE = "scripts/ci/typecheck-baseline.json"
const update = process.argv.includes("--update")

const run = spawnSync("node", ["--max-old-space-size=6144", "node_modules/typescript/bin/tsc", "--noEmit", "--pretty", "false", "-p", "."], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
if (run.error) throw run.error
const output = `${run.stdout}${run.stderr}`
if (run.status !== 0 && !/error TS\d+/.test(output)) {
  console.error(output)
  console.error("tsc failed without reporting diagnostics (crash or OOM).")
  process.exit(2)
}

const byFile = {}
const lines = {}
for (const line of output.split("\n")) {
  const m = line.match(/^(.+?)\(\d+,\d+\): error TS\d+/)
  if (!m) continue
  const file = m[1].replaceAll("\\", "/")
  byFile[file] = (byFile[file] ?? 0) + 1
  ;(lines[file] ??= []).push(line)
}
const total = Object.values(byFile).reduce((a, b) => a + b, 0)

if (update) {
  const sorted = Object.fromEntries(Object.entries(byFile).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`)
  console.log(`Baseline written: ${total} errors in ${Object.keys(sorted).length} files.`)
  process.exit(0)
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {}
const regressions = Object.entries(byFile).filter(([f, n]) => n > (baseline[f] ?? 0))
const improved = Object.entries(baseline).filter(([f, n]) => (byFile[f] ?? 0) < n)
const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0)

const report = [`## Typecheck`, ``, `${total} errors (baseline ${baselineTotal}).`, ``]
if (regressions.length) {
  report.push(`### New errors (fix these)`, ``)
  for (const [f, n] of regressions) {
    report.push(`- \`${f}\`: ${n} (baseline ${baseline[f] ?? 0})`)
  }
  report.push(``, "```", ...regressions.flatMap(([f]) => lines[f]), "```")
}
if (improved.length) {
  report.push(``, `${improved.length} file(s) improved — run \`pnpm typecheck:baseline\` and commit to lock in.`)
}
const text = report.join("\n")
console.log(text)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
for (const [f] of regressions) {
  for (const l of lines[f]) {
    const m = l.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/)
    if (m && process.env.GITHUB_ACTIONS) console.log(`::error file=${m[1]},line=${m[2]},col=${m[3]},title=${m[4]}::${m[5]}`)
  }
}
process.exit(regressions.length ? 1 : 0)
