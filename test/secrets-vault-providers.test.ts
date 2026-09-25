import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  amzDates,
  signAwsRequest,
} from "@/lib/secrets/providers/aws-sigv4"
import { AwsSecretsManagerProvider, type AwsTransport } from "@/lib/secrets/providers/aws-secrets-manager"
import {
  AzureKeyVaultProvider,
  type AzureApiTransport,
  azureSecretName,
} from "@/lib/secrets/providers/azure-key-vault"
import { DatabaseVaultProvider } from "@/lib/secrets/providers/db-vault"
import {
  buildVaultProvider,
  configuredDefaultVaultKind,
  getDatabaseVault,
  isVaultConfigured,
} from "@/lib/secrets/providers"
import {
  classifyHealth,
  isServable,
  isVaultKind,
  selectVaultKind,
  VAULT_KINDS,
} from "@/lib/secrets/providers/types"

/**
 * Spec 9 — External secrets vault providers (#20-21, #115-117).
 *
 * The provider layer is the seam that lets a tenant secret live in AWS Secrets
 * Manager or Azure Key Vault while the encrypted DB vault stays as the
 * always-available fallback. These tests exercise it WITHOUT touching a real
 * cloud (every adapter transport is injected) and prove the invariants the
 * spec depends on:
 *   - the pure health/selection core classifies probes and picks a vault so an
 *     unusable external vault always collapses to the DB fallback;
 *   - each adapter fails CLOSED — a provider outage rejects/reports down rather
 *     than leaking or fabricating a value;
 *   - the env-driven factory only builds an external vault when fully
 *     configured, and the DB vault never needs config.
 */

const PLAINTEXT = "sk_live_super_secret_value"

// ---------------------------------------------------------------------------
// Pure core: health classification + vault selection
// ---------------------------------------------------------------------------

