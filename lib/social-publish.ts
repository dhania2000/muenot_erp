import type { SocialAccountRow } from "@/lib/social-accounts"
import { decryptToken } from "@/lib/token-crypto"

/**
 * Real publishing to connected social platforms using each account's stored
 * token. Text posts are supported everywhere the platform allows them
 * (LinkedIn, X, Facebook, Instagram-as-caption). Images are attached where the
 * platform accepts a binary upload (LinkedIn, Facebook). Instagram requires a
 * publicly hosted image URL — an in-browser data URL cannot be used, so that
 * case returns a clear error instead of silently failing.
 *
 * Facebook publishes through the Pages Graph API; Instagram publishes through
 * its OWN graph.instagram.com host (Instagram API with Instagram Login), not
 * the Facebook Graph. Tokens arrive encrypted and are decrypted here just
 * before the outbound API call.
 */

const GRAPH_VERSION = "v21.0"

export type PublishResult = {
  accountId: number
  platform: string
  handle: string
  ok: boolean
  permalink?: string
  /**
   * The id of the post AS IT LIVES ON THE PLATFORM (tweet id, LinkedIn ugcPost
   * urn, Facebook post id, Instagram media id). Stored so a later delete or
   * edit in the ERP can act on the real published post, not just our DB row.
   */
  remoteId?: string
  error?: string
}

/** What each platform publisher returns once a post is live. */
type PublishedRef = { permalink?: string; remoteId?: string }

/**
 * Outcome of propagating a delete or edit to a live platform post. `skipped`
 * marks platforms whose API cannot perform the action (e.g. Instagram delete,
 * non-Facebook edit) so the UI can warn instead of reporting a hard failure.
 */
export type PlatformActionResult = {
  accountId: number
  platform: string
  handle: string
  ok: boolean
  skipped?: boolean
  message?: string
}

type DecodedImage = { buffer: Buffer; contentType: string } | null

function decodeDataUrl(image: string | null | undefined): DecodedImage {
  if (!image) return null
  const match = /^data:(.+?);base64,(.*)$/.exec(image)
  if (!match) return null
  return { contentType: match[1], buffer: Buffer.from(match[2], "base64") }
}

function isHttpUrl(value: string | null | undefined): value is string {
  return Boolean(value && /^https?:\/\//.test(value))
}

/**
 * Resolves a post image into raw bytes for platforms that upload binaries
 * (LinkedIn, Facebook). The image may arrive either as an in-browser data URL
 * or as a public https URL (our own /api/marketing/social/media/[id]); the
 * latter is fetched here so both forms keep working.
 */
async function resolveImageBytes(image: string | null | undefined): Promise<DecodedImage> {
  const dataUrl = decodeDataUrl(image)
  if (dataUrl) return dataUrl
  if (isHttpUrl(image)) {
    const res = await fetch(image)
    if (!res.ok) throw new Error(`Could not fetch image (${res.status})`)
    const contentType = res.headers.get("content-type") || "image/jpeg"
    const buffer = Buffer.from(await res.arrayBuffer())
    return { contentType, buffer }
  }
  return null
}

export async function publishToAccount(
  account: SocialAccountRow,
  post: { content: string; image?: string | null },
): Promise<PublishResult> {
  const base = { accountId: account.id, platform: account.platform, handle: account.handle }
  try {
    // Tokens are stored encrypted — decrypt into a working copy for this call.
    const decrypted: SocialAccountRow = {
      ...account,
      access_token: decryptToken(account.access_token),
      refresh_token: decryptToken(account.refresh_token),
    }
    if (!decrypted.access_token) throw new Error("This account is missing an access token — reconnect it.")

    let published: PublishedRef = {}
    if (decrypted.platform === "linkedin") published = await publishLinkedIn(decrypted, post)
    else if (decrypted.platform === "x") published = await publishX(decrypted, post)
    else if (decrypted.platform === "facebook") published = await publishFacebook(decrypted, post)
    else if (decrypted.platform === "instagram") published = await publishInstagram(decrypted, post)
    else throw new Error(`Unsupported platform: ${decrypted.platform}`)

    return { ...base, ok: true, permalink: published.permalink, remoteId: published.remoteId }
  } catch (err: any) {
    return { ...base, ok: false, error: err?.message || "Publish failed" }
  }
}

/* ------------------------------- LinkedIn ------------------------------- */

async function publishLinkedIn(
  account: SocialAccountRow,
  post: { content: string; image?: string | null },
): Promise<PublishedRef> {
  const author = account.external_id! // urn:li:person:… or urn:li:organization:…
  const token = account.access_token!
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Restli-Protocol-Version": "2.0.0",
  }

  const img = await resolveImageBytes(post.image)
  let media: any[] = []
  let shareMediaCategory = "NONE"

  if (img) {
    // 1. register an upload slot
    const registerRes = await fetch("https://api.linkedin.com/v2/assets?action=registerUpload", {
      method: "POST",
      headers,
      body: JSON.stringify({
        registerUploadRequest: {
          recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
          owner: author,
          serviceRelationships: [
            { relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" },
          ],
        },
      }),
    })
    const registerJson = await registerRes.json()
    if (!registerRes.ok) throw new Error(`LinkedIn upload register failed: ${JSON.stringify(registerJson)}`)
    const asset = registerJson.value.asset as string
    const uploadUrl =
      registerJson.value.uploadMechanism[
        "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
      ].uploadUrl as string

    // 2. upload the bytes
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": img.contentType },
      body: new Uint8Array(img.buffer),
    })
    if (!uploadRes.ok) throw new Error(`LinkedIn image upload failed (${uploadRes.status})`)

    media = [{ status: "READY", media: asset }]
    shareMediaCategory = "IMAGE"
  }

  const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      author,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: post.content },
          shareMediaCategory,
          ...(media.length ? { media } : {}),
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`LinkedIn post failed: ${JSON.stringify(json)}`)
  const id = res.headers.get("x-restli-id") || json.id
  return {
    remoteId: id || undefined,
    permalink: id ? `https://www.linkedin.com/feed/update/${id}` : undefined,
  }
}

