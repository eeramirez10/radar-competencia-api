import * as XLSX from 'xlsx'
import type {
  CompetitorOverlapPoint,
  CustomerCompetitionRow,
  CustomerDirectoryMatchRow,
  LocalCustomerDirectoryRow,
  NormalizedInvoice,
  OwnCustomerSalesSummary,
  WorkbookInvoiceRow,
} from './types.js'

const EXPECTED_HEADERS = [
  'FolioFiscal',
  'RfcEmisor',
  'NombreRazonSocialEmisor',
  'RfcReceptor',
  'NombreRazonSocialReceptor',
  'FechaEmision',
  'FechaCertificacion',
  'Subtotal',
  'Total',
  'EstadoComprobante',
  'EfectoComprobante',
]

const CSV_EXTENSION_RE = /\.csv$/i

function readWorkbookFromBuffer(fileName: string, buffer: Buffer) {
  if (CSV_EXTENSION_RE.test(fileName)) {
    return XLSX.read(buffer.toString('utf8'), { type: 'string' })
  }

  return XLSX.read(buffer, { type: 'buffer' })
}

export function normalizeRfc(value = '') {
  return String(value).trim().toUpperCase()
}

export function isUsableCustomerRfc(value = '') {
  const normalized = normalizeRfc(value)
  return normalized.length >= 12 && !['XEXX010101000', 'XAXX010101000'].includes(normalized)
}

function toNumber(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, '').trim())
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function buildSafeDate(year: number, month: number, day: number, hours = 0, minutes = 0, seconds = 0) {
  const date = new Date(year, month - 1, day, hours, minutes, seconds)
  if (Number.isNaN(date.getTime())) return null
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }
  return date
}

export function parseInvoiceDate(value: unknown) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const serial = XLSX.SSF.parse_date_code(value)
    if (serial?.y && serial?.m && serial?.d) {
      return buildSafeDate(serial.y, serial.m, serial.d, serial.H || 0, serial.M || 0, Math.floor(serial.S || 0))
    }
  }

  const normalized = String(value ?? '').trim()
  if (!normalized) return null

  if (/^\d+(\.\d+)?$/.test(normalized)) {
    const serial = XLSX.SSF.parse_date_code(Number(normalized))
    if (serial?.y && serial?.m && serial?.d) {
      return buildSafeDate(serial.y, serial.m, serial.d, serial.H || 0, serial.M || 0, Math.floor(serial.S || 0))
    }
  }

  const dmyMatch = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (dmyMatch) {
    const [, day, month, year, hours = '0', minutes = '0', seconds = '0'] = dmyMatch
    return buildSafeDate(Number(year), Number(month), Number(day), Number(hours), Number(minutes), Number(seconds))
  }

  const ymdMatch = normalized.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (ymdMatch) {
    const [, year, month, day, hours = '0', minutes = '0', seconds = '0'] = ymdMatch
    return buildSafeDate(Number(year), Number(month), Number(day), Number(hours), Number(minutes), Number(seconds))
  }

  const fallback = new Date(normalized)
  return Number.isNaN(fallback.getTime()) ? null : fallback
}

export function getInvoiceTimestamp(value: unknown) {
  return parseInvoiceDate(value)?.getTime() ?? 0
}

function normalizeStatus(value = ''): NormalizedInvoice['status'] {
  const normalized = String(value).trim().toLowerCase()
  if (normalized === 'vigente') return 'Vigente'
  if (normalized === 'cancelado') return 'Cancelado'
  return 'Otro'
}

function normalizeEffect(value = ''): NormalizedInvoice['effect'] {
  const normalized = String(value).trim().toLowerCase()
  if (normalized === 'ingreso') return 'Ingreso'
  if (normalized === 'egreso') return 'Egreso'
  if (normalized === 'pago') return 'Pago'
  if (normalized === 'traslado') return 'Traslado'
  return 'Otro'
}

