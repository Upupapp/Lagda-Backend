// The ready-made template library: 15 categories, 58 documents. The gallery
// offers the ones with a signer; the chatbot drafts from all of them.
//
// Served by ready-made-routes: the CATALOGUE (no document text) to anyone
// signed in, the full library only to members of a workspace whose owner is
// on Personal or higher. It lives here, not in the web app, so the text never
// reaches a Free account's browser. Data only; edit it like a content file.

export interface ReadyMadeStep { readonly step: number; readonly role: string; readonly action_type: string }
export interface ReadyMadeDocument {
  readonly document_type: string;
  readonly title: string;
  readonly body_content: string;
  readonly signing_workflow: readonly ReadyMadeStep[];
}
export interface ReadyMadeLibrary {
  readonly categories: readonly { readonly category: string; readonly documents: readonly ReadyMadeDocument[] }[];
}

export const READY_MADE_LIBRARY: ReadyMadeLibrary = {
 "categories": [
  {
   "category": "Recruitment & HR",
   "documents": [
    {
     "document_type": "Employment contracts and offer letters",
     "title": "Employment Offer Letter and Contract Agreement",
     "body_content": "This agreement formalizes the terms of employment between an organization and an individual accepting a position within it. It outlines the role, reporting structure, compensation, benefits, and duration of employment, whether at-will, fixed-term, or probationary. Both parties acknowledge their respective responsibilities: the employer to provide a lawful working environment, timely compensation, and agreed benefits; the employee to perform assigned duties competently and adhere to organizational policies. The document remains valid from the stated commencement date until termination, resignation, or expiration of a fixed term, subject to applicable labor laws and any renewal or amendment provisions mutually agreed upon.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "HR Manager",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Hiring Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 3,
       "role": "Candidate",
       "action_type": "Signer"
      },
      {
       "step": 4,
       "role": "HR Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "HR Records",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "NDAs (Non-Disclosure Agreements)",
     "title": "Non-Disclosure Agreement (NDA)",
     "body_content": "This agreement establishes the obligation to protect confidential and proprietary information exchanged during the course of an employment or business relationship. It defines what constitutes confidential information, the permitted uses of such information, and the duration for which confidentiality must be maintained, typically extending beyond the termination of the underlying relationship. The receiving party agrees not to disclose, reproduce, or use the information for any purpose outside the scope of the engagement without prior written consent. The agreement remains enforceable for the period specified within it and survives the conclusion of the relationship it governs, subject to standard exclusions such as publicly available information.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "HR or Legal Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Employee or Candidate",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "HR Manager",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "HR Records",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Policy acknowledgments (e.g., employee handbooks)",
     "title": "Employee Handbook Policy Acknowledgment Form",
     "body_content": "This form confirms that an individual has received, reviewed, and understood the organization's policies as set out in the employee handbook or equivalent policy documentation. It covers areas such as workplace conduct, attendance, disciplinary procedures, health and safety, and use of company resources. By completing this acknowledgment, the individual accepts responsibility for complying with the stated policies and understands that violations may result in corrective or disciplinary action in accordance with organizational procedures. The acknowledgment remains on file for the duration of the individual's association with the organization and is updated whenever material policy revisions are issued.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "HR Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Employee",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "HR Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "HR Records",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Remote onboarding forms",
     "title": "Remote Employee Onboarding Form",
     "body_content": "This form captures the information and acknowledgments required to onboard an individual working outside a traditional office setting. It addresses equipment provisioning, data security expectations, communication protocols, and applicable workplace policies adapted for remote work arrangements. The individual agrees to maintain a secure working environment, safeguard company equipment and data, and comply with reporting and availability expectations set by the organization. The form remains valid for the duration of the remote work arrangement and may be revisited if working conditions or organizational policies change.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "HR Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "New Employee",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "IT Department",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "HR Manager",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "HR Records",
       "action_type": "Archiver"
      }
     ]
    }
   ]
  },
  {
   "category": "Sales & Customer Agreements",
   "documents": [
    {
     "document_type": "Sales contracts and purchase orders",
     "title": "Sales Contract and Purchase Order Agreement",
     "body_content": "This agreement documents the terms under which goods or services are sold and delivered from one party to another. It specifies the description and quantity of items, pricing, delivery terms, payment schedule, and conditions for acceptance or rejection of delivered goods. The seller is responsible for delivering conforming goods within the agreed timeframe, while the buyer is responsible for timely payment and inspection upon receipt. The agreement is valid from the date of execution until fulfillment of all obligations, including any warranty or after-sale support periods specified within it.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Sales Representative",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Customer",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Sales Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Finance Officer",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Sales Administration",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Subscription agreements",
     "title": "Subscription Services Agreement",
     "body_content": "This agreement sets out the terms under which a recurring service or product access is provided in exchange for periodic payment. It defines the scope of the service, billing cycle, renewal terms, and conditions for cancellation or modification of the subscription. The provider is responsible for maintaining service availability as described, while the subscriber is responsible for timely payment and compliance with usage terms. The agreement remains in effect on a rolling or fixed-term basis as specified, automatically renewing unless terminated in accordance with the notice provisions contained within it.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Account Manager",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Customer",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Sales Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Customer Success Team",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Service level agreements (SLAs)",
     "title": "Service Level Agreement (SLA)",
     "body_content": "This agreement defines the measurable standards of service that a provider commits to delivering to a client, including performance metrics such as uptime, response times, and resolution timelines. It outlines the remedies or penalties applicable when service levels are not met, as well as the process for reporting and escalating service issues. The provider is responsible for monitoring and reporting performance against agreed metrics, while the client is responsible for providing necessary access and information to enable service delivery. The agreement remains valid for the term specified and is subject to periodic review and renewal.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Account Manager",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Client Representative",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Operations Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Legal Counsel",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Contracts Administration",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Licensing deals",
     "title": "Licensing Agreement",
     "body_content": "This agreement grants permission to use, distribute, or exploit a specified asset, technology, brand, or intellectual property under defined terms and conditions. It specifies the scope of the license, permitted territories or channels, royalty or fee structure, and restrictions on sublicensing or modification. The licensor is responsible for maintaining rights to the licensed asset, while the licensee is responsible for using it within the agreed scope and remitting applicable fees. The agreement remains valid for the term specified and may include renewal, exclusivity, or termination provisions in the event of breach or expiration.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Business Development Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Licensee",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Executive Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Legal Department",
       "action_type": "Archiver"
      }
     ]
    }
   ]
  },
  {
   "category": "Procurement & Supply Chain",
   "documents": [
    {
     "document_type": "Vendor contracts",
     "title": "Vendor Service Agreement",
     "body_content": "This agreement governs the provision of goods or services by an external vendor to an organization. It defines the scope of work, deliverables, pricing structure, and performance expectations, along with terms for quality assurance and compliance with applicable standards. The vendor is responsible for delivering agreed goods or services on schedule and to specification, while the organization is responsible for timely payment and provision of necessary information or access. The agreement remains valid for the contract term specified and may be renewed, amended, or terminated according to its stated conditions.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Procurement Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Vendor Representative",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Procurement Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Finance or Legal Officer",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Procurement Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Supplier agreements",
     "title": "Supplier Agreement",
     "body_content": "This agreement establishes the terms under which a supplier furnishes raw materials, components, or products to an organization on an ongoing basis. It covers pricing, delivery schedules, quality standards, and procedures for handling non-conforming goods. The supplier is responsible for consistent quality and timely fulfillment of orders, while the organization is responsible for accurate forecasting and payment within agreed terms. The agreement remains in effect for the duration specified and may include provisions for volume commitments, exclusivity, or periodic price review.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Procurement Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Supplier Representative",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Procurement Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Finance Officer",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Procurement Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Purchase requisitions and approvals",
     "title": "Purchase Requisition and Approval Form",
     "body_content": "This form documents an internal request to procure goods or services and routes it through the appropriate approval chain before a purchase order is issued. It specifies the item or service requested, estimated cost, budget line, and justification for the purchase. The requesting party is responsible for providing accurate and complete information, while approving parties are responsible for verifying budget availability and organizational need. The form remains part of the procurement record until the associated purchase is completed or the request is withdrawn or denied.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Requesting Employee",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Department Head",
       "action_type": "Reviewer"
      },
      {
       "step": 3,
       "role": "Procurement Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Finance Officer",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Procurement Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Delivery confirmations",
     "title": "Delivery Confirmation and Acceptance Form",
     "body_content": "This form records the receipt and inspection of goods delivered under a purchase order or supplier agreement. It confirms the quantity and condition of items received and notes any discrepancies, damage, or shortages against the original order. The receiving party is responsible for inspecting delivered goods promptly and reporting any issues, while the supplying party is responsible for addressing confirmed discrepancies in accordance with the underlying agreement. The form becomes part of the procurement record once completed and supports subsequent invoicing and payment processing.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Supplier or Carrier",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Receiving Officer",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Warehouse Supervisor",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Procurement Officer",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Procurement Department",
       "action_type": "Archiver"
      }
     ]
    }
   ]
  },
  {
   "category": "Finance & Legal",
   "documents": [
    {
     "document_type": "Loan agreements and credit applications",
     "title": "Loan Agreement and Credit Application",
     "body_content": "This document sets out the terms under which credit or a loan is extended, including principal amount, interest rate, repayment schedule, and conditions of default. It requires disclosure of relevant financial information to support the credit decision and outlines the responsibilities of the borrower to repay according to the agreed schedule and of the lender to disburse funds as agreed. The agreement remains valid from disbursement until full repayment or resolution of any default, subject to the terms, covenants, and remedies specified within it.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Applicant",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Credit Analyst",
       "action_type": "Reviewer"
      },
      {
       "step": 3,
       "role": "Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Finance Manager",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Finance Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Investment contracts",
     "title": "Investment Agreement",
     "body_content": "This agreement documents the terms under which capital is invested in an entity or venture in exchange for equity, returns, or other agreed consideration. It outlines the investment amount, valuation basis, rights and obligations of the investing party, and conditions governing exit, dilution, or transfer of interest. Both parties are responsible for accurate disclosure of material information relevant to the investment decision. The agreement remains valid for the duration of the investment relationship, subject to the governance and exit provisions it contains.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Investment Manager",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Investor",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Chief Financial Officer",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Finance Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Audit confirmations",
     "title": "Audit Confirmation Letter",
     "body_content": "This document is used to independently verify financial information, balances, or transactions as part of an audit process. It requests confirmation of specific figures or account details directly from a third party or internal representative to substantiate the accuracy of financial records under review. The responding party is responsible for providing accurate and timely confirmation, while the auditing party is responsible for evaluating the response as part of its audit evidence. The confirmation remains part of the audit file for the period under examination.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Auditor",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Finance Officer",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Audit Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "External Audit Partner",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Finance and Audit Records",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Legal settlements and compliance documents",
     "title": "Legal Settlement Agreement",
     "body_content": "This agreement resolves a dispute between parties by setting out mutually agreed terms in lieu of continued litigation or formal proceedings. It specifies the obligations of each party arising from the settlement, including any payment, corrective action, or confidentiality provisions, and confirms that the settlement releases the parties from further claims related to the matter addressed. Each party is responsible for fulfilling its stated obligations within the timeframe specified. The agreement becomes binding upon execution and remains in effect until all settlement terms are fulfilled.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Legal Counsel",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Involved Parties",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Senior Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Executive Management",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Legal Department",
       "action_type": "Archiver"
      }
     ]
    }
   ]
  },
  {
   "category": "Corporate Governance",
   "documents": [
    {
     "document_type": "Board resolutions",
     "title": "Board Resolution Document",
     "body_content": "This document records a formal decision made by a governing board regarding matters requiring board-level authority, such as major transactions, appointments, or policy changes. It states the resolution adopted, the basis for the decision, and the effective date of implementation. The board is responsible for ensuring the resolution is made in accordance with governing bylaws and applicable regulations, while the corporate secretary is responsible for accurately recording and maintaining the resolution. The resolution remains valid and binding on the organization from the date of adoption unless subsequently amended or revoked by the board.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Corporate Secretary",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Board Members",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Board Chairperson",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Board of Directors",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Corporate Secretary",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Shareholder agreements",
     "title": "Shareholder Agreement",
     "body_content": "This agreement governs the relationship between shareholders of an entity, addressing matters such as voting rights, transfer of shares, dividend policy, and dispute resolution procedures. It defines the rights and obligations of each shareholder in relation to the company and to one another, including any restrictions on the sale or transfer of shares. Shareholders are responsible for adhering to the governance terms set out in the agreement. The agreement remains in effect for as long as the parties hold shares in the entity, subject to amendment by mutual consent.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Legal Counsel",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Shareholders",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Corporate Secretary",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Board of Directors",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Legal Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Partnership contracts",
     "title": "Partnership Agreement",
     "body_content": "This agreement establishes the terms under which two or more parties conduct business together as partners. It defines each partner's contribution, share of profits and losses, decision-making authority, and procedures for admitting or removing partners. Each partner is responsible for fulfilling agreed contributions and acting in good faith in the interest of the partnership. The agreement remains valid for the duration of the partnership and continues to govern the relationship until dissolution, withdrawal, or amendment in accordance with its terms.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Legal Counsel",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Partners",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Senior Management",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Executive or Board",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Legal Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Confidentiality agreements",
     "title": "Corporate Confidentiality Agreement",
     "body_content": "This agreement protects sensitive corporate information shared between an organization and another party in the context of governance, negotiations, or strategic discussions. It defines the scope of confidential information, permitted disclosures, and the duration of the confidentiality obligation. The receiving party is responsible for safeguarding the information and using it solely for the agreed purpose. The agreement remains binding for the period specified, typically extending beyond the conclusion of the discussions or relationship it was established to protect.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Legal Counsel",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Involved Parties",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Senior Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Executive Management",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Legal Department",
       "action_type": "Archiver"
      }
     ]
    }
   ]
  },
  {
   "category": "Real Estate & Property",
   "documents": [
    {
     "document_type": "Lease agreements",
     "title": "Property Lease Agreement",
     "body_content": "This agreement sets out the terms under which a property is leased from one party to another for a defined period. It specifies the lease term, rental payment schedule, permitted use of the property, and responsibilities for maintenance and repairs. The lessor is responsible for providing the property in a suitable condition, while the lessee is responsible for timely payment and reasonable use and care of the premises. The agreement remains valid for the lease term specified and may be renewed, extended, or terminated in accordance with its notice provisions.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Property Manager",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Tenant",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Property Owner",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Property Records",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Property sales contracts",
     "title": "Property Sale and Purchase Agreement",
     "body_content": "This agreement documents the terms of transfer of ownership of real property from a seller to a buyer. It specifies the purchase price, payment terms, conditions precedent to closing, and warranties regarding the condition and title of the property. The seller is responsible for delivering clear title and disclosed property condition, while the buyer is responsible for completing payment and satisfying any agreed conditions. The agreement remains binding from execution until closing, at which point ownership transfers in accordance with its terms.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Real Estate Agent",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Buyer and Seller",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Legal Counsel or Notary",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Title or Escrow Officer",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Property Records Office",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Rental applications",
     "title": "Rental Application Form",
     "body_content": "This form is used by a prospective tenant to apply for the right to lease a property. It requests information relevant to assessing suitability as a tenant, such as intended occupancy, references, and financial standing. The applicant is responsible for providing accurate and complete information, while the reviewing party is responsible for evaluating the application fairly and in accordance with applicable housing regulations. The form remains part of the tenancy record if the application is approved and a lease is subsequently executed.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Applicant",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Property Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 3,
       "role": "Property Owner",
       "action_type": "Approver"
      },
      {
       "step": 4,
       "role": "Leasing Office",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Mortgage documents",
     "title": "Mortgage Loan Agreement",
     "body_content": "This document sets out the terms under which a loan is secured against real property, including the loan amount, interest rate, repayment schedule, and rights of the lender in the event of default. It requires the borrower to maintain the property and insurance coverage as a condition of the loan and outlines the process for foreclosure or remedy in cases of non-payment. The agreement remains in effect from disbursement of funds until the loan is fully repaid or the security interest is otherwise released.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Loan Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Borrower",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Underwriter",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Lending Approval Committee",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Records and Legal Department",
       "action_type": "Archiver"
      }
     ]
    }
   ]
  },
  {
   "category": "Healthcare",
   "documents": [
    {
     "document_type": "Patient consent forms",
     "title": "Patient Informed Consent Form",
     "body_content": "This form documents a patient's voluntary agreement to undergo a proposed medical treatment, procedure, or examination after being informed of its purpose, risks, benefits, and alternatives. It confirms that the patient, or their authorized representative, has had the opportunity to ask questions and understands the information provided. The healthcare provider is responsible for ensuring adequate disclosure prior to obtaining consent, while the patient is responsible for providing accurate health information relevant to the decision. The form remains part of the patient's medical record for the duration required by applicable healthcare regulations.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Healthcare Provider",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Patient or Guardian",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Attending Physician",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Medical Records Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Insurance claims",
     "title": "Insurance Claim Form",
     "body_content": "This form is submitted to request payment or reimbursement under an insurance policy following a covered event, treatment, or loss. It requires details of the incident or service, supporting documentation, and confirmation of policy coverage. The claimant is responsible for providing accurate and complete information, while the insurer is responsible for evaluating the claim against policy terms and applicable regulations. The form remains part of the claims record until the claim is resolved, whether through payment, denial, or further review.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Claimant or Patient",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Healthcare Provider",
       "action_type": "Reviewer"
      },
      {
       "step": 3,
       "role": "Insurance Adjuster",
       "action_type": "Approver"
      },
      {
       "step": 4,
       "role": "Claims Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Medical record releases",
     "title": "Medical Record Release Authorization Form",
     "body_content": "This form authorizes the release of specified medical records or health information from a healthcare provider to a designated third party. It identifies the scope of records to be released, the intended recipient, and the purpose of the disclosure. The patient is responsible for specifying the records to be shared, while the healthcare provider is responsible for verifying authorization before releasing information, in accordance with applicable privacy regulations. The authorization remains valid until fulfilled or until the expiration or revocation date specified within it.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Patient",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Health Information Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 3,
       "role": "Privacy Officer",
       "action_type": "Approver"
      },
      {
       "step": 4,
       "role": "Medical Records Department",
       "action_type": "Archiver"
      }
     ]
    }
   ]
  },
  {
   "category": "Education",
   "documents": [
    {
     "document_type": "Enrollment agreements",
     "title": "Student Enrollment Agreement",
     "body_content": "This agreement documents the terms under which an individual enrolls in an educational program or institution. It specifies the program of study, duration, tuition and fee obligations, and conditions for continued enrollment, withdrawal, or dismissal. The institution is responsible for providing the described program and academic support, while the student is responsible for meeting academic requirements and fulfilling financial obligations. The agreement remains valid for the duration of the enrollment period and is renewed or terminated according to institutional policy and academic progress.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Admissions Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Student or Guardian",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Registrar",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Academic Dean",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Records Office",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Scholarship contracts",
     "title": "Scholarship Agreement",
     "body_content": "This agreement sets out the terms under which financial support is provided to a student in the form of a scholarship. It specifies the amount and duration of the award, eligibility conditions, and academic or conduct requirements the recipient must maintain to continue receiving support. The awarding institution is responsible for disbursing funds as agreed, while the recipient is responsible for meeting the stated conditions and reporting any change in circumstances affecting eligibility. The agreement remains valid for the award period specified, subject to renewal based on continued eligibility.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Financial Aid Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Student",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Scholarship Committee",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Academic Dean",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Financial Aid Office",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Internship agreements",
     "title": "Internship Agreement",
     "body_content": "This agreement establishes the terms of a temporary work-learning arrangement between an intern, a host organization, and where applicable, an academic institution. It defines the scope of duties, duration, supervision arrangements, and any compensation or academic credit associated with the internship. The host organization is responsible for providing a suitable learning environment and supervision, while the intern is responsible for fulfilling assigned tasks and adhering to workplace policies. The agreement remains valid for the internship period specified and concludes upon completion or early termination in accordance with its terms.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Career Services or HR Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Intern",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Host Supervisor",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Academic Coordinator",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "HR or Records Office",
       "action_type": "Archiver"
      }
     ]
    }
   ]
  },
  {
   "category": "IT & Data Security",
   "documents": [
    {
     "document_type": "Software licensing agreements",
     "title": "Software License Agreement",
     "body_content": "This agreement grants the right to use a specified software product under defined terms and conditions. It outlines the scope of the license, permitted number of users or installations, support and maintenance provisions, and restrictions on modification or redistribution. The licensor is responsible for providing functioning software and any agreed support, while the licensee is responsible for using the software within the licensed scope and complying with usage restrictions. The agreement remains valid for the term specified, whether perpetual or subscription-based, subject to renewal or termination provisions.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "IT Procurement Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Licensee or Client",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "IT Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "IT and Legal Records",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Data processing agreements (GDPR, HIPAA, etc.)",
     "title": "Data Processing Agreement (DPA)",
     "body_content": "This agreement governs the processing of personal or sensitive data by one party on behalf of another, in compliance with applicable data protection regulations. It specifies the categories of data processed, the purposes and duration of processing, and the security measures required to protect the data. The data processor is responsible for processing data only as instructed and implementing appropriate safeguards, while the data controller is responsible for ensuring the processing has a lawful basis. The agreement remains valid for the duration of the underlying service relationship and survives termination for purposes of data return or deletion.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Data Protection Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Data Processor or Vendor",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Compliance Officer",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Compliance Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Cloud service contracts",
     "title": "Cloud Service Agreement",
     "body_content": "This agreement sets out the terms under which cloud-based infrastructure, platform, or software services are provided to an organization. It specifies service availability commitments, data storage and security responsibilities, and terms for scaling, migration, or termination of services. The provider is responsible for maintaining the described service levels and security controls, while the client is responsible for appropriate use of the service and timely payment. The agreement remains valid for the term specified and typically includes provisions addressing data portability upon termination.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "IT Procurement Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Service Provider Representative",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "IT Security Officer",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Chief Information Officer",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "IT Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Confidentiality and access control forms",
     "title": "Confidentiality and System Access Control Agreement",
     "body_content": "This agreement sets out the terms under which an individual is granted access to organizational systems, networks, or data. It defines the scope of authorized access, acceptable use requirements, and obligations to maintain the confidentiality and security of accessed information. The individual is responsible for using granted access only for authorized purposes and reporting any suspected security incidents, while the organization is responsible for provisioning and revoking access appropriately. The agreement remains valid for the duration of the individual's access privileges and is reviewed periodically or upon change in role or engagement.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "IT Security Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Employee or Contractor",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "IT Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Chief Security Officer",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "IT Security Department",
       "action_type": "Archiver"
      }
     ]
    }
   ]
  },
  {
   "category": "Marketing & Partnerships",
   "documents": [
    {
     "document_type": "Influencer/brand collaboration contracts",
     "title": "Influencer Collaboration Agreement",
     "body_content": "This agreement sets out the terms under which an individual promotes or represents a brand across specified channels. It defines the scope of deliverables, content requirements, usage rights, compensation, and disclosure obligations required by applicable advertising regulations. The brand is responsible for providing agreed compensation and materials, while the collaborating individual is responsible for delivering content that meets agreed standards and disclosure requirements. The agreement remains valid for the campaign or term specified and concludes upon fulfillment of deliverables or expiration of the term.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Marketing Manager",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Collaborating Individual",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Marketing Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Marketing Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Advertising agreements",
     "title": "Advertising Services Agreement",
     "body_content": "This agreement sets out the terms under which advertising services are provided to a client, including the scope of campaigns, placement channels, budget, and performance reporting obligations. The service provider is responsible for delivering agreed advertising placements and reporting, while the client is responsible for providing necessary materials and approvals and remitting agreed payment. The agreement remains valid for the campaign period or term specified and may be extended or renewed by mutual agreement.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Account Manager",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Client Representative",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Marketing Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Marketing Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Sponsorship deals",
     "title": "Sponsorship Agreement",
     "body_content": "This agreement documents the terms under which one party provides financial or in-kind support to another in exchange for promotional or branding benefits. It specifies the sponsorship value, benefits to be provided, duration, and any exclusivity or usage-rights provisions. The sponsoring party is responsible for providing agreed support, while the sponsored party is responsible for delivering the agreed promotional benefits. The agreement remains valid for the term or event period specified and concludes upon fulfillment of obligations by both parties.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Partnerships Manager",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Sponsor Representative",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Marketing Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Partnerships Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Co-marketing MOUs",
     "title": "Co-Marketing Memorandum of Understanding (MOU)",
     "body_content": "This memorandum sets out an understanding between two or more organizations to collaborate on joint marketing initiatives. It outlines the intended scope of collaboration, respective contributions, and shared objectives, without necessarily constituting a legally binding commitment to specific deliverables. Each party is responsible for contributing agreed resources or efforts toward the joint initiative in good faith. The memorandum remains in effect for the collaboration period specified and may be formalized into a binding agreement or concluded upon completion of the initiative.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Marketing Manager",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Partner Organization Representative",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Marketing Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Marketing Department",
       "action_type": "Archiver"
      }
     ]
    }
   ]
  },
  {
   "category": "Operations & Administration",
   "documents": [
    {
     "document_type": "Facility rental agreements",
     "title": "Facility Rental Agreement",
     "body_content": "This agreement documents the terms under which a facility or venue is rented for a specified purpose and duration. It specifies rental fees, permitted use, access arrangements, and responsibilities for setup, cleaning, and damage. The facility owner or manager is responsible for providing the space in usable condition, while the renting party is responsible for appropriate use and any applicable charges for damages or overuse. The agreement remains valid for the rental period specified and concludes upon return of the facility in the agreed condition.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Facilities Manager",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Renting Party",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Operations Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Facilities Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Equipment lease contracts",
     "title": "Equipment Lease Agreement",
     "body_content": "This agreement sets out the terms under which equipment is leased from one party to another for a specified period. It specifies the lease term, payment schedule, maintenance responsibilities, and conditions for return or purchase of the equipment at the end of the term. The lessor is responsible for providing functioning equipment, while the lessee is responsible for proper use, maintenance, and timely payment. The agreement remains valid for the lease term specified and may be renewed or converted to purchase according to its terms.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Procurement or Operations Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Lessee",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Finance Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Operations Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Operations Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Maintenance/service agreements",
     "title": "Maintenance and Service Agreement",
     "body_content": "This agreement documents the terms under which ongoing maintenance or servicing of equipment, facilities, or systems is provided. It specifies the scope of maintenance activities, service frequency, response times for repairs, and associated fees. The service provider is responsible for performing agreed maintenance activities to a defined standard, while the client is responsible for providing access and timely payment. The agreement remains valid for the term specified and may be renewed periodically based on performance and ongoing need.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Facilities or Operations Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Service Provider",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Operations Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Facilities Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Operations Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Internal approval workflows (budget sign-offs, project authorizations)",
     "title": "Internal Budget Approval and Authorization Form",
     "body_content": "This form documents an internal request for budget allocation or project authorization and records the approvals required before resources are committed. It specifies the purpose of the request, estimated cost, funding source, and expected outcomes. The requesting party is responsible for justifying the request, while approving parties are responsible for verifying budget availability and alignment with organizational priorities. The form remains part of the financial and administrative record until the associated budget or project is completed or closed.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Requesting Department",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Department Head",
       "action_type": "Reviewer"
      },
      {
       "step": 3,
       "role": "Finance Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Chief Financial Officer",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Finance Department",
       "action_type": "Archiver"
      }
     ]
    }
   ]
  },
  {
   "category": "Compliance & Risk Management",
   "documents": [
    {
     "document_type": "Regulatory filings",
     "title": "Regulatory Filing Document",
     "body_content": "This document is submitted to a regulatory authority to satisfy statutory or regulatory reporting requirements applicable to the organization's operations. It specifies the information being reported, the reporting period, and the basis for the disclosures made. The preparing department is responsible for ensuring accuracy and completeness of the filing, while reviewing and approving parties are responsible for confirming compliance with applicable regulatory requirements before submission. The filing remains part of the compliance record for the period required by the relevant regulatory framework.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Compliance Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Department Head",
       "action_type": "Reviewer"
      },
      {
       "step": 3,
       "role": "Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Compliance Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Compliance Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Safety compliance acknowledgments",
     "title": "Safety Compliance Acknowledgment Form",
     "body_content": "This form confirms that an individual has received and understood applicable workplace safety policies, procedures, and training. It covers areas such as hazard awareness, emergency procedures, and use of protective equipment relevant to the individual's role. The individual is responsible for complying with the acknowledged safety requirements, while the organization is responsible for providing adequate training and a safe working environment. The acknowledgment remains on file for the duration of the individual's engagement and is renewed following material updates to safety policy or training.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Safety Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Employee",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Supervisor",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Safety Manager",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "HR and Safety Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Risk assessment approvals",
     "title": "Risk Assessment Approval Form",
     "body_content": "This form documents the evaluation of potential risks associated with an activity, project, or process, along with proposed mitigation measures. It specifies identified risks, their likelihood and potential impact, and the controls recommended to manage them. The assessing party is responsible for conducting a thorough evaluation, while approving parties are responsible for confirming that identified risks are acceptable or adequately mitigated before proceeding. The form remains part of the risk management record and is reviewed periodically or upon material change in circumstances.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Risk Analyst",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Department Head",
       "action_type": "Reviewer"
      },
      {
       "step": 3,
       "role": "Risk Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Compliance Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Risk Management Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Environmental permits",
     "title": "Environmental Permit Application and Approval",
     "body_content": "This document supports an application for authorization to conduct activities that may affect the environment, in compliance with applicable environmental regulations. It specifies the nature of the activity, anticipated environmental impact, and proposed mitigation or monitoring measures. The applying organization is responsible for providing accurate information and implementing approved mitigation measures, while the regulatory authority is responsible for evaluating the application against applicable standards. The permit, once granted, remains valid for the period specified and may be subject to renewal, conditions, or revocation.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Environmental Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Facility Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 3,
       "role": "Regulatory Authority",
       "action_type": "Approver"
      },
      {
       "step": 4,
       "role": "Compliance Department",
       "action_type": "Archiver"
      }
     ]
    }
   ]
  },
  {
   "category": "Customer Service & Support",
   "documents": [
    {
     "document_type": "Warranty agreements",
     "title": "Product Warranty Agreement",
     "body_content": "This agreement sets out the terms under which a product is guaranteed against defects for a specified period following purchase. It defines the scope of coverage, exclusions, and the process for claiming repair, replacement, or refund under the warranty. The provider is responsible for honoring valid warranty claims within the coverage terms, while the customer is responsible for using the product as intended and providing proof of purchase when making a claim. The agreement remains valid for the warranty period specified from the date of purchase or activation.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Sales or Customer Service Representative",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Customer",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Service Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Customer Service Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Customer Service Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Service repair authorizations",
     "title": "Service Repair Authorization Form",
     "body_content": "This form authorizes a service provider to carry out repair or maintenance work on a customer's product or equipment. It specifies the scope of work authorized, estimated cost, and expected timeframe for completion. The customer is responsible for authorizing the described work and understanding associated costs, while the service provider is responsible for performing the work as authorized and communicating any changes in scope. The form remains part of the service record until the work is completed and accepted.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Customer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Service Technician",
       "action_type": "Reviewer"
      },
      {
       "step": 3,
       "role": "Service Manager",
       "action_type": "Approver"
      },
      {
       "step": 4,
       "role": "Service Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Customer consent forms",
     "title": "Customer Consent and Data Usage Form",
     "body_content": "This form documents a customer's consent to the collection, use, or sharing of their personal information for specified purposes, such as service delivery, marketing communications, or data analysis. It outlines the scope of consent granted and the customer's right to withdraw consent at any time. The organization is responsible for using customer data only within the scope of consent given, while the customer is responsible for providing accurate information. The consent remains valid until withdrawn or until the purpose for which it was obtained is fulfilled.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Customer Service Representative",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Customer",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Compliance Officer",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Customer Service Manager",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Customer Service Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Refund/return approvals",
     "title": "Refund and Return Approval Form",
     "body_content": "This form documents a customer's request for a refund or return of a purchased product or service and records the evaluation and outcome of that request. It specifies the reason for the request, applicable policy provisions, and the resolution offered. The customer is responsible for providing relevant information supporting the request, while the reviewing party is responsible for evaluating the request against organizational policy. The form remains part of the customer service record until the refund or return is processed and closed.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Customer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Customer Service Representative",
       "action_type": "Reviewer"
      },
      {
       "step": 3,
       "role": "Finance or Accounting Officer",
       "action_type": "Approver"
      },
      {
       "step": 4,
       "role": "Customer Service Department",
       "action_type": "Archiver"
      }
     ]
    }
   ]
  },
  {
   "category": "R&D & Innovation",
   "documents": [
    {
     "document_type": "Joint research agreements",
     "title": "Joint Research Agreement",
     "body_content": "This agreement sets out the terms under which two or more parties collaborate on a research initiative. It defines the scope of the research, respective contributions, ownership of resulting intellectual property, and publication or disclosure rights. Each party is responsible for contributing agreed resources, expertise, or funding, and for adhering to agreed research protocols. The agreement remains valid for the duration of the research project and typically includes provisions governing rights and obligations that survive the project's conclusion.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "R&D Manager",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Partner Institution Representative",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "R&D Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "R&D Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Patent filings and IP transfer contracts",
     "title": "Patent Filing and Intellectual Property Transfer Agreement",
     "body_content": "This document supports the filing of a patent application or the transfer of ownership of intellectual property rights from one party to another. It specifies the intellectual property involved, the scope of rights being filed or transferred, and any consideration associated with the transfer. The transferring party is responsible for confirming ownership and validity of the rights, while the receiving party is responsible for fulfilling any agreed consideration. The document remains part of the intellectual property record and governs rights from the date of filing or transfer onward.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Intellectual Property Counsel",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Inventor or Assignee",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "IP or Legal Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Legal Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Prototype testing approvals",
     "title": "Prototype Testing Approval Form",
     "body_content": "This form documents the authorization to proceed with testing of a prototype under specified conditions and safety parameters. It outlines the testing scope, methodology, and criteria for evaluating results, along with any safety precautions required. The testing team is responsible for conducting tests in accordance with approved protocols, while approving parties are responsible for confirming that testing plans meet safety and quality standards before proceeding. The approval remains valid for the testing phase specified and is renewed for subsequent phases as needed.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "R&D Engineer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Quality Assurance Officer",
       "action_type": "Reviewer"
      },
      {
       "step": 3,
       "role": "R&D Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "R&D Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "R&D Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Confidentiality agreements for product development",
     "title": "Product Development Confidentiality Agreement",
     "body_content": "This agreement protects proprietary information shared between parties involved in the development of a new product or technology. It defines the scope of confidential information, permitted uses, and the duration of the confidentiality obligation, which typically extends beyond the conclusion of the development effort. The receiving party is responsible for safeguarding the information and using it solely for the agreed development purpose. The agreement remains binding for the period specified within it.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "R&D or Legal Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Involved Parties",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "R&D Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Legal Department",
       "action_type": "Archiver"
      }
     ]
    }
   ]
  },
  {
   "category": "Logistics & Distribution",
   "documents": [
    {
     "document_type": "Freight/shipping contracts",
     "title": "Freight and Shipping Agreement",
     "body_content": "This agreement sets out the terms under which goods are transported from one location to another by a carrier on behalf of a shipper. It specifies the mode of transport, delivery timeframe, liability for loss or damage in transit, and applicable fees. The carrier is responsible for transporting goods safely and within the agreed timeframe, while the shipper is responsible for accurate description of goods and timely payment of freight charges. The agreement remains valid for the shipment or contract period specified and concludes upon delivery and acceptance of goods.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Logistics Coordinator",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Carrier or Freight Provider",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Logistics Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Operations Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Logistics Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Customs documentation",
     "title": "Customs Declaration and Documentation Form",
     "body_content": "This document declares the nature, value, and origin of goods being imported or exported, as required by customs authorities. It supports the assessment of applicable duties, taxes, and regulatory compliance for cross-border movement of goods. The declaring party is responsible for providing accurate and complete information, while the customs authority is responsible for reviewing and clearing the declaration in accordance with applicable trade regulations. The document remains part of the shipment record and is retained for the period required by customs and trade regulations.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Customs Broker",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Shipper or Exporter",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Customs Officer",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Regulatory Authority",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Logistics Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Delivery acceptance forms",
     "title": "Delivery Acceptance Form",
     "body_content": "This form records the acceptance of goods upon delivery to their intended destination, confirming that the quantity and condition of items received match the shipment documentation. It notes any discrepancies, damage, or shortages identified upon inspection. The receiving party is responsible for inspecting and confirming receipt of goods, while the delivering party is responsible for addressing any confirmed discrepancies. The form becomes part of the logistics record once completed and supports subsequent invoicing and reconciliation processes.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Carrier or Driver",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Receiving Officer",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Warehouse Manager",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Logistics Department",
       "action_type": "Archiver"
      }
     ]
    },
    {
     "document_type": "Distributor agreements",
     "title": "Distributor Agreement",
     "body_content": "This agreement sets out the terms under which a distributor is authorized to market and sell an organization's products within a defined territory or channel. It specifies the scope of distribution rights, pricing and ordering terms, performance expectations, and any exclusivity provisions. The organization is responsible for supplying products as agreed, while the distributor is responsible for marketing and selling products in accordance with brand and quality standards. The agreement remains valid for the term specified and may be renewed, amended, or terminated according to its provisions.",
     "signing_workflow": [
      {
       "step": 1,
       "role": "Sales or Business Development Officer",
       "action_type": "Preparer"
      },
      {
       "step": 2,
       "role": "Distributor",
       "action_type": "Signer"
      },
      {
       "step": 3,
       "role": "Legal Counsel",
       "action_type": "Reviewer"
      },
      {
       "step": 4,
       "role": "Sales Director",
       "action_type": "Approver"
      },
      {
       "step": 5,
       "role": "Legal Department",
       "action_type": "Archiver"
      }
     ]
    }
   ]
  }
 ]
};
