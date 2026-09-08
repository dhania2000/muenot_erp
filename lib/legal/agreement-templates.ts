// Legal agreement template catalog.
// Each template renders into a full drafted agreement using a shared, parameterized
// clause library. Values entered by the user are substituted at generation time.

export type AgreementValues = {
  effectiveDate: string
  party1Name: string
  party1Type: string
  party1Address: string
  party2Name: string
  party2Type: string
  party2Address: string
  governingLaw: string
  term: string
  consideration: string
}

export const defaultValues: AgreementValues = {
  effectiveDate: "",
  party1Name: "",
  party1Type: "Company",
  party1Address: "",
  party2Name: "",
  party2Type: "Company",
  party2Address: "",
  governingLaw: "",
  term: "",
  consideration: "",
}

export type ClauseSetKey =
  | "confidentiality"
  | "services"
  | "sale"
  | "license"
  | "employment"
  | "lease"
  | "finance"
  | "partnership"
  | "ip"
  | "general"

type Roles = { p1: string; p2: string }

type Section = { heading: string; body: string }

export type AgreementTemplate = {
  id: string
  name: string
  category: string
  blurb: string
  summary: string
  clauseSet: ClauseSetKey
}

const roleMap: Record<ClauseSetKey, Roles> = {
  confidentiality: { p1: "Disclosing Party", p2: "Receiving Party" },
  services: { p1: "Client", p2: "Service Provider" },
  sale: { p1: "Seller", p2: "Buyer" },
  license: { p1: "Licensor", p2: "Licensee" },
  employment: { p1: "Employer", p2: "Employee" },
  lease: { p1: "Landlord", p2: "Tenant" },
  finance: { p1: "Lender", p2: "Borrower" },
  partnership: { p1: "First Party", p2: "Second Party" },
  ip: { p1: "Assignor", p2: "Assignee" },
  general: { p1: "First Party", p2: "Second Party" },
}

function fallback(value: string, placeholder: string) {
  const v = (value || "").trim()
  return v.length ? v : `[${placeholder}]`
}

// Reusable clause builders keyed by name.
type Ctx = {
  t: AgreementTemplate
  v: AgreementValues
  roles: Roles
  p1: string
  p2: string
  law: string
}