function detectDirection(rows: WorkbookInvoiceRow[], fileName: string): NormalizedInvoice['direction'] {
  const emisorCounts: Record<string, number> = {}
  const receptorCounts: Record<string, number> = {}

  for (const row of rows) {
    emisorCounts[row.RfcEmisor] = (emisorCounts[row.RfcEmisor] || 0) + 1
    receptorCounts[row.RfcReceptor] = (receptorCounts[row.RfcReceptor] || 0) + 1
  }

  const topEmisor = Object.entries(emisorCounts).sort((a, b) => b[1] - a[1])[0]
  const topReceptor = Object.entries(receptorCounts).sort((a, b) => b[1] - a[1])[0]

  if ((topEmisor?.[1] || 0) > (topReceptor?.[1] || 0)) return 'emitida'
  if ((topReceptor?.[1] || 0) > (topEmisor?.[1] || 0)) return 'recibida'

  const lower = fileName.toLowerCase()
  if (lower.includes('emit')) return 'emitida'
  if (lower.includes('recib')) return 'recibida'

  throw new Error(`No se pudo detectar dirección para ${fileName}`)
}

export function workbookRowsFromBuffer(fileName: string, buffer: Buffer) {
  const workbook = readWorkbookFromBuffer(fileName, buffer)
  const firstSheetName = workbook.SheetNames[0]
  const worksheet = workbook.Sheets[firstSheetName]
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: '', raw: false })
  const headers = Object.keys(rawRows[0] || {})
  const missingHeaders = EXPECTED_HEADERS.filter((header) => !headers.includes(header))

  if (missingHeaders.length > 0) {
    throw new Error(`El archivo ${fileName} no tiene la estructura esperada. Faltan: ${missingHeaders.join(', ')}`)
  }

  const rows: WorkbookInvoiceRow[] = rawRows.map((row) => ({
    FolioFiscal: String(row.FolioFiscal || '').trim(),
    RfcEmisor: normalizeRfc(String(row.RfcEmisor || '')),
    NombreRazonSocialEmisor: String(row.NombreRazonSocialEmisor || '').trim(),
    RfcReceptor: normalizeRfc(String(row.RfcReceptor || '')),
    NombreRazonSocialReceptor: String(row.NombreRazonSocialReceptor || '').trim(),
    FechaEmision: String(row.FechaEmision || '').trim(),
    FechaCertificacion: String(row.FechaCertificacion || '').trim(),
    Subtotal: toNumber(row.Subtotal),
    Total: toNumber(row.Total),
    EstadoComprobante: String(row.EstadoComprobante || '').trim(),
    EfectoComprobante: String(row.EfectoComprobante || '').trim(),
  }))

  const direction = detectDirection(rows, fileName)

  return rows.map<NormalizedInvoice>((row) => {
    const issued = parseInvoiceDate(row.FechaEmision)
    const year = issued ? issued.getFullYear() : 0
    const month = issued ? issued.getMonth() + 1 : 0

    return {
      id: row.FolioFiscal,
      sourceFileName: fileName,
      direction,
      companyRfc: direction === 'emitida' ? row.RfcEmisor : row.RfcReceptor,
      companyName: direction === 'emitida' ? row.NombreRazonSocialEmisor : row.NombreRazonSocialReceptor,
      counterpartyRfc: direction === 'emitida' ? row.RfcReceptor : row.RfcEmisor,
      counterpartyName: direction === 'emitida' ? row.NombreRazonSocialReceptor : row.NombreRazonSocialEmisor,
      issuedAt: row.FechaEmision,
      certifiedAt: row.FechaCertificacion,
      subtotal: row.Subtotal,
      total: row.Total,
      status: normalizeStatus(row.EstadoComprobante),
      effect: normalizeEffect(row.EfectoComprobante),
      year,
      month,
      monthKey: year > 0 && month > 0 ? `${year}-${String(month).padStart(2, '0')}` : 'sin-fecha',
    }
  })
}

export function dedupeInvoices(rows: NormalizedInvoice[]) {
  const map = new Map<string, NormalizedInvoice>()
  for (const row of rows) {
    if (!map.has(row.id)) map.set(row.id, row)
  }
  return Array.from(map.values())
}

