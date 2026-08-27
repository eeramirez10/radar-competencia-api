import ExcelJS from 'exceljs'
import type { NormalizedInvoice, OwnCustomerSalesSummary } from './types.js'

function currency(value: number) {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    maximumFractionDigits: 2,
  }).format(value || 0)
}

function buildCustomerCompetitionRows(customerSummaries: OwnCustomerSalesSummary[], invoices: NormalizedInvoice[]) {
  return customerSummaries
    .map((customerSummary) => {
      const matches = invoices.filter(
        (invoice) =>
          invoice.direction === 'emitida' &&
          invoice.status === 'Vigente' &&
          invoice.counterpartyRfc === customerSummary.taxId,
      )

      const competitorTotals = new Map<string, { name: string; total: number }>()
      for (const invoice of matches) {
        const current = competitorTotals.get(invoice.companyRfc) || { name: invoice.companyName, total: 0 }
        current.total += invoice.subtotal
        competitorTotals.set(invoice.companyRfc, current)
      }

      const ordered = Array.from(competitorTotals.values()).sort((a, b) => b.total - a.total)
      const competitorSalesTotal = matches.reduce((sum, invoice) => sum + invoice.subtotal, 0)

      return {
        customerName: customerSummary.customerName,
        customerTaxId: customerSummary.taxId,
        ownSalesTotal: customerSummary.subtotalAmount,
        competitorSalesTotal,
        gapAmount: customerSummary.subtotalAmount - competitorSalesTotal,
        topCompetitorName: ordered[0]?.name || 'Sin detección',
      }
    })
    .sort((a, b) => b.competitorSalesTotal - a.competitorSalesTotal)
}

export async function generateSimpleWorkbook({
  invoices,
  ownCustomerSummaries,
  companyName,
  year,
  cacheHits,
  apiFetches,
}: {
  invoices: NormalizedInvoice[]
  ownCustomerSummaries: OwnCustomerSalesSummary[]
  companyName: string
  year: number
  cacheHits: number
  apiFetches: number
}) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Jake / OpenClaw'
  workbook.created = new Date()

  const summary = workbook.addWorksheet('Resumen')
  summary.addRow(['Radar competencia backend'])
  summary.addRow(['Empresa', companyName])
  summary.addRow(['Año analizado', year])
  summary.addRow(['Documentos', invoices.length])
  summary.addRow(['Clientes API', ownCustomerSummaries.length])
  summary.addRow(['Cache hits', cacheHits])
  summary.addRow(['Consultas nuevas API', apiFetches])

  const detail = workbook.addWorksheet('TUVANSA vs competencia')
  detail.addRow(['Cliente', 'RFC', 'Venta TUVANSA', 'Venta competencia', 'Ganado / perdido', 'Top competidor'])

  for (const row of buildCustomerCompetitionRows(ownCustomerSummaries, invoices)) {
    detail.addRow([
      row.customerName,
      row.customerTaxId,
      row.ownSalesTotal,
      row.competitorSalesTotal,
      row.gapAmount,
      row.topCompetitorName,
    ])
  }

  detail.getColumn(3).numFmt = '[$$-es-MX]#,##0.00'
  detail.getColumn(4).numFmt = '[$$-es-MX]#,##0.00'
  detail.getColumn(5).numFmt = '[$$-es-MX]#,##0.00'

  const note = workbook.addWorksheet('Notas')
  note.addRow(['Resumen ejecutivo'])
  note.addRow([
    `El archivo compara ventas TUVANSA contra competencia sobre clientes compartidos. La API se cachea por RFC + año para evitar búsquedas repetidas.`,
  ])
  note.addRow([
    `Clientes consultados: ${ownCustomerSummaries.length}. Cache reutilizado: ${cacheHits}. Nuevas consultas: ${apiFetches}.`,
  ])
  note.addRow([
    `Subtotal TUVANSA total: ${currency(ownCustomerSummaries.reduce((sum, item) => sum + item.subtotalAmount, 0))}`,
  ])

  return workbook
}
