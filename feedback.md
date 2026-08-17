RESPONSES: STILL TALKING, DO NOT WRITE OR CHANGE DOCS CODE YET. ONLY WHEN I TELL YOU GO_FIX_THIS


FIRST, Move the gated findings out of the register and into their milestones' specs

SECOND, do this Turn on the gate that has never once evaluated anything

C-003: I'd assume that on line level anything that shows different from 10 or 20 should be flagged. Then you let the end user decide. There's no point in comparing total invocie plausability because you can have mixed lines with 20 10 or no vat.

C-010 · I agree

C-009 · H1–H4 ·



C-013 · C-014 · C-016A/B · smoke: APPROVED

C-002: kk go ahead

c-006: Can we add a LCY (local currency) standard to all transactions and use it for limits and thresholds? That way every transaction also gets recalculated into RSD which is the local currency on the fly right away. so we keep original amt and currency and add another LCY which we can also use for reporting, and comparing against these 

Q18: VAT not charged – reverse charge

C-016A: i dont think this is super relevant because all the documents will have company name too. whatever we do right now I presume is good enough. probably better in 2 palces than accidentally skipping it

Q10: we can go 4 char. Months should not come up as dimensions ever so I don't think this will collide. I will also give you pre-defined dimensions that we will use. Any new dimension must be added via /tebra first then continued? is that a correct assumption?


image body:
"body": {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "399273073278215",
                "changes": [
                    {
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {
                                "display_phone_number": "15556247812",
                                "phone_number_id": "428414333687631"
                            },
                            "contacts": [
                                {
                                    "profile": {
                                        "name": "D"
                                    },
                                    "wa_id": "38162326456",
                                    "user_id": "RS.944284268515098"
                                }
                            ],
                            "messages": [
                                {
                                    "from": "38162326456",
                                    "from_user_id": "RS.944284268515098",
                                    "id": "wamid.HBgLMzgxNjIzMjY0NTYVAgASGBQ0QTVCOEFBMTExRDhDMjRDQzkzRQA=",
                                    "timestamp": "1786954093",
                                    "type": "image",
                                    "image": {
                                        "mime_type": "image/jpeg",
                                        "sha256": "JgXVLSrDZ67Qtv79uJlHKNkGn94DIt+EzFT2JZ7rayg=",
                                        "id": "2087719939296668",
                                        "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=2087719939296668&source=webhook&ext=1786954394&hash=ATxlIj8N_83t0lhrdS5s-275q4Tnf1shdtKu8zW__sgLFQ"
                                    }
                                }
                            ]
                        },
                        "field": "messages"
                    }
                ]
            }
        ]
    }


document body:
"body": {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "399273073278215",
                "changes": [
                    {
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {
                                "display_phone_number": "15556247812",
                                "phone_number_id": "428414333687631"
                            },
                            "contacts": [
                                {
                                    "profile": {
                                        "name": "D"
                                    },
                                    "wa_id": "38162326456",
                                    "user_id": "RS.944284268515098"
                                }
                            ],
                            "messages": [
                                {
                                    "from": "38162326456",
                                    "from_user_id": "RS.944284268515098",
                                    "id": "wamid.HBgLMzgxNjIzMjY0NTYVAgASGBQ0QUVGN0VGNkFEMTY0QjFBNDVGMQA=",
                                    "timestamp": "1786954112",
                                    "type": "document",
                                    "document": {
                                        "filename": "Mileva LLC Invoice 3.pdf",
                                        "mime_type": "application/pdf",
                                        "sha256": "AXmlmf9SLLkYt3r19pedqHy6yUKu6/IIrXI7Y+0IavU=",
                                        "id": "1023881880279106",
                                        "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1023881880279106&source=webhook&ext=1786954414&hash=ATyYw8nBTt06Cr0Nzp_NwmG93M1VZlYxUu3Ch4q-2fF8Eg"
                                    }
                                }
                            ]
                        },
                        "field": "messages"
                    }
                ]
            }
        ]
    }


As far as the NBS lookup: how hard would it be to leverage these public html-based entries, and extract data from the search. similar to generating via PIB or company name as below. Then extracting the result data from an html table named "responsive-table". This might be the first shortcut before I get my hands on the Web API access. However I presume this access will be expensive and I don't know hwere I am with the budgets. The alternative would be here: https://webservices.nbs.rs/WebSiteDoc/SerCyrl/default.html.  check and tell me how do I auth/register adn test this?



https://webappcenter.nbs.rs/PnWebApp/CompanyAccount/CompanyAccountResident?isSearchExecuted=true&BankCode=&AccountNumber=&ControlNumber=&CompanyNationalCode=&CompanyTaxCode=111886391&CompanyName=&City=&TypeID=1&OrderBy=&Pagging.CurrentPage=1&Pagging.PageSize=



https://webappcenter.nbs.rs/PnWebApp/CompanyAccount/CompanyAccountResident?isSearchExecuted=true&BankCode=&AccountNumber=&ControlNumber=&CompanyNationalCode=&CompanyTaxCode=&CompanyName=DILIGAF&City=&TypeID=1&OrderBy=&Pagging.CurrentPage=1&Pagging.PageSize=50



<table class="responsive-table">
    <thead>
        <tr>
            <th>Naziv korisnika računa</th>
            <th>Matični broj</th>
            <th>Poreski broj</th>
            <th>Adresa</th>
            <th>Mesto</th>
            <th>Opština</th>
            <th>Delatnost</th>
            <th>Banka</th>
            <th><div style="color:#154360">.....</div></th>
            <th>Račun</th>
            <th><div style="color:#154360">.....</div></th>
            <th>Status</th>
            <th>Podleže/ne podleže blokadi</th>
            <th>Datum otvaranja</th>
        </tr>
    </thead>
    <tbody>
            <tr>
                    <td data-title="Naziv korisnika računa">
                        <div>
                            <a href="/PnWebApp/CompanyAccount/Company/DetailsResident?NationalCode=21561070">
                                <b>DILIGAF DOO BEOGRAD-VRAČAR</b>
                            </a>
                        </div>
                    </td>
                    <td data-title="Matični broj">
                        <div>
                            <b> <a href="/PnWebApp/EnforcedCollectionDebtor/EnforcedCollectionDebtor/Index?NationalCode=21561070">21561070</a></b>
                        </div>
                    </td>
                <td data-title="Poreski broj">111886391    </td>

                <td data-title="Adresa">RUDNIČKA 6</td>
                <td data-title="Mesto">BEOGRAD-VRAČAR</td>
                <td data-title="Opština">Beograd-Vračar</td>

                    <td data-title="Delatnost">Konsultantske delatnosti u oblasti informacione te</td>
                <td data-title="Banka">Raiffeisen banka A.D.- Beograd</td>

                <td></td>
                <td data-title="Račun">
                    <div>
                        <b>265-6040310000759-38</b>
                    </div>
                </td>
                <td></td>
                        <td data-title="Status">
                            <div style="color:darkgreen">
                                <b> Uključen</b>
                            </div>
                        </td>

                    <td data-title="Podleže/ne podleže blokadi">
                        <div>
                            Podleže blokadi
                        </div>
                    </td>

                    <td data-title="Datum otvaranja">
                        <div>
                            27.2.2020.
                        </div>
                    </td>

            </tr>
    </tbody>
</table>


Q17 - email is danilo@diligaf.rs