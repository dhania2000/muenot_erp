import { listContacts } from "@/lib/whatsapp-store"
import { mobileJson, withMobileAuth, isMobileResponse, boundedPage } from "@/lib/mobile-api"
export async function GET(request:Request){const result=await withMobileAuth(request,async()=>{const u=new URL(request.url);const limit=boundedPage(u.searchParams.get("limit"),50,200);return mobileJson({contacts:await listContacts(u.searchParams.get("search")?.slice(0,100)||"",limit),pagination:{limit}})},"contacts");return isMobileResponse(result)?result:result}
