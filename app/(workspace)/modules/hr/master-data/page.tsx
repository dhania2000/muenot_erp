import { MasterDataClient } from "@/components/hr/master-data-client"
export default async function MasterDataPage({searchParams}:{searchParams:Promise<{kind?:string}>}){const p=await searchParams;const kind=["departments","designations","promotions","awards","appreciations","passport-visa","holidays"].includes(p.kind||"")?p.kind as any:"departments";return <MasterDataClient initialKind={kind}/>}
