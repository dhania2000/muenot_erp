import { beforeEach, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ login: vi.fn(), refresh: vi.fn(), rate: vi.fn(), ip: vi.fn() }))
vi.mock("@/lib/mobile-auth", () => ({ mobileLogin: mock.login, refreshMobileSession: mock.refresh }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mock.rate, getClientIp: mock.ip }))
import { POST as login } from "@/app/api/mobile/v1/auth/login/route"
import { POST as refresh } from "@/app/api/mobile/v1/auth/refresh/route"
beforeEach(()=>{vi.clearAllMocks();mock.rate.mockReturnValue({allowed:true});mock.ip.mockReturnValue("127.0.0.1")})
it("does not return a mobile token when login is denied",async()=>{mock.login.mockResolvedValue({ok:false,status:403,error:"Disabled"});const res=await login(new Request("https://x.test",{method:"POST",body:JSON.stringify({email:"a",password:"b"})}));expect(res.status).toBe(403);expect(JSON.stringify(await res.json())).not.toContain("accessToken")})
it("rotates only a valid refresh result and rejects invalid refresh tokens",async()=>{mock.refresh.mockResolvedValue({ok:false,status:401,error:"Invalid refresh token"});const res=await refresh(new Request("https://x.test",{method:"POST",body:JSON.stringify({refreshToken:"expired"})}));expect(res.status).toBe(401);mock.refresh.mockResolvedValue({ok:true,tokens:{accessToken:"new",refreshToken:"rotated",expiresIn:900}});const ok=await refresh(new Request("https://x.test",{method:"POST",body:JSON.stringify({refreshToken:"valid"})}));expect((await ok.json()).accessToken).toBe("new")})
