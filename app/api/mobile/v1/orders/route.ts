import { mobileJson, withMobileAuth, isMobileResponse } from "@/lib/mobile-api"
/** A tenant-owned shop-order service does not exist yet; this explicit response prevents unsafe reuse of ERP order tables. */
export async function GET(request:Request){const result=await withMobileAuth(request,async()=>mobileJson({error:"Shopkeeper orders are planned but not implemented in Phase 1.",code:"future_module"},{status:501}),"orders");return isMobileResponse(result)?result:result}
