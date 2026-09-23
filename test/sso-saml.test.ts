import { describe,expect,it } from "vitest"
import { mappedSamlClaims,samlEndpoints } from "@/lib/sso-saml"
const provider:any={id:4,entity_id:"https://idp.example/entity",sso_url:"https://idp.example/sso",certificate:"CERT",email_attribute:"mail",first_name_attribute:"given",last_name_attribute:"family"}
describe(" SAML contracts",()=>{it("creates tenant-specific ACS and metadata endpoints",()=>expect(samlEndpoints(provider,"https://erp.example").acs).toContain("/4/saml/acs"));it("maps configured attributes without trusting browser values",()=>expect(mappedSamlClaims(provider,{nameID:"sub",nameIDFormat:"x",issuer:"idp",mail:"u@example.com",given:"U",family:"One"} as any)).toMatchObject({subject:"sub",email:"u@example.com",name:"U One"}))})
