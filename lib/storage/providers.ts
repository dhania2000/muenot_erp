/**
 * SPEC 26 — Customer-owned storage: provider catalog.
 * ---------------------------------------------------------------------------
 * A single source of truth describing every storage backend a tenant can
 * connect. All S3-compatible providers share ONE implementation (lib/storage/s3.ts)
 * and differ only in this metadata (default region, whether an endpoint is
 * required, whether path-style addressing is needed, etc.). Adding a new
 * S3-compatible vendor is a one-entry change here.
 *
 * This module is intentionally free of `server-only` and Node imports so it can
 * be shared with the client settings UI (labels, field requirements) and unit
 * tested in isolation.
 */

export type StorageProviderId =
  | "vercel_blob"
  | "aws_s3"
  | "cloudflare_r2"
  | "wasabi"
  | "backblaze_b2"
  | "digitalocean_spaces"
  | "minio"
  | "s3_compatible"

/** Which credential/config fields a provider needs from the customer. */
export type ProviderFieldRequirement = "required" | "optional" | "hidden"

export type ProviderDefinition = {
  id: StorageProviderId
  label: string
  /** Short customer-facing description. */
  description: string
  /** True for every backend that speaks the S3 API (all except Vercel Blob). */
  s3Compatible: boolean
  /** MinIO / self-hosted need path-style addressing (bucket in the path). */
  forcePathStyle: boolean
  /** A sensible default region when the vendor uses a fixed/implicit one. */
  defaultRegion?: string
  /** Whether the customer must supply a custom S3 endpoint URL. */
  endpoint: ProviderFieldRequirement
  /** Whether a region value is meaningful for this provider. */
  region: ProviderFieldRequirement
  /** Placeholder shown for the endpoint field, guiding correct format. */
  endpointPlaceholder?: string
}

export const PROVIDERS: Record<StorageProviderId, ProviderDefinition> = {
  vercel_blob: {
    id: "vercel_blob",
    label: "Vercel Blob (default)",
    description: "Managed storage provided by the platform. No configuration required.",
    s3Compatible: false,
    forcePathStyle: false,
    endpoint: "hidden",
    region: "hidden",
  },
  aws_s3: {
    id: "aws_s3",
    label: "Amazon S3",
    description: "Amazon Web Services S3 buckets.",
    s3Compatible: true,
    forcePathStyle: false,
    defaultRegion: "us-east-1",
    endpoint: "optional",
    region: "required",
    endpointPlaceholder: "https://s3.us-east-1.amazonaws.com (leave blank for default)",
  },
  cloudflare_r2: {
    id: "cloudflare_r2",
    label: "Cloudflare R2",
    description: "Cloudflare R2 object storage (zero egress fees).",
    s3Compatible: true,
    forcePathStyle: false,
    defaultRegion: "auto",
    endpoint: "required",
    region: "optional",
    endpointPlaceholder: "https://<accountid>.r2.cloudflarestorage.com",
  },
  wasabi: {
    id: "wasabi",
    label: "Wasabi",
    description: "Wasabi hot cloud storage.",
    s3Compatible: true,
    forcePathStyle: false,
    defaultRegion: "us-east-1",
    endpoint: "required",
    region: "required",
    endpointPlaceholder: "https://s3.us-east-1.wasabisys.com",
  },
  backblaze_b2: {
    id: "backblaze_b2",
    label: "Backblaze B2",
    description: "Backblaze B2 cloud storage (S3-compatible API).",
    s3Compatible: true,
    forcePathStyle: false,
    defaultRegion: "us-west-004",
    endpoint: "required",
    region: "required",
    endpointPlaceholder: "https://s3.us-west-004.backblazeb2.com",
  },
  digitalocean_spaces: {
    id: "digitalocean_spaces",
    label: "DigitalOcean Spaces",
    description: "DigitalOcean Spaces object storage.",
    s3Compatible: true,
    forcePathStyle: false,
    defaultRegion: "nyc3",
    endpoint: "required",
    region: "required",
    endpointPlaceholder: "https://nyc3.digitaloceanspaces.com",
  },
  minio: {
    id: "minio",
    label: "MinIO (self-hosted)",
    description: "Self-hosted MinIO or any S3 gateway using path-style addressing.",
    s3Compatible: true,
    forcePathStyle: true,
    defaultRegion: "us-east-1",
    endpoint: "required",
    region: "optional",
    endpointPlaceholder: "https://minio.your-domain.com",
  },
  s3_compatible: {
    id: "s3_compatible",
    label: "Other S3-compatible",
    description: "Any other storage that implements the S3 API.",
    s3Compatible: true,
    forcePathStyle: false,
    defaultRegion: "us-east-1",
    endpoint: "required",
    region: "optional",
    endpointPlaceholder: "https://s3.your-provider.com",
  },
}

export const PROVIDER_LIST: ProviderDefinition[] = Object.values(PROVIDERS)

export function isStorageProviderId(value: string): value is StorageProviderId {
  return value in PROVIDERS
}

export function getProviderDefinition(id: string): ProviderDefinition | null {
  return isStorageProviderId(id) ? PROVIDERS[id] : null
}

/** Whether the provider stores objects behind the S3 API. */
export function isS3Provider(id: string): boolean {
  return getProviderDefinition(id)?.s3Compatible ?? false
}

/**
 * SPEC 27 — Server-side encryption at the object-storage layer.
 * ---------------------------------------------------------------------------
 * Independent of the at-rest encryption we apply to stored SECRETS. This tells
 * the S3 backend how each uploaded OBJECT should be encrypted server-side:
 *   - none    → rely on the bucket's default encryption policy (no header set)
 *   - AES256  → SSE-S3, S3-managed keys
 *   - aws:kms → SSE-KMS, AWS KMS-managed keys (bucket/account default CMK)
 */
export type ServerSideEncryptionMode = "none" | "AES256" | "aws:kms"

export const ENCRYPTION_OPTIONS: {
  value: ServerSideEncryptionMode
  label: string
  description: string
}[] = [
  { value: "none", label: "Bucket default", description: "Use whatever encryption the bucket enforces (no header sent)." },
  { value: "AES256", label: "SSE-S3 (AES-256)", description: "Server-side encryption with S3-managed keys." },
  { value: "aws:kms", label: "SSE-KMS", description: "Server-side encryption with the bucket's default AWS KMS key." },
]

const ENCRYPTION_VALUES = new Set<string>(ENCRYPTION_OPTIONS.map((o) => o.value))

export function isEncryptionMode(value: string): value is ServerSideEncryptionMode {
  return ENCRYPTION_VALUES.has(value)
}

export function normalizeEncryption(value: string | null | undefined): ServerSideEncryptionMode {
  return value && isEncryptionMode(value) ? value : "none"
}