const clause: Record<string, (c: Ctx) => Section> = {
  purpose: (c) => ({
    heading: "Purpose",
    body: `This ${c.t.name} (the "Agreement") sets forth the terms under which the parties will ${c.t.summary} The parties enter into this Agreement freely and intend to be legally bound by its terms.`,
  }),
  term: (c) => ({
    heading: "Term",
    body: `This Agreement shall commence on the Effective Date and shall remain in effect for ${fallback(
      c.v.term,
      "Term / Duration",
    )}, unless earlier terminated in accordance with the provisions of this Agreement. The Agreement may be renewed or extended by mutual written consent of the parties.`,
  }),
  responsibilities: (c) => ({
    heading: "Obligations of the Parties",
    body: `Each party shall perform its obligations under this Agreement in good faith, with reasonable skill and care, and in compliance with all applicable laws and regulations. The ${c.p2} shall cooperate with and provide the ${c.p1} with such information, access, and assistance as is reasonably required to give effect to this Agreement.`,
  }),
  services: (c) => ({
    heading: "Scope of Services",
    body: `The ${c.p2} shall provide the services described in this Agreement and any accompanying statement of work or schedule (the "Services") in a professional and workmanlike manner. Any change to the scope of the Services shall be agreed in writing by both parties before the additional work is undertaken.`,
  }),
  deliverables: (c) => ({
    heading: "Deliverables and Acceptance",
    body: `The ${c.p2} shall deliver the agreed deliverables in accordance with the timelines set out by the parties. The ${c.p1} shall review each deliverable and provide acceptance or written notice of any deficiencies within a reasonable period following delivery.`,
  }),
  goods: (c) => ({
    heading: "Goods and Delivery",
    body: `The ${c.p1} shall sell and deliver, and the ${c.p2} shall purchase and accept, the goods described by the parties. Title and risk of loss shall pass to the ${c.p2} upon delivery, unless otherwise agreed in writing. The ${c.p1} warrants that the goods shall conform to the agreed specifications and be free from material defects.`,
  }),
  licenseGrant: (c) => ({
    heading: "Grant of License",
    body: `Subject to the terms of this Agreement, the ${c.p1} grants to the ${c.p2} a non-exclusive, non-transferable license to use the licensed materials solely for the purposes contemplated by this Agreement. All rights not expressly granted are reserved by the ${c.p1}.`,
  }),
  duties: (c) => ({
    heading: "Duties and Position",
    body: `The ${c.p2} shall perform the duties assigned by the ${c.p1}, shall devote appropriate time and attention to those duties, and shall comply with the lawful policies and directions of the ${c.p1}. The ${c.p2} shall act at all times in the best interests of the ${c.p1}.`,
  }),
  premises: (c) => ({
    heading: "Premises and Use",
    body: `The ${c.p1} agrees to let and the ${c.p2} agrees to take the premises identified by the parties for the permitted use only. The ${c.p2} shall keep the premises in good condition and shall not make alterations without the prior written consent of the ${c.p1}.`,
  }),
  loan: (c) => ({
    heading: "Loan and Repayment",
    body: `The ${c.p1} agrees to advance the principal sum described by the parties to the ${c.p2}, which the ${c.p2} agrees to repay together with any agreed interest in accordance with the repayment schedule. Amounts outstanding may become immediately due upon an event of default as described in this Agreement.`,
  }),
  contribution: (c) => ({
    heading: "Contributions and Sharing",
    body: `Each party shall make the contributions of capital, resources, or effort agreed between them and shall share in the profits, losses, and responsibilities of the venture in the proportions agreed in writing. Decisions material to the venture shall be made jointly unless otherwise delegated.`,
  }),
  assignment: (c) => ({
    heading: "Assignment of Rights",
    body: `The ${c.p1} hereby assigns to the ${c.p2} all right, title, and interest in and to the subject matter of this Agreement, including all associated intellectual property rights, and agrees to execute any further documents reasonably necessary to perfect such assignment.`,
  }),
  payment: (c) => ({
    heading: "Consideration and Payment",
    body: `In consideration of the obligations under this Agreement, the paying party shall pay ${fallback(
      c.v.consideration,
      "Fees / Consideration",
    )}. Unless otherwise agreed, invoices are payable within thirty (30) days of receipt. Late payments may accrue interest at the maximum rate permitted by applicable law.`,
  }),
  confidentiality: (c) => ({
    heading: "Confidentiality",
    body: `Each party may have access to confidential information of the other party. Each party shall keep such information strictly confidential, use it only for the purposes of this Agreement, and not disclose it to any third party without prior written consent, except as required by law. This obligation shall survive the termination of this Agreement.`,
  }),
  ip: (c) => ({
    heading: "Intellectual Property",
    body: `Except as expressly stated in this Agreement, nothing herein transfers ownership of any intellectual property. Each party retains all right, title, and interest in its pre-existing intellectual property. Any intellectual property created specifically under this Agreement shall be owned as agreed by the parties in writing.`,
  }),
  termination: (c) => ({
    heading: "Termination",
    body: `Either party may terminate this Agreement upon written notice if the other party commits a material breach that remains uncured for thirty (30) days after written notice, or becomes insolvent. Upon termination, each party shall return or destroy the other party's confidential materials and settle any amounts due up to the date of termination.`,
  }),
  liability: (c) => ({
    heading: "Limitation of Liability",
    body: `To the maximum extent permitted by law, neither party shall be liable for any indirect, incidental, special, or consequential damages arising out of this Agreement. Each party's aggregate liability under this Agreement shall not exceed the total amounts paid or payable under it, except for liability that cannot be excluded by law.`,
  }),
  indemnity: (c) => ({
    heading: "Indemnification",
    body: `Each party shall indemnify and hold harmless the other party from and against any third-party claims, losses, and reasonable expenses arising out of its breach of this Agreement, its negligence, or its wilful misconduct, subject to the indemnified party promptly notifying the indemnifying party of any such claim.`,
  }),
  warranties: (c) => ({
    heading: "Representations and Warranties",
    body: `Each party represents and warrants that it has full power and authority to enter into this Agreement, that its execution has been duly authorized, and that this Agreement constitutes a valid and binding obligation enforceable against it in accordance with its terms.`,
  }),
  forceMajeure: (c) => ({
    heading: "Force Majeure",
    body: `Neither party shall be liable for any delay or failure to perform its obligations (other than payment obligations) to the extent caused by events beyond its reasonable control, including acts of God, natural disasters, war, or governmental action, provided that the affected party gives prompt notice and uses reasonable efforts to resume performance.`,
  }),
  disputes: (c) => ({
    heading: "Governing Law and Dispute Resolution",
    body: `This Agreement shall be governed by and construed in accordance with the laws of ${c.law}, without regard to conflict-of-law principles. The parties shall attempt in good faith to resolve any dispute through negotiation, failing which the dispute shall be submitted to the competent courts or arbitration of ${c.law}.`,
  }),
  notices: (c) => ({
    heading: "Notices",
    body: `All notices under this Agreement shall be in writing and delivered to the addresses set out above (or such other address as a party may notify), and shall be deemed received upon personal delivery, upon confirmed electronic transmission, or three (3) business days after dispatch by recognized courier.`,
  }),
  general: (c) => ({
    heading: "General Provisions",
    body: `This Agreement constitutes the entire agreement between the parties and supersedes all prior discussions. No amendment is effective unless made in writing and signed by both parties. If any provision is held unenforceable, the remaining provisions shall continue in full force. Neither party may assign this Agreement without the other's prior written consent. Failure to enforce any provision shall not constitute a waiver.`,
  }),
}

