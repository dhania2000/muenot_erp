import { listCampaigns } from "@/lib/whatsapp-campaigns"
import { mobileJson, withMobileAuth, isMobileResponse } from "@/lib/mobile-api"
export async function GET(request:Request){const result=await withMobileAuth(request,async()=>mobileJson({campaigns:await listCampaigns()}),"campaigns");return isMobileResponse(result)?result:result}
