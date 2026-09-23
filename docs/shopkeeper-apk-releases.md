# Shopkeeper self-hosted Android releases

The ERP owns release metadata and approval, not APK signing or Android installation. The separate `muenot_erp_shopkeeper` repository builds and signs the APK. Customers download it over HTTPS and the normal Android package installer handles installation. No Play Store or EAS Update is involved.

## Operator process

1. Build and sign the Android APK in the mobile project, using a protected signing key outside this repository. Test it internally. Do not ship a debug APK.
2. Check the Android `versionCode` is a new positive integer greater than previous releases. Do not rely on the human-readable `versionName` for ordering.
3. Upload the signed file to a trusted HTTPS object store/CDN or website download host under a **versioned, immutable `.apk` path**. Do not overwrite or delete older artifacts. Configure `Content-Type: application/vnd.android.package-archive`, the actual `Content-Length`, HTTPS, no directory listing, and no credential-bearing URL/query string. The ERP does not currently upload or proxy APK bytes; its tenant-owned storage system is not appropriate for platform-wide public executables.
4. Calculate the file size in bytes and SHA-256 from the final hosted APK. On Windows: `Get-FileHash -Algorithm SHA256 'C:\path\to\muenot-shopkeeper-1.0.1.apk'` and `(Get-Item 'C:\path\to\muenot-shopkeeper-1.0.1.apk').Length`. Verify the hosted bytes match. The ERP validates metadata format but cannot prove external object contents or Android signing identity.
5. In Platform → Mobile App · Releases, create a draft with version name/code, minimum supported version code, immutable HTTPS APK URL, byte size, SHA-256, release notes and force-update policy. A draft may be incomplete; it is never publicly returned.
6. Verify the URL downloads the expected signed APK and the SHA-256 matches. Human review is mandatory. Press Publish as a Platform Super Admin. Git push alone never publishes a customer update.
7. If a bad release is discovered, unpublish it. The version API then selects the highest *remaining* valid published version code after at most 30 seconds of public cache. This cannot remotely uninstall or downgrade an already-installed higher version code. Normally publish a fixed APK with a **higher** version code.

`MOBILE_APK_ALLOWED_HOSTS` is an optional server-side comma-separated allowlist of exact hostnames, e.g. `downloads.muenot.co.in,cdn.muenot.co.in`. Configure it in production to prevent accidental links to untrusted hosts. No APK upload credentials or signing secrets are needed by ERP for this metadata-only mode. The existing DB variables and platform authentication remain required. Apply `database/migrations/2026-09-23-mobile-app-releases.sql` through the normal DB deployment process; the service also creates the table if missing, following the repo's runtime schema convention.

## Public contract

`GET https://erp.muenot.co.in/api/mobile/v1/app-version` needs no login. It returns only the highest valid published `muenot-shopkeeper`/`android` release:

```json
{"platform":"android","latestVersion":"1.1.0","latestVersionCode":3,"minimumVersionCode":2,"forceUpdate":false,"apkUrl":"https://downloads.muenot.co.in/muenot-shopkeeper-1.1.0.apk","apkSize":48000000,"apkSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","releaseNotes":["Improved inbox"],"publishedAt":"2026-09-23T10:00:00.000Z"}
```

If no release is published, HTTP 404 with `code: "release_unavailable"`; HTTP 429 includes `Retry-After`; a database failure returns 503. Successful metadata is cacheable for 30 seconds. The website can consume this same endpoint for latest version, date, size, notes and download link. The mobile app must verify the downloaded file's SHA-256 and Android signing identity before offering installation; ERP does not bypass Android installer safeguards.

Exact update policy, in order:

1. Installed `versionCode >= latestVersionCode`: **no update** (even when `forceUpdate=true`). This prevents downgrade prompts after rollback.
2. Installed `versionCode < minimumVersionCode`: **mandatory**.
3. `forceUpdate=true` and installed code is older than latest: **mandatory**.
4. Otherwise older than latest: **optional**.

`versionName` is display-only. Android repository should consume `platform`, `latestVersion`, `latestVersionCode`, `minimumVersionCode`, `forceUpdate`, `apkUrl`, `apkSize`, `apkSha256`, `releaseNotes`, `publishedAt`. It should never connect to MySQL or expect signing secrets from this endpoint.

## Management API and audit

All management routes require the existing `platform_super_admin` role: `GET/POST /api/platform/mobile-app/releases`, `GET/PATCH /api/platform/mobile-app/releases/{id}`, and `POST /api/platform/mobile-app/releases/{id}/publication` with `{ "publish": true|false }`. Never-published drafts may be edited; metadata of a release that has *ever* been published remains immutable, even after unpublication. The DB enforces unique app/platform/version code and unique URL hash; publish/unpublish uses a row lock and is idempotent. Existing platform audit records creation, edit, publication, unpublication, and policy/metadata field changes without recording signing material.

Future CI can build/test/sign/upload an artifact and prepare a **draft** through a separately authorized workflow, but customer publication must remain a human Super Admin action. CI signing secrets belong in a secure CI secret store, never in Git or ordinary ERP configuration.
