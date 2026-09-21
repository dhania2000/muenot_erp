import { mobileJson, withMobileAuth, isMobileResponse } from "@/lib/mobile-api"
/** Products are currently global ERP records without a tenant discriminator; do not expose them to mobile until migrated. */
export async function GET(request:Request){const result=await withMobileAuth(request,async()=>mobileJson({error:"Products are not yet available for Shopkeeper tenants.",code:"future_module"},{status:501}),"products");return isMobileResponse(result)?result:result}