const commonTail = ["confidentiality", "liability", "indemnity", "warranties", "forceMajeure", "disputes", "notices", "general"]

const clauseSets: Record<ClauseSetKey, string[]> = {
  confidentiality: ["purpose", "term", "confidentiality", "ip", "responsibilities", "termination", "liability", "indemnity", "disputes", "notices", "general"],
  services: ["purpose", "services", "deliverables", "term", "payment", "ip", ...commonTail],
  sale: ["purpose", "goods", "payment", "term", "warranties", "liability", "indemnity", "forceMajeure", "disputes", "notices", "general"],
  license: ["purpose", "licenseGrant", "term", "payment", "ip", ...commonTail],
  employment: ["purpose", "duties", "term", "payment", "confidentiality", "ip", "termination", "disputes", "notices", "general"],
  lease: ["purpose", "premises", "term", "payment", "responsibilities", "termination", "liability", "forceMajeure", "disputes", "notices", "general"],
  finance: ["purpose", "loan", "term", "warranties", "termination", "liability", "indemnity", "disputes", "notices", "general"],
  partnership: ["purpose", "contribution", "term", "payment", "confidentiality", "ip", "termination", "liability", "indemnity", "disputes", "notices", "general"],
  ip: ["purpose", "assignment", "ip", "term", "payment", "warranties", "liability", "indemnity", "disputes", "notices", "general"],
  general: ["purpose", "responsibilities", "term", "payment", ...commonTail],
}

function partyLine(name: string, type: string, address: string, role: string, placeholder: string) {
  const n = fallback(name, placeholder)
  const t = (type || "Company").trim()
  const a = fallback(address, `${placeholder} Address`)
  return `${n}, a ${t} having its principal address at ${a} (the "${role}")`
}

export function generateAgreementText(template: AgreementTemplate, values: AgreementValues): string {
  const roles = roleMap[template.clauseSet]
  const law = fallback(values.governingLaw, "Governing Jurisdiction")
  const ctx: Ctx = { t: template, v: values, roles, p1: roles.p1, p2: roles.p2, law }

  const date = fallback(values.effectiveDate, "Effective Date")
  const lines: string[] = []

  lines.push(template.name.toUpperCase())
  lines.push("")
  lines.push(
    `This ${template.name} (this "Agreement") is entered into and made effective as of ${date} (the "Effective Date"), by and between:`,
  )
  lines.push("")
  lines.push(`(1) ${partyLine(values.party1Name, values.party1Type, values.party1Address, roles.p1, "First Party")}; and`)
  lines.push("")
  lines.push(`(2) ${partyLine(values.party2Name, values.party2Type, values.party2Address, roles.p2, "Second Party")}.`)
  lines.push("")
  lines.push(`The ${roles.p1} and the ${roles.p2} are referred to individually as a "Party" and collectively as the "Parties".`)
  lines.push("")
  lines.push("NOW, THEREFORE, in consideration of the mutual covenants and promises set out below, the Parties agree as follows:")
  lines.push("")

  const keys = clauseSets[template.clauseSet]
  keys.forEach((key, i) => {
    const section = clause[key](ctx)
    lines.push(`${i + 1}. ${section.heading}`)
    lines.push(section.body)
    lines.push("")
  })

  lines.push("IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date.")
  lines.push("")
  lines.push(`${roles.p1}:`)
  lines.push("")
  lines.push(`Signature: ____________________________`)
  lines.push(`Name: ${fallback(values.party1Name, "First Party")}`)
  lines.push(`Date: ${date}`)
  lines.push("")
  lines.push(`${roles.p2}:`)
  lines.push("")
  lines.push(`Signature: ____________________________`)
  lines.push(`Name: ${fallback(values.party2Name, "Second Party")}`)
  lines.push(`Date: ${date}`)

  return lines.join("\n")
}

