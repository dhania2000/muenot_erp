import { beforeEach, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ auth: vi.fn(), health: vi.fn(), caps: vi.fn(), conversations: vi.fn(), scope: vi.fn() }))
vi.mock("@/lib/mobile-api", async () => { const actual = await vi.importActual<any>("@/lib/mobile-api"); return { ...actual, withMobileAuth: mock.auth } })
vi.mock("@/lib/whatsapp-health", () => ({ getConnectionHealth: mock.health }))
vi.mock("@/lib/whatsapp-platform", () => ({ resolveWhatsAppCaps: mock.caps }))
vi.mock("@/lib/whatsapp-store", () => ({ listConversations: mock.conversations, inboxScopeFor: mock.scope }))
import { GET as whatsapp } from "@/app/api/mobile/v1/whatsapp/route"
import { GET as conversations } from "@/app/api/mobile/v1/conversations/route"
const principal = { userId: 3, tenantId: 8, role: "employee" as const, name: "Agent" }
beforeEach(() => { vi.clearAllMocks(); mock.auth.mockImplementation(async (_: Request, handler: any) => handler(principal)); mock.health.mockResolvedValue({ connected: true }); mock.caps.mockResolvedValue({ isAgent:true,canViewAll:false }); mock.scope.mockReturnValue({seeAll:false,userId:3}); mock.conversations.mockResolvedValue([]) })
it("returns no credentials in mobile WhatsApp status", async () => { const res=await whatsapp(new Request("https://example.test")); expect(res.status).toBe(200); expect(JSON.stringify(await res.json())).not.toMatch(/token|secret|waba_id/i) })
it("uses authenticated user scope rather than a client agent id", async () => { await conversations(new Request("https://example.test?agentId=999&limit=2")); expect(mock.scope).toHaveBeenCalledWith("employee",3); expect(mock.conversations.mock.calls[0][1]).toEqual({seeAll:false,userId:3}) })
