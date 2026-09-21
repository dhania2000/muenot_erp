import { listLocalTemplates } from "@/lib/whatsapp-templates"
import { mobileJson, withMobileAuth, isMobileResponse } from "@/lib/mobile-api"
export async function GET(request:Request){const result=await withMobileAuth(request,async()=>mobileJson({templates:await listLocalTemplates()}),"templates");return isMobileResponse(result)?result:result}