// ---- The catalog of 110 agreements ----

type Seed = [name: string, blurb: string, summary: string, clauseSet: ClauseSetKey]

const seeds: Record<string, Seed[]> = {
  "Core Commercial": [
    ["Master Service Agreement (MSA)", "Umbrella terms governing an ongoing service relationship.", "govern the overall terms under which services and future statements of work will be delivered.", "services"],
    ["Non-Disclosure Agreement (Mutual)", "Two-way protection of confidential information.", "protect confidential information exchanged between them in both directions.", "confidentiality"],
    ["Non-Disclosure Agreement (One-Way)", "One party discloses, the other keeps it secret.", "protect confidential information disclosed by one party to the other.", "confidentiality"],
    ["Statement of Work (SOW)", "Defines deliverables, timeline, and fees for a project.", "define the specific deliverables, milestones, and fees for a defined engagement.", "services"],
    ["Letter of Intent (LOI)", "Signals intent to proceed toward a definitive deal.", "record their preliminary intent to proceed toward a definitive transaction.", "general"],
    ["Memorandum of Understanding (MOU)", "Non-binding framework of mutual understanding.", "record a mutual understanding and framework for future cooperation.", "partnership"],
    ["Term Sheet", "Key commercial terms ahead of a formal contract.", "outline the principal commercial terms of a proposed transaction.", "general"],
    ["Teaming Agreement", "Two firms cooperate to pursue an opportunity.", "cooperate to jointly pursue and deliver a specific business opportunity.", "partnership"],
    ["Confidentiality and Non-Circumvention Agreement", "Protects secrets and prevents deal bypass.", "protect confidential information and prevent circumvention of business relationships.", "confidentiality"],
    ["Master Purchase Agreement", "Umbrella terms for recurring purchases.", "govern the recurring purchase of goods under agreed standard terms.", "sale"],
  ],
  "Sales & Vendor": [
    ["Sales Agreement", "Standard sale of goods between a seller and buyer.", "govern the sale and purchase of goods on the agreed terms.", "sale"],
    ["Purchase Agreement", "Buyer acquires goods or assets from a seller.", "govern the buyer's purchase of the identified goods or assets.", "sale"],
    ["Supply Agreement", "Ongoing supply of goods over time.", "govern the ongoing supply of goods over the agreed period.", "sale"],
    ["Distribution Agreement", "Appoints a distributor for products in a territory.", "appoint the distributor to market and resell products in a territory.", "sale"],
    ["Reseller Agreement", "Authorizes resale of products or services.", "authorize the reseller to resell the products or services to end customers.", "sale"],
    ["Vendor Agreement", "Terms for a vendor supplying a business.", "govern the terms under which the vendor supplies goods or services.", "sale"],
    ["Procurement Agreement", "Structured purchasing of goods and services.", "govern the structured procurement of goods and services.", "sale"],
    ["Consignment Agreement", "Goods held for sale on the owner's behalf.", "govern the sale of goods held on consignment on behalf of the owner.", "sale"],
    ["Wholesale Agreement", "Bulk sale to a retailer or distributor.", "govern the wholesale supply of goods for resale.", "sale"],
    ["Equipment Purchase Agreement", "Sale of equipment with warranties.", "govern the purchase and delivery of the specified equipment.", "sale"],
    ["Product Warranty Agreement", "Defines warranty coverage for products.", "define the warranty coverage and remedies for the supplied products.", "sale"],
    ["Dropshipping Agreement", "Supplier ships directly to the seller's customers.", "govern the fulfilment of orders shipped directly to end customers.", "sale"],
  ],
  "Services & Consulting": [
    ["Consulting Agreement", "Engages a consultant for advisory work.", "engage the consultant to provide the agreed advisory services.", "services"],
    ["Professional Services Agreement", "General terms for professional service delivery.", "govern the delivery of professional services to the client.", "services"],
    ["Managed Services Agreement", "Ongoing operation of a client's function.", "provide ongoing managed services for the client's operations.", "services"],
    ["Software as a Service (SaaS) Agreement", "Cloud software provided on subscription.", "provide access to hosted software on a subscription basis.", "services"],
    ["Software License Agreement", "Grants rights to use licensed software.", "license the use of the software under the agreed terms.", "license"],
    ["Maintenance and Support Agreement", "Ongoing support for products or systems.", "provide ongoing maintenance and support for the covered systems.", "services"],
    ["Service Level Agreement (SLA)", "Defines measurable service commitments.", "define the service levels, metrics, and remedies for the services.", "services"],
    ["Retainer Agreement", "Reserves ongoing capacity for a fee.", "reserve the provider's availability in exchange for a recurring retainer.", "services"],
    ["Marketing Services Agreement", "Delivery of marketing and promotional work.", "provide marketing and promotional services to the client.", "services"],
    ["Advertising Agreement", "Placement and delivery of advertising.", "govern the creation and placement of advertising for the client.", "services"],
    ["Web Development Agreement", "Design and build of a website or app.", "design, build, and deliver the agreed digital product.", "services"],
    ["IT Services Agreement", "Provision of information-technology services.", "provide the agreed information-technology services to the client.", "services"],
    ["Cleaning Services Agreement", "Recurring cleaning of premises.", "provide recurring cleaning services for the client's premises.", "services"],
    ["Security Services Agreement", "Provision of security personnel or systems.", "provide security services to protect the client's premises and assets.", "services"],
    ["Training Services Agreement", "Delivery of training programs.", "deliver the agreed training programs to the client's personnel.", "services"],
    ["Recruitment Agency Agreement", "Sourcing and placing candidates.", "source and place suitable candidates for the client.", "services"],
    ["Catering Agreement", "Food and beverage services for events.", "provide catering services for the client's event.", "services"],
    ["Photography Services Agreement", "Photography for an event or project.", "provide photography services and deliver the agreed images.", "services"],
  ],
  "Employment & HR": [
    ["Employment Agreement", "Full-time employment terms.", "set out the terms of the employee's employment.", "employment"],
    ["Executive Employment Agreement", "Senior-executive employment terms.", "set out the terms of the executive's senior appointment, compensation, and duties.", "employment"],
    ["Offer Letter", "Formal offer of employment.", "extend and confirm an offer of employment on the stated terms.", "employment"],
    ["Independent Contractor Agreement", "Engages a self-employed contractor.", "engage the contractor to provide services on an independent basis.", "services"],
    ["Freelancer Agreement", "Project-based freelance engagement.", "engage the freelancer for the agreed project work.", "services"],
    ["Internship Agreement", "Terms of a structured internship.", "set out the terms of the intern's placement and learning.", "employment"],
    ["Non-Compete Agreement", "Restricts competing activity after leaving.", "restrict competitive activity for a defined period and area.", "employment"],
    ["Non-Solicitation Agreement", "Restricts poaching of staff or clients.", "restrict solicitation of the company's employees and customers.", "employment"],
    ["Severance Agreement", "Terms on ending employment.", "set out the terms and consideration for ending employment.", "employment"],
    ["Employee Confidentiality Agreement", "Protects company information held by staff.", "protect the company's confidential information held by the employee.", "confidentiality"],
    ["Employee Stock Option (ESOP) Agreement", "Grants equity options to an employee.", "grant the employee options over the company's equity.", "finance"],
    ["Commission Agreement", "Performance-based commission structure.", "set out the commission payable on qualifying sales.", "employment"],
    ["Remote Work Agreement", "Terms for working remotely.", "set out the terms and expectations for remote working.", "employment"],
    ["Consultant Retainer Agreement", "Ongoing advisory on retainer.", "retain the consultant for ongoing advisory services.", "services"],
    ["Apprenticeship Agreement", "Structured on-the-job training.", "set out the terms of the apprentice's training and work.", "employment"],
    ["Volunteer Agreement", "Terms for unpaid volunteer work.", "set out the terms of the volunteer's contribution.", "employment"],
  ],
  "IP & Technology": [
    ["Intellectual Property Assignment Agreement", "Transfers ownership of IP.", "transfer ownership of the identified intellectual property.", "ip"],
    ["Trademark License Agreement", "Licenses use of a trademark.", "license the use of the trademark under agreed conditions.", "license"],
    ["Patent License Agreement", "Licenses rights under a patent.", "license the rights under the identified patent.", "license"],
    ["Copyright License Agreement", "Licenses use of copyrighted work.", "license the use of the copyrighted work.", "license"],
    ["Technology Transfer Agreement", "Transfers technology and know-how.", "transfer the technology and associated know-how.", "ip"],
    ["Data Processing Agreement (DPA)", "Governs processing of personal data.", "govern the processing of personal data on the controller's behalf.", "services"],
    ["Data Sharing Agreement", "Controls sharing of data between parties.", "govern the sharing and permitted use of data between the parties.", "confidentiality"],
    ["API License Agreement", "Terms for using an application interface.", "license access to and use of the application programming interface.", "license"],
    ["End User License Agreement (EULA)", "Terms for end users of software.", "set out the terms on which end users may use the software.", "license"],
    ["Website Terms and Conditions", "Rules governing use of a website.", "set out the terms governing use of the website.", "license"],
    ["Source Code Escrow Agreement", "Holds source code with a neutral agent.", "hold source code in escrow for release on defined events.", "ip"],
    ["Joint Development Agreement", "Two parties develop technology together.", "jointly develop the agreed technology and allocate resulting rights.", "partnership"],
    ["Beta Testing Agreement", "Terms for testing pre-release software.", "govern the testing of pre-release software by the tester.", "confidentiality"],
    ["OEM Agreement", "Manufacturer supplies branded components.", "supply components for incorporation into the buyer's products.", "sale"],
    ["White Label Agreement", "Rebranding of a product for resale.", "permit rebranding and resale of the provider's product.", "license"],
  ],
  "Real Estate & Facilities": [
    ["Residential Lease Agreement", "Rents a home to a tenant.", "let the residential premises to the tenant.", "lease"],
    ["Commercial Lease Agreement", "Rents commercial premises.", "let the commercial premises to the tenant.", "lease"],
    ["Sublease Agreement", "Tenant re-lets premises to a subtenant.", "sublet the premises to the subtenant.", "lease"],
    ["Rental Agreement", "Short-term rental of property.", "govern the short-term rental of the property.", "lease"],
    ["Property Management Agreement", "Manager operates a property for the owner.", "appoint the manager to operate the owner's property.", "services"],
    ["Office Space Agreement", "License to occupy office space.", "grant the right to occupy the specified office space.", "lease"],
    ["Coworking Membership Agreement", "Access to shared workspace.", "grant access to the shared workspace and services.", "lease"],
    ["Facility Use Agreement", "Temporary use of a facility.", "grant temporary use of the facility for the stated purpose.", "lease"],
    ["Parking Space Lease", "Rents a parking space.", "let the parking space to the tenant.", "lease"],
    ["Land Lease Agreement", "Long-term lease of land.", "let the identified land to the tenant.", "lease"],
    ["Storage Rental Agreement", "Rents storage space.", "let the storage space to the tenant.", "lease"],
    ["Construction Agreement", "Contractor builds or renovates.", "carry out the agreed construction works.", "services"],
    ["Subcontractor Agreement", "Engages a subcontractor for part of a job.", "engage the subcontractor to perform a defined portion of the works.", "services"],
    ["Roommate Agreement", "Shared-living arrangement terms.", "set out the terms of the shared-living arrangement.", "lease"],
  ],
  "Finance": [
    ["Loan Agreement", "Terms of a loan and repayment.", "govern the loan of funds and their repayment.", "finance"],
    ["Promissory Note", "Promise to repay a debt.", "record the borrower's unconditional promise to repay.", "finance"],
    ["Personal Guarantee", "Guarantor backs another's obligations.", "guarantee the performance of the borrower's obligations.", "finance"],
    ["SAFE (Simple Agreement for Future Equity)", "Investment convertible to future equity.", "provide investment that may convert into equity on a future event.", "finance"],
    ["Convertible Note Agreement", "Debt that converts into equity.", "provide a loan that may convert into equity on agreed terms.", "finance"],
    ["Shareholders Agreement", "Governs relations among shareholders.", "govern the rights and obligations of the shareholders.", "partnership"],
    ["Share Purchase Agreement", "Sale of company shares.", "govern the sale and purchase of the identified shares.", "sale"],
    ["Investment Agreement", "Terms of an equity investment.", "govern the terms of the investor's investment.", "finance"],
    ["Debt Settlement Agreement", "Settles an outstanding debt.", "settle the outstanding debt on agreed terms.", "finance"],
    ["Line of Credit Agreement", "Revolving borrowing facility.", "make available a revolving line of credit to the borrower.", "finance"],
    ["Factoring Agreement", "Sale of receivables for cash.", "sell receivables to the factor in exchange for advance funding.", "finance"],
    ["Revenue Sharing Agreement", "Splits revenue between parties.", "share defined revenue between the parties.", "partnership"],
    ["Escrow Agreement", "Funds held by a neutral third party.", "hold funds or assets in escrow pending defined conditions.", "finance"],
    ["Indemnity Agreement", "One party indemnifies another.", "provide indemnity against the defined losses.", "general"],
    ["Investor Rights Agreement", "Rights granted to company investors.", "define the information, registration, and governance rights of the investors.", "finance"],
    ["Employee Stock Purchase Plan (ESPP)", "Lets employees buy shares at a discount.", "allow the employee to purchase company shares under the plan on the agreed terms.", "finance"],
    ["Restricted Stock Agreement", "Grants restricted company stock.", "grant restricted stock to the recipient subject to vesting conditions.", "finance"],
    ["Warrant Agreement", "Right to buy shares at a set price.", "grant the holder a warrant to purchase shares at the stated exercise price.", "finance"],
    ["Subscription (Securities) Agreement", "Investor subscribes for new securities.", "govern the investor's subscription for newly issued securities.", "finance"],
  ],
  "Partnership & Corporate": [
    ["Partnership Agreement", "Governs a business partnership.", "govern the formation and operation of the partnership.", "partnership"],
    ["Joint Venture Agreement", "Two firms form a joint venture.", "form and operate a joint venture for a defined purpose.", "partnership"],
    ["Limited Liability Partnership (LLP) Agreement", "Governs an LLP.", "govern the rights and duties of the LLP partners.", "partnership"],
    ["Founders Agreement", "Terms among company founders.", "set out the rights and responsibilities among the founders.", "partnership"],
    ["Operating Agreement", "Governs an LLC's operation.", "govern the internal operation and management of the company.", "partnership"],
    ["Franchise Agreement", "Grants a franchise to operate a brand.", "grant the franchisee the right to operate under the brand.", "license"],
    ["Agency Agreement", "Appoints an agent to act for a principal.", "appoint the agent to act on the principal's behalf.", "services"],
    ["Referral Agreement", "Pays for qualified referrals.", "compensate the referrer for qualified referrals.", "partnership"],
    ["Affiliate Agreement", "Affiliate promotes for commission.", "engage the affiliate to promote products for commission.", "partnership"],
    ["Sponsorship Agreement", "Sponsor funds in exchange for exposure.", "provide sponsorship in exchange for the agreed benefits.", "partnership"],
    ["Strategic Alliance Agreement", "Long-term cooperation between firms.", "establish a strategic alliance between the parties.", "partnership"],
    ["Co-Marketing Agreement", "Joint marketing between two brands.", "jointly market the parties' products or services.", "partnership"],
    ["Business Sale Agreement", "Sale of a business as a going concern.", "govern the sale of the business as a going concern.", "sale"],
    ["Buy-Sell Agreement", "Handles transfer of ownership interests.", "govern the transfer of ownership interests on defined events.", "partnership"],
    ["Voting Agreement", "Governs how shares are voted.", "govern the manner in which the parties exercise their voting rights.", "partnership"],
    ["Right of First Refusal Agreement", "Priority right to buy before others.", "grant a right of first refusal over the identified interests.", "partnership"],
    ["Board Observer Agreement", "Grants a non-voting board seat.", "grant the observer the right to attend board meetings on the agreed terms.", "partnership"],
  ],
  "Logistics & Manufacturing": [
    ["Manufacturing Agreement", "Contract manufacture of products.", "manufacture the products to the agreed specifications.", "services"],
    ["Logistics Services Agreement", "Provision of logistics services.", "provide the agreed logistics and fulfilment services.", "services"],
    ["Warehousing Agreement", "Storage and handling of goods.", "store and handle the customer's goods.", "services"],
    ["Transportation Agreement", "Carriage of goods.", "transport the customer's goods to the agreed destinations.", "services"],
    ["Freight Forwarding Agreement", "Arranges shipment of goods.", "arrange the forwarding and shipment of goods.", "services"],
    ["Import Export Agreement", "Cross-border trade of goods.", "govern the import and export of goods between the parties.", "sale"],
    ["Toll Manufacturing Agreement", "Processing of client-supplied materials.", "process the client-supplied materials into finished goods.", "services"],
    ["Fulfillment Agreement", "Order storage, packing, and shipping.", "provide order fulfilment services for the customer.", "services"],
  ],
  "Media & Creative": [
    ["Content License Agreement", "Licenses creative content.", "license the use of the creative content.", "license"],
    ["Influencer Agreement", "Engages an influencer for promotion.", "engage the influencer to promote the brand.", "services"],
    ["Talent Agreement", "Engages talent for a production.", "engage the talent for the agreed production.", "services"],
    ["Music License Agreement", "Licenses use of a musical work.", "license the use of the musical work.", "license"],
    ["Publishing Agreement", "Publishes an author's work.", "publish and distribute the author's work.", "license"],
    ["Film Production Agreement", "Terms for producing a film.", "govern the production of the film.", "services"],
    ["Ghostwriting Agreement", "Writer creates work for another's byline.", "create written work to be credited to the client.", "services"],
    ["Podcast Sponsorship Agreement", "Sponsors a podcast for promotion.", "sponsor the podcast in exchange for the agreed placements.", "partnership"],
  ],
  "General & Misc": [
    ["Settlement Agreement", "Resolves a dispute between parties.", "settle and release the identified claims between the parties.", "general"],
    ["Release and Waiver Agreement", "Releases claims and assumes risk.", "release claims and waive liability for the stated activity.", "general"],
    ["Assignment Agreement", "Transfers rights and obligations.", "assign the identified rights and obligations to the assignee.", "ip"],
    ["Amendment Agreement", "Modifies an existing contract.", "amend the terms of the parties' existing agreement.", "general"],
    ["Power of Attorney", "Authorizes another to act on one's behalf.", "authorize the attorney to act on the principal's behalf.", "general"],
    ["Membership Agreement", "Terms of a membership program.", "set out the terms of the member's participation.", "general"],
    ["Subscription Agreement", "Recurring access to a product or service.", "provide recurring access on a subscription basis.", "services"],
    ["Event Agreement", "Terms for hosting or attending an event.", "govern the organization and delivery of the event.", "services"],
    ["Gift Agreement", "Documents a charitable or personal gift.", "document the terms of the gift.", "general"],
    ["Hold Harmless Agreement", "Shifts risk of loss between parties.", "hold the protected party harmless from the defined risks.", "general"],
    ["Mutual Termination Agreement", "Ends an existing contract by consent.", "terminate the parties' existing agreement by mutual consent.", "general"],
    ["Letter of Guarantee", "Guarantees performance or payment.", "guarantee performance or payment as described.", "finance"],
  ],
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
}

export const agreementTemplates: AgreementTemplate[] = Object.entries(seeds).flatMap(([category, list]) =>
  list.map(([name, blurb, summary, clauseSet]) => ({
    id: slugify(name),
    name,
    category,
    blurb,
    summary,
    clauseSet,
  })),
)

export const agreementCategories: string[] = Object.keys(seeds)

export const totalTemplates = agreementTemplates.length
