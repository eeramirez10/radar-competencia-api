export type InvoiceDirection = 'emitida' | 'recibida'
export type InvoiceStatus = 'Vigente' | 'Cancelado' | 'Otro'
export type EffectType = 'Ingreso' | 'Egreso' | 'Pago' | 'Traslado' | 'Otro'

export interface WorkbookInvoiceRow {
  FolioFiscal: string
  RfcEmisor: string
  NombreRazonSocialEmisor: string
  RfcReceptor: string
  NombreRazonSocialReceptor: string
  FechaEmision: string
  FechaCertificacion: string
  Subtotal: number
  Total: number
  EstadoComprobante: string
  EfectoComprobante: string
}

export interface NormalizedInvoice {
  id: string
  sourceFileName: string
  direction: InvoiceDirection
  companyRfc: string
  companyName: string
  counterpartyRfc: string
  counterpartyName: string
  issuedAt: string
  certifiedAt: string
  subtotal: number
  total: number
  status: InvoiceStatus
  effect: EffectType
  year: number
  month: number
  monthKey: string
}

export interface ApiMonthlySalesRow {
  year: number
  month: number
  customerCode: string
  customerName: string
  taxId: string
  subtotalAmount: number
  totalAmount: number
}

export interface OwnCustomerSalesSummary {
  taxId: string
  customerName: string
  customerCode?: string
  totalAmount: number
  subtotalAmount: number
  activeMonths: number[]
  monthly: ApiMonthlySalesRow[]
}

export interface CacheEntry extends OwnCustomerSalesSummary {
  year: number
  periodKey?: string
  status: 'success'
  fetchedAt: string
}

export interface LocalCustomerDirectoryRow {
  taxId: string
  customerName: string
  sourceFileName: string
}

export interface CustomerDirectoryMatchRow {
  customerTaxId: string
  customerName: string
  competitorSalesTotal: number
  competitorCompanies: number
  topCompetitorName?: string
  topCompetitorAmount: number
  lastDetectedMonth?: string
}

export interface CustomerCompetitionRow {
  customerTaxId: string
  customerName: string
  ownSalesTotal: number
  competitorSalesTotal: number
  gapAmount: number
  competitorCompanies: number
  topCompetitorName?: string
  topCompetitorAmount: number
  lastDetectedMonth?: string
}

export interface CompetitorOverlapPoint {
  competitorRfc: string
  competitorName: string
  matchedCustomers: number
  competitorSalesTotal: number
}
