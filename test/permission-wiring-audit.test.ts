import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  getPermissionModule,
  resolveFeatureSlug,
  PERMISSION_GROUPS,
} from "@/lib/permission-model"
import { SOD_DUTIES } from "@/lib/sod-registry"

/**
 * Permission WIRING audit.
 * ------------------------
 * The pure permission model is already pinned by permission-matrix.test.ts.
 * This suite pins the WIRING between the catalog and the two places that must
 * reference it correctly, so nothing is "missing" or "linked to the wrong
 * place":
 *
 *   1. lib/workspace-nav.tsx — every sidebar `feature:` slug must resolve to a
 *      real catalog module, and it must resolve INTO the group named by its own
 *      slug prefix (a `finance.*` link can never land on an HR module).
 *   2. lib/permission-enforce.ts — every value in the FINANCE / SUPPORT /
 *      RECRUITMENT permission-key maps must be a real catalog module key.
 *
 * Both files are read as text (they pull in `server-only`), so this stays a
 * pure, deterministic check.
 */

const root = resolve(__dirname, "..")

function readLib(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8")
}

function extractFeatureSlugs(src: string): string[] {
  const out = new Set<string>()
  const re = /feature:\s*"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) out.add(m[1])
  return [...out]
}

describe("workspace-nav feature slugs resolve into the correct catalog module", () => {
  const nav = readLib("lib/workspace-nav.tsx")
  const slugs = extractFeatureSlugs(nav)

  it("finds a non-trivial set of sidebar feature slugs", () => {
    expect(slugs.length).toBeGreaterThan(30)
  })

  it("resolves every sidebar feature slug to a real module in its own group", () => {
    const failures: string[] = []
    for (const slug of slugs) {
      const group = slug.split(".")[0]
      const resolved = resolveFeatureSlug(slug)
      if (!resolved) {
        failures.push(`${slug} → UNRESOLVED`)
        continue
      }
      const mod = getPermissionModule(resolved.moduleKey)
      if (!mod) {
        failures.push(`${slug} → missing module ${resolved.moduleKey}`)
        continue
      }
      if (mod.group !== group) {
        failures.push(`${slug} → ${resolved.moduleKey} in group "${mod.group}" (expected "${group}")`)
      }
    }
    expect(failures, `\n${failures.join("\n")}\n`).toEqual([])
  })
})

describe("permission-enforce key maps point at real catalog modules", () => {
  const enforce = readLib("lib/permission-enforce.ts")

  function extractMapValues(mapName: string): string[] {
    const start = enforce.indexOf(`export const ${mapName}`)
    if (start < 0) return []
    const open = enforce.indexOf("{", start)
    const close = enforce.indexOf("}", open)
    const body = enforce.slice(open + 1, close)
    const out = new Set<string>()
    const re = /:\s*"([^"]+)"/g
    let m: RegExpExecArray | null
    while ((m = re.exec(body))) out.add(m[1])
    return [...out]
  }

  for (const mapName of ["FINANCE_PERMISSION_KEYS", "SUPPORT_PERMISSION_KEYS", "RECRUITMENT_PERMISSION_KEYS"]) {
    it(`${mapName}: every value is a real catalog module key`, () => {
      const values = extractMapValues(mapName)
      expect(values.length).toBeGreaterThan(0)
      const bad = values.filter((v) => !getPermissionModule(v))
      expect(bad, `unknown module keys in ${mapName}: ${bad.join(", ")}`).toEqual([])
    })
  }
})

describe("SoD permission-signal duties resolve to real catalog modules", () => {
  // A create-side duty is detected from the user's effective permission matrix
  // (`type: "permission"`), so its moduleKey MUST be a real catalog module — a
  // typo would make the duty undetectable and silently disable the SoD conflict.
  // (The `approval`-signal moduleKeys are the separate approval-engine namespace
  // and are intentionally NOT asserted against the permission catalog.)
  it("every permission-signal moduleKey exists in the catalog", () => {
    const failures: string[] = []
    for (const duty of SOD_DUTIES) {
      if (duty.signal.type !== "permission") continue
      if (!getPermissionModule(duty.signal.moduleKey)) {
        failures.push(`${duty.key} → unknown module ${duty.signal.moduleKey}`)
      }
    }
    expect(failures, `\n${failures.join("\n")}\n`).toEqual([])
  })
})

describe("every permission group has a stable, unique slug", () => {
  it("has unique group slugs", () => {
    const slugs = PERMISSION_GROUPS.map((g) => g.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it("every module's group matches the group it is nested under", () => {
    const failures: string[] = []
    for (const g of PERMISSION_GROUPS) {
      for (const m of g.modules) {
        if (m.group !== g.slug) failures.push(`${m.key} declares group "${m.group}" but is nested under "${g.slug}"`)
      }
    }
    expect(failures, `\n${failures.join("\n")}\n`).toEqual([])
  })
})
