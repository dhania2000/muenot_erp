import { describe,expect,it } from "vitest"
import { requiresMfaByPolicy } from "@/lib/mfa-policy"
describe(" MFA policy",()=>{it("always challenges enrolled users",()=>expect(requiresMfaByPolicy({role:"employee",mfaEnabled:true,settings:{}})).toBe(true));it("enforces tenant admin or organization policy",()=>{expect(requiresMfaByPolicy({role:"admin",mfaEnabled:false,settings:{"security.require_mfa_admins":"true"}})).toBe(true);expect(requiresMfaByPolicy({role:"employee",mfaEnabled:false,settings:{"security.require_mfa":"true"}})).toBe(true)})})