/* ---------------------------------- X ---------------------------------- */

async function publishX(
  account: SocialAccountRow,
  post: { content: string; image?: string | null },
): Promise<PublishedRef> {
  const res = await fetch("https://api.x.com/2/tweets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: post.content }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`X post failed: ${JSON.stringify(json)}`)
  const id = json.data?.id
  return { remoteId: id, permalink: id ? `https://x.com/i/web/status/${id}` : undefined }
}

/* ------------------------------- Facebook ------------------------------- */

async function publishFacebook(
  account: SocialAccountRow,
  post: { content: string; image?: string | null },
): Promise<PublishedRef> {
  const pageId = account.page_id || account.external_id!
  const token = account.access_token!
  const img = await resolveImageBytes(post.image)

  if (img) {
    const form = new FormData()
    form.append("caption", post.content)
    form.append("access_token", token)
    form.append("source", new Blob([new Uint8Array(img.buffer)], { type: img.contentType }), "image")
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/photos`, {
      method: "POST",
      body: form,
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`Facebook photo post failed: ${JSON.stringify(json)}`)
    const id = json.post_id || json.id
    return { remoteId: id, permalink: id ? `https://www.facebook.com/${id}` : undefined }
  }

  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: post.content, access_token: token }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Facebook post failed: ${JSON.stringify(json)}`)
  const id = json.id
  return { remoteId: id, permalink: id ? `https://www.facebook.com/${id}` : undefined }
}

/* ------------------------------- Instagram ------------------------------ */

/**
 * Polls an Instagram media container until it finishes processing. Instagram
 * downloads and processes the image asynchronously, so publishing right after
 * creating the container fails with code 9007 ("Media is not ready"). We check
 * status_code every couple of seconds and only return once it is FINISHED.
 */
async function waitForContainerReady(creationId: string, token: string) {
  const maxAttempts = 15 // ~30s total
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(
      `https://graph.instagram.com/${GRAPH_VERSION}/${creationId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`,
    )
    const json = await res.json().catch(() => ({}))
    const status = json.status_code as string | undefined

    if (status === "FINISHED") return
    if (status === "ERROR" || status === "EXPIRED") {
      throw new Error(`Instagram media processing failed: ${JSON.stringify(json)}`)
    }
    // IN_PROGRESS (or unknown) — wait and retry
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error("Instagram media is still processing after 30s. Please try publishing again in a moment.")
}

async function publishInstagram(
  account: SocialAccountRow,
  post: { content: string; image?: string | null },
): Promise<PublishedRef> {
  // Instagram API with Instagram Login publishes through graph.instagram.com,
  // NOT the Facebook Graph. The id is the Instagram user id resolved at connect.
  const igId = account.page_id || account.external_id!
  const token = account.access_token!

  if (!isHttpUrl(post.image)) {
    throw new Error(
      "Instagram requires a publicly hosted image URL. Upload the image to public storage and attach its URL.",
    )
  }

  // 1. create a media container
  const createRes = await fetch(`https://graph.instagram.com/${GRAPH_VERSION}/${igId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: post.image, caption: post.content, access_token: token }),
  })
  const createJson = await createRes.json().catch(() => ({}))
  if (!createRes.ok) throw new Error(`Instagram container failed: ${JSON.stringify(createJson)}`)

  const creationId = createJson.id as string

  // 2. wait for Instagram to finish processing the container before publishing.
  // Publishing too early returns code 9007 ("Media is not ready"), so poll the
  // container's status_code until it reports FINISHED (or fails / times out).
  await waitForContainerReady(creationId, token)

  // 3. publish the container
  const publishRes = await fetch(`https://graph.instagram.com/${GRAPH_VERSION}/${igId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: createJson.id, access_token: token }),
  })
  const publishJson = await publishRes.json().catch(() => ({}))
  if (!publishRes.ok) throw new Error(`Instagram publish failed: ${JSON.stringify(publishJson)}`)

  const permRes = await fetch(
    `https://graph.instagram.com/${publishJson.id}?fields=permalink&access_token=${encodeURIComponent(token)}`,
  )
  const permJson = await permRes.json().catch(() => ({}))
  return { remoteId: publishJson.id, permalink: permJson.permalink || undefined }
}