describe("provider pure core", () => {
  it("classifies a probe into a stable health state", () => {
    expect(classifyHealth(null)).toBe("unknown")
    expect(classifyHealth({ ok: true })).toBe("healthy")
    expect(classifyHealth({ ok: false, timedOut: true })).toBe("degraded")
    expect(classifyHealth({ ok: false })).toBe("down")
  })

  it("only healthy/degraded states are servable from an external vault", () => {
    expect(isServable("healthy")).toBe(true)
    expect(isServable("degraded")).toBe(true)
    expect(isServable("down")).toBe(false)
    expect(isServable("unknown")).toBe(false)
  })

  it("selectVaultKind honours an explicit usable external choice", () => {
    expect(selectVaultKind({ explicit: "aws_secrets_manager", externalUsable: true })).toBe("aws_secrets_manager")
  })

  it("selectVaultKind collapses an UNUSABLE external choice to db (outage safety)", () => {
    expect(selectVaultKind({ explicit: "aws_secrets_manager", externalUsable: false })).toBe("db")
    expect(selectVaultKind({ configuredDefault: "azure_key_vault", externalUsable: false })).toBe("db")
  })

  it("selectVaultKind falls back to the configured default, then db", () => {
    expect(selectVaultKind({ configuredDefault: "azure_key_vault", externalUsable: true })).toBe("azure_key_vault")
    expect(selectVaultKind({})).toBe("db")
    expect(selectVaultKind({ explicit: "db" })).toBe("db")
  })

  it("isVaultKind guards the union", () => {
    for (const k of VAULT_KINDS) expect(isVaultKind(k)).toBe(true)
    expect(isVaultKind("gcp")).toBe(false)
    expect(isVaultKind(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AWS SigV4 signer
// ---------------------------------------------------------------------------

describe("AWS SigV4 signer", () => {
  const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "SECRETEXAMPLEKEY" }
  const fixed = new Date("2026-06-01T12:00:00Z")

  it("emits deterministic UTC stamps", () => {
    const { amzDate, dateStamp } = amzDates(fixed)
    expect(amzDate).toBe("20260601T120000Z")
    expect(dateStamp).toBe("20260601")
  })

  it("produces a stable Authorization header for identical inputs", () => {
    const sign = () =>
      signAwsRequest(
        {
          method: "POST",
          host: "secretsmanager.us-east-1.amazonaws.com",
          region: "us-east-1",
          service: "secretsmanager",
          headers: { "content-type": "application/x-amz-json-1.1" },
          body: '{"MaxResults":1}',
          now: fixed,
        },
        creds,
      )
    const a = sign()
    const b = sign()
    expect(a.Authorization).toBe(b.Authorization)
    expect(a.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260601\/us-east-1\/secretsmanager\/aws4_request/)
    expect(a.Authorization).toContain("SignedHeaders=content-type;host;x-amz-date")
    expect(a["x-amz-date"]).toBe("20260601T120000Z")
  })

  it("signs and forwards a session token when present", () => {
    const headers = signAwsRequest(
      {
        method: "POST",
        host: "secretsmanager.us-east-1.amazonaws.com",
        region: "us-east-1",
        service: "secretsmanager",
        headers: {},
        body: "{}",
        now: fixed,
      },
      { ...creds, sessionToken: "SESSIONTOKEN" },
    )
    expect(headers["x-amz-security-token"]).toBe("SESSIONTOKEN")
    expect(headers.Authorization).toContain("x-amz-security-token")
  })

  it("a different body yields a different signature", () => {
    const base = {
      method: "POST",
      host: "secretsmanager.us-east-1.amazonaws.com",
      region: "us-east-1",
      service: "secretsmanager",
      headers: {},
      now: fixed,
    }
    const s1 = signAwsRequest({ ...base, body: "{}" }, creds).Authorization
    const s2 = signAwsRequest({ ...base, body: '{"x":1}' }, creds).Authorization
    expect(s1).not.toBe(s2)
  })
})

// ---------------------------------------------------------------------------
// AWS Secrets Manager adapter
// ---------------------------------------------------------------------------

describe("AWS Secrets Manager adapter", () => {
  const config = {
    region: "us-east-1",
    credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
    prefix: "muenot/",
  }
  const actionOf = (headers: Record<string, string>) => String(headers["x-amz-target"] ?? "").split(".").pop()

  it("writes a new version in place when the secret already exists", async () => {
    const seen: string[] = []
    const transport: AwsTransport = async ({ headers }) => {
      const action = actionOf(headers)!
      seen.push(action)
      return { status: 200, body: JSON.stringify({ VersionId: "v-2" }) }
    }
    const provider = new AwsSecretsManagerProvider(config, transport)
    const out = await provider.putSecret("stripe/secret_key", PLAINTEXT)
    expect(out.providerVersion).toBe("v-2")
    expect(seen).toEqual(["PutSecretValue"])
  })

  it("creates the secret when PutSecretValue reports it does not exist", async () => {
    const seen: string[] = []
    const transport: AwsTransport = async ({ headers }) => {
      const action = actionOf(headers)!
      seen.push(action)
      if (action === "PutSecretValue") {
        return { status: 400, body: JSON.stringify({ __type: "ResourceNotFoundException" }) }
      }
      return { status: 200, body: JSON.stringify({ VersionId: "v-1" }) }
    }
    const provider = new AwsSecretsManagerProvider(config, transport)
    const out = await provider.putSecret("stripe/secret_key", PLAINTEXT)
    expect(out.providerVersion).toBe("v-1")
    expect(seen).toEqual(["PutSecretValue", "CreateSecret"])
  })

  it("reads back the string value and its version", async () => {
    const transport: AwsTransport = async () => ({
      status: 200,
      body: JSON.stringify({ SecretString: PLAINTEXT, VersionId: "v-9" }),
    })
    const provider = new AwsSecretsManagerProvider(config, transport)
    const out = await provider.getSecret("stripe/secret_key")
    expect(out.value).toBe(PLAINTEXT)
    expect(out.providerVersion).toBe("v-9")
  })

  it("fails CLOSED on a not-found read (rejects, never returns a blank value)", async () => {
    const transport: AwsTransport = async () => ({
      status: 404,
      body: JSON.stringify({ __type: "ResourceNotFoundException" }),
    })
    const provider = new AwsSecretsManagerProvider(config, transport)
    await expect(provider.getSecret("stripe/secret_key")).rejects.toThrow()
  })

  it("probe is healthy when ListSecrets succeeds and never surfaces a plaintext", async () => {
    const transport: AwsTransport = async () => ({ status: 200, body: "{}" })
    const provider = new AwsSecretsManagerProvider(config, transport)
    const probe = await provider.probe()
    expect(probe.ok).toBe(true)
  })

  it("probe reports an outage (down) on an auth failure", async () => {
    const transport: AwsTransport = async () => ({ status: 403, body: JSON.stringify({ __type: "AccessDenied" }) })
    const provider = new AwsSecretsManagerProvider(config, transport)
    const probe = await provider.probe()
    expect(probe.ok).toBe(false)
    expect(classifyHealth(probe)).toBe("down")
    expect(probe.detail ?? "").not.toContain(PLAINTEXT)
  })
})

// ---------------------------------------------------------------------------
// Azure Key Vault adapter
// ---------------------------------------------------------------------------

describe("Azure Key Vault adapter", () => {
  const config = {
    vaultName: "my-vault",
    tenantId: "tid",
    clientId: "cid",
    clientSecret: "csecret",
  }
  const token = async () => "bearer-token"

  it("sanitizes refs to Azure's [0-9A-Za-z-] secret-name alphabet", () => {
    expect(azureSecretName("muenot/t7/stripe/secret_key")).toBe("muenot-t7-stripe-secret-key")
    expect(azureSecretName("///")).toBe("secret")
  })

  it("writes a secret and extracts the version from the returned id", async () => {
    const api: AzureApiTransport = async ({ url, method }) => {
      expect(method).toBe("PUT")
      expect(url).toContain("/secrets/muenot-t7-stripe-secret-key")
      return {
        status: 200,
        body: JSON.stringify({ id: "https://my-vault.vault.azure.net/secrets/muenot-t7-stripe-secret-key/abc123", value: PLAINTEXT }),
      }
    }
    const provider = new AzureKeyVaultProvider(config, api, token)
    const out = await provider.putSecret("muenot/t7/stripe/secret_key", PLAINTEXT)
    expect(out.providerVersion).toBe("abc123")
  })

  it("reads back the value and version", async () => {
    const api: AzureApiTransport = async () => ({
      status: 200,
      body: JSON.stringify({ id: "https://my-vault.vault.azure.net/secrets/x/ver9", value: PLAINTEXT }),
    })
    const provider = new AzureKeyVaultProvider(config, api, token)
    const out = await provider.getSecret("x")
    expect(out.value).toBe(PLAINTEXT)
    expect(out.providerVersion).toBe("ver9")
  })

  it("fails CLOSED when token acquisition fails (provider outage)", async () => {
    const failingToken = async () => {
      throw new Error("AAD token request failed")
    }
    const api: AzureApiTransport = async () => ({ status: 200, body: "{}" })
    const provider = new AzureKeyVaultProvider(config, api, failingToken)
    await expect(provider.getSecret("x")).rejects.toThrow()
    const probe = await provider.probe()
    expect(probe.ok).toBe(false)
    expect(classifyHealth(probe)).toBe("down")
  })

  it("probe is healthy when the data plane responds", async () => {
    const api: AzureApiTransport = async () => ({ status: 200, body: JSON.stringify({ value: [] }) })
    const provider = new AzureKeyVaultProvider(config, api, token)
    expect((await provider.probe()).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Encrypted DB vault (always-available fallback)
// ---------------------------------------------------------------------------

describe("encrypted DB vault adapter", () => {
  beforeEach(() => {
    process.env.SETTINGS_ENCRYPTION_KEY = "unit-test-master-key"
  })
  afterEach(() => {
    delete process.env.SETTINGS_ENCRYPTION_KEY
  })

  it("round-trips through an AES-256-GCM envelope and never stores plaintext", async () => {
    const vault = new DatabaseVaultProvider()
    const { providerVersion } = await vault.putSecret("", PLAINTEXT)
    expect(providerVersion.startsWith("sec:v1:")).toBe(true)
    expect(providerVersion).not.toContain(PLAINTEXT)
    const back = await vault.getSecret("", providerVersion)
    expect(back.value).toBe(PLAINTEXT)
  })

  it("reading requires the stored ciphertext (fails closed without it)", async () => {
    const vault = new DatabaseVaultProvider()
    await expect(vault.getSecret("", null)).rejects.toThrow()
  })

  it("probe is healthy whenever encryption is configured", async () => {
    expect((await new DatabaseVaultProvider().probe()).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Env-driven factory
// ---------------------------------------------------------------------------

describe("vault provider factory", () => {
  it("the DB vault is always constructible without config", () => {
    expect(getDatabaseVault().kind).toBe("db")
    expect(buildVaultProvider("db", {})).not.toBeNull()
    expect(isVaultConfigured("db", {})).toBe(true)
  })

  it("builds AWS only when the full credential set is present", () => {
    expect(buildVaultProvider("aws_secrets_manager", {})).toBeNull()
    const full = {
      SECRETS_AWS_REGION: "us-east-1",
      SECRETS_AWS_ACCESS_KEY_ID: "AKID",
      SECRETS_AWS_SECRET_ACCESS_KEY: "SECRET",
    } as any
    expect(buildVaultProvider("aws_secrets_manager", full)?.kind).toBe("aws_secrets_manager")
    expect(isVaultConfigured("aws_secrets_manager", { SECRETS_AWS_REGION: "us-east-1" } as any)).toBe(false)
  })

  it("builds Azure only when the full credential set is present", () => {
    expect(buildVaultProvider("azure_key_vault", {})).toBeNull()
    const full = {
      SECRETS_AZURE_VAULT_NAME: "v",
      SECRETS_AZURE_TENANT_ID: "t",
      SECRETS_AZURE_CLIENT_ID: "c",
      SECRETS_AZURE_CLIENT_SECRET: "s",
    } as any
    expect(buildVaultProvider("azure_key_vault", full)?.kind).toBe("azure_key_vault")
  })

  it("reads the configured default external vault kind from env", () => {
    expect(configuredDefaultVaultKind({ SECRETS_VAULT_PROVIDER: "aws_secrets_manager" } as any)).toBe("aws_secrets_manager")
    expect(configuredDefaultVaultKind({ SECRETS_VAULT_PROVIDER: "db" } as any)).toBeNull()
    expect(configuredDefaultVaultKind({} as any)).toBeNull()
    expect(configuredDefaultVaultKind({ SECRETS_VAULT_PROVIDER: "nonsense" } as any)).toBeNull()
  })
})
