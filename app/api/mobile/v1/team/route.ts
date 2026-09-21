import { query } from "@/lib/db"
import { mobileJson, withMobileAuth, isMobileResponse } from "@/lib/mobile-api"
export async function GET(request:Request){const result=await withMobileAuth(request,async p=>{const rows=await query<any[]>("SELECT id,name,email,role,tenant_role,status FROM users WHERE tenant_id=? AND status='active' ORDER BY name ASC LIMIT 200",[p.tenantId]);return mobileJson({team:rows.map(r=>({id:Number(r.id),name:r.name,email:r.email,role:r.role,tenantRole:r.tenant_role}))})},"team");return isMobileResponse(result)?result:result}