/* ------------------------------------------------------------------ */
/* Deleting a live post                                                */
/* ------------------------------------------------------------------ */

const PLATFORM_LABEL: Record<string, string> = {
  linkedin: "LinkedIn",
  x: "X",
  facebook: "Facebook",
  instagram: "Instagram",
}

/**
 * Removes a post from the platform it was published to, using the remote id we
 * stored at publish time. LinkedIn, X, and Facebook all support programmatic
 * deletion. Instagram's official API has NO endpoint to delete a published
 * post, so it is reported as `skipped` with a message telling the user to
 * remove it by hand in the app.
 */
export async function deleteFromAccount(
  account: SocialAccountRow,
  remoteId: string | null | undefined,
): Promise<PlatformActionResult> {
  const base = { accountId: account.id, platform: account.platform, handle: account.handle }
  const label = PLATFORM_LABEL[account.platform] ?? account.platform

  if (account.platform === "instagram") {
    return {
      ...base,
      ok: false,
      skipped: true,
      message:
        "Instagram's API can't delete a published post — open the Instagram app and delete it manually.",
    }
  }

  try {
    const token = decryptToken(account.access_token)
    if (!token) throw new Error("this account is missing an access token — reconnect it")
    if (!remoteId) throw new Error("no published id was stored, so the live post couldn't be located")

    if (account.platform === "linkedin") await deleteLinkedIn(remoteId, token)
    else if (account.platform === "x") await deleteX(remoteId, token)
    else if (account.platform === "facebook") await deleteFacebook(remoteId, token)
    else throw new Error(`deleting on ${label} isn't supported`)

    return { ...base, ok: true }
  } catch (err: any) {
    return { ...base, ok: false, message: `${label}: ${err?.message || "delete failed"}` }
  }
}

async function deleteLinkedIn(remoteId: string, token: string) {
  const res = await fetch(`https://api.linkedin.com/v2/ugcPosts/${encodeURIComponent(remoteId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "X-Restli-Protocol-Version": "2.0.0" },
  })
  // 404 means it's already gone — treat that as success (idempotent delete).
  if (!res.ok && res.status !== 404) {
    const json = await res.json().catch(() => ({}))
    throw new Error(`delete rejected (${res.status}) ${JSON.stringify(json)}`)
  }
}

async function deleteX(remoteId: string, token: string) {
  const res = await fetch(`https://api.x.com/2/tweets/${remoteId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok && res.status !== 404) {
    const json = await res.json().catch(() => ({}))
    throw new Error(`delete rejected (${res.status}) ${JSON.stringify(json)}`)
  }
}

async function deleteFacebook(remoteId: string, token: string) {
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${remoteId}?access_token=${encodeURIComponent(token)}`,
    { method: "DELETE" },
  )
  if (!res.ok && res.status !== 404) {
    const json = await res.json().catch(() => ({}))
    throw new Error(`delete rejected (${res.status}) ${JSON.stringify(json)}`)
  }
}

/* ------------------------------------------------------------------ */
/* Editing a live post                                                 */
/* ------------------------------------------------------------------ */

/**
 * Propagates an edited caption to the live post. Only Facebook exposes an edit
 * endpoint for an already-published post; X, LinkedIn, and Instagram do not
 * allow editing a live post through their APIs, so those are reported as
 * `skipped` — the ERP copy still updates, but the live post is left untouched.
 */
export async function editOnAccount(
  account: SocialAccountRow,
  remoteId: string | null | undefined,
  post: { content: string },
): Promise<PlatformActionResult> {
  const base = { accountId: account.id, platform: account.platform, handle: account.handle }
  const label = PLATFORM_LABEL[account.platform] ?? account.platform

  if (account.platform !== "facebook") {
    return {
      ...base,
      ok: false,
      skipped: true,
      message: `${label} doesn't allow editing a live post through its API — the ERP was updated, but the published ${label} post is unchanged.`,
    }
  }

  try {
    const token = decryptToken(account.access_token)
    if (!token) throw new Error("this account is missing an access token — reconnect it")
    if (!remoteId) throw new Error("no published id was stored, so the live post couldn't be located")

    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${remoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: post.content, access_token: token }),
    })
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      throw new Error(`edit rejected (${res.status}) ${JSON.stringify(json)}`)
    }
    return { ...base, ok: true }
  } catch (err: any) {
    return { ...base, ok: false, message: `${label}: ${err?.message || "edit failed"}` }
  }
}