export function getExcelCustomerTaxIds(invoices: NormalizedInvoice[]) {
  return Array.from(
    new Set(
      invoices
        .filter((invoice) => invoice.direction === 'emitida' && invoice.status === 'Vigente')
        .map((invoice) => normalizeRfc(invoice.counterpartyRfc))
        .filter(isUsableCustomerRfc),
    ),
  )
}

export function parseCustomerDirectoryFromBuffer(fileName: string, buffer: Buffer): LocalCustomerDirectoryRow[] {
  const workbook = readWorkbookFromBuffer(fileName, buffer)
  const targetSheetName = workbook.SheetNames.find((name) => name.trim().toLowerCase() === 'mis-clientes') || workbook.SheetNames[0]
  const worksheet = workbook.Sheets[targetSheetName]
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: '', raw: false })

  const rows = rawRows
    .map((row) => {
      const customerName = String(row.nombre || row.Nombre || row.NOMBRE || '').trim()
      const taxId = normalizeRfc(String(row.rfc || row.RFC || row.Rfc || ''))
      return {
        customerName,
        taxId,
        sourceFileName: fileName,
      }
    })
    .filter((row) => row.customerName && isUsableCustomerRfc(row.taxId))

  const unique = new Map<string, LocalCustomerDirectoryRow>()
  for (const row of rows) {
    if (!unique.has(row.taxId)) unique.set(row.taxId, row)
  }

  return Array.from(unique.values())
}

export function buildCustomerDirectoryMatches({
  directory,
  invoices,
}: {
  directory: LocalCustomerDirectoryRow[]
  invoices: NormalizedInvoice[]
}): CustomerDirectoryMatchRow[] {
  if (directory.length === 0) return []

  const directoryMap = new Map(
    directory
      .map((row) => [normalizeRfc(row.taxId), row] as const)
      .filter(([taxId]) => isUsableCustomerRfc(taxId)),
  )

  const invoiceMatches = invoices.filter(
    (invoice) =>
      invoice.direction === 'emitida' &&
      invoice.status === 'Vigente' &&
      directoryMap.has(normalizeRfc(invoice.counterpartyRfc)),
  )

  const grouped = new Map<string, { customerName: string; competitorSalesTotal: number; companies: Map<string, { name: string; total: number }>; lastDetectedMonth?: string }>()

  invoiceMatches.forEach((invoice) => {
    const customerTaxId = normalizeRfc(invoice.counterpartyRfc)
    const directoryEntry = directoryMap.get(customerTaxId)
    if (!directoryEntry) return

    const current = grouped.get(customerTaxId) ?? {
      customerName: directoryEntry.customerName,
      competitorSalesTotal: 0,
      companies: new Map<string, { name: string; total: number }>(),
      lastDetectedMonth: undefined,
    }

    current.competitorSalesTotal += invoice.subtotal

    const currentCompany = current.companies.get(invoice.companyRfc) ?? {
      name: invoice.companyName,
      total: 0,
    }
    currentCompany.total += invoice.subtotal
    current.companies.set(invoice.companyRfc, currentCompany)

    if (!current.lastDetectedMonth || invoice.monthKey > current.lastDetectedMonth) {
      current.lastDetectedMonth = invoice.monthKey
    }

    grouped.set(customerTaxId, current)
  })

  return Array.from(grouped.entries())
    .map(([customerTaxId, entry]) => {
      const orderedCompanies = Array.from(entry.companies.values()).sort((a, b) => b.total - a.total)

      return {
        customerTaxId,
        customerName: entry.customerName,
        competitorSalesTotal: entry.competitorSalesTotal,
        competitorCompanies: entry.companies.size,
        topCompetitorName: orderedCompanies[0]?.name,
        topCompetitorAmount: orderedCompanies[0]?.total ?? 0,
        lastDetectedMonth: entry.lastDetectedMonth,
      }
    })
    .sort((a, b) => b.competitorSalesTotal - a.competitorSalesTotal)
}

export function getDirectoryMatchedTaxIds(matches: CustomerDirectoryMatchRow[]) {
  return matches.map((match) => normalizeRfc(match.customerTaxId)).filter(isUsableCustomerRfc)
}

