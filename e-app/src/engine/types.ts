// E — shared domain types. The contract every engine module and test is written against.

import type { VatMode } from './invoicing/vat-mode.js'
export type { VatMode }

export type BookCode = 'DILIGAF' | 'PERSONAL' | 'SMOQUA'
export type Currency = 'RSD' | 'EUR' | 'USD' | 'CHF' | 'GBP'
export type DocCategory = 'izvod' | 'statement' | 'expense' | 'invoice_out' | 'sef_inbound' | 'other'
export type ReviewStatus = 'ok' | 'needs_review' | 'reviewed'
export type Confidence = 'exact' | 'high' | 'medium' | 'low'

/** Which rung of the extraction ladder produced a set of facts (01-ARCHITECTURE §5). */
export type ExtractionMethod =
  | 'cache' | 'fiscal_qr' | 'vendor_profile' | 'pdf_text'
  | 'di_invoice' | 'di_receipt' | 'llm_vision' | 'manual'

export interface DimensionAxisDef {
  axis: string
  type: 'closed_set' | 'open_text'
  required: boolean
  values?: string[]
  /** canonical value -> accepted aliases */
  aliases?: Record<string, string[]>
}

export interface Book {
  code: BookCode
  name: string
  senderPhones: string[]
  blobPrefix: string
  defaultCategory: DocCategory
  accountantEmail: string | null
  currency: Currency
  dimensions: DimensionAxisDef[]
  features: {
    sef: boolean
    invoicing: boolean
    vat: VatMode | null
    /** amounts at or above this require an explicit confirmation tap */
    confirmAboveAmount: number
  }
}

/** A parsed monetary amount. Absence is expressed by returning null, never by a zero. */
export interface Money {
  amount: number
  currency: Currency
}

export type DimensionValues = Record<string, string | null>

export interface ExtractedFacts {
  vendorName: string | null
  vendorPib: string | null
  docDate: string | null          // YYYY-MM-DD
  amountNet: number | null
  vatAmount: number | null
  amountTotal: number | null
  currency: Currency | null
  lineItems: LineItem[]
}

export interface LineItem {
  description: string
  quantity: number | null
  unitPrice: number | null
  lineTotal: number | null
}

export interface Extraction {
  method: ExtractionMethod
  confidence: Confidence
  model: string | null            // e.g. "gpt-4o-mini@2026-05"; null for non-model rungs
  raw?: unknown
}

export interface DocumentFacts extends ExtractedFacts {
  book: BookCode
  category: DocCategory
  period: string                  // YYYY-MM
  source: 'whatsapp' | 'email' | 'sef' | 'generated'
  sourceRef: string
  blobPath: string
  filename: string
  mimeType: string
  byteSize: number
  sha256: string
  amountRsd: number | null
  dimensions: DimensionValues
  extraction: Extraction
  reviewStatus: ReviewStatus
  createdAt: string               // ISO
}

export type TxDirection = 'in' | 'out'
export type TxSource = 'statement' | 'cash' | 'tx_email' | 'manual' | 'document'

export interface Transaction {
  id: string
  book: BookCode
  txDate: string                  // YYYY-MM-DD
  valueDate: string | null
  description: string
  counterparty: string | null
  amount: number                  // signed: negative = outflow
  currency: Currency
  amountRsd: number | null
  direction: TxDirection
  category: string                // 'MISC' when unresolved
  dimensions: DimensionValues
  source: TxSource
  sourceDocument: string | null
  dedupeKey: string
  reviewStatus: ReviewStatus
  createdAt: string
}

/** Injected — engine never reads the system clock. */
export interface Clock { now(): Date }
/** Injected — engine never generates randomness. */
export interface IdGen { next(): string }