export function buildCustomerCompetitionRows({
  customerSummaries,
  invoices,
}: {
  customerSummaries: OwnCustomerSalesSummary[]
  invoices: NormalizedInvoice[]
}): CustomerCompetitionRow[] {
  if (customerSummaries.length === 0) return []

  const rows: CustomerCompetitionRow[] = []

  customerSummaries.forEach((customerSummary) => {
    const customerRfc = normalizeRfc(customerSummary.taxId)
    if (!isUsableCustomerRfc(customerRfc)) return

    const matches = invoices.filter(
      (invoice) =>
        invoice.direction === 'emitida' &&
        normalizeRfc(invoice.counterpartyRfc) === customerRfc &&
        invoice.status === 'Vigente',
    )

    const companyTotals = new Map<string, { name: string; total: number }>()

    matches.forEach((invoice) => {
      const current = companyTotals.get(invoice.companyRfc) ?? { name: invoice.companyName, total: 0 }
      current.total += invoice.subtotal
      companyTotals.set(invoice.companyRfc, current)
    })

    const ordered = Array.from(companyTotals.entries())
      .map(([rfc, entry]) => ({ rfc, ...entry }))
      .sort((a, b) => b.total - a.total)

    const competitorSalesTotal = matches.reduce((sum, invoice) => sum + invoice.subtotal, 0)
    const lastInvoice = matches
      .slice()
      .sort((a, b) => getInvoiceTimestamp(b.issuedAt) - getInvoiceTimestamp(a.issuedAt))[0]

    rows.push({
      customerTaxId: customerSummary.taxId,
      customerName: customerSummary.customerName,
      ownSalesTotal: customerSummary.subtotalAmount,
      competitorSalesTotal,
      gapAmount: customerSummary.subtotalAmount - competitorSalesTotal,
      competitorCompanies: ordered.length,
      topCompetitorName: ordered[0]?.name,
      topCompetitorAmount: ordered[0]?.total ?? 0,
      lastDetectedMonth: lastInvoice?.monthKey,
    })
  })

  return rows.sort((a, b) => b.competitorSalesTotal - a.competitorSalesTotal)
}

export function buildCompetitorOverlap({
  customerSummaries,
  invoices,
}: {
  customerSummaries: OwnCustomerSalesSummary[]
  invoices: NormalizedInvoice[]
}): CompetitorOverlapPoint[] {
  if (customerSummaries.length === 0) return []

  const ownCustomerTaxIds = new Set(
    customerSummaries.map((item) => normalizeRfc(item.taxId)).filter(isUsableCustomerRfc),
  )
  const companyMap = new Map<string, CompetitorOverlapPoint>()

  invoices
    .filter(
      (invoice) =>
        invoice.direction === 'emitida' &&
        invoice.status === 'Vigente' &&
        ownCustomerTaxIds.has(normalizeRfc(invoice.counterpartyRfc)),
    )
    .forEach((invoice) => {
      const current = companyMap.get(invoice.companyRfc) ?? {
        competitorRfc: invoice.companyRfc,
        competitorName: invoice.companyName,
        matchedCustomers: 0,
        competitorSalesTotal: 0,
      }

      current.competitorSalesTotal += invoice.subtotal
      companyMap.set(invoice.companyRfc, current)
    })

  const matchedCustomerCountByCompany = new Map<string, Set<string>>()

  invoices
    .filter(
      (invoice) =>
        invoice.direction === 'emitida' &&
        invoice.status === 'Vigente' &&
        ownCustomerTaxIds.has(normalizeRfc(invoice.counterpartyRfc)),
    )
    .forEach((invoice) => {
      const set = matchedCustomerCountByCompany.get(invoice.companyRfc) ?? new Set<string>()
      set.add(normalizeRfc(invoice.counterpartyRfc))
      matchedCustomerCountByCompany.set(invoice.companyRfc, set)
    })

  return Array.from(companyMap.values())
    .map((item) => ({
      ...item,
      matchedCustomers: matchedCustomerCountByCompany.get(item.competitorRfc)?.size ?? 0,
    }))
    .sort((a, b) => b.competitorSalesTotal - a.competitorSalesTotal)
}
