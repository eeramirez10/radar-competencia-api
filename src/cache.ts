import type { ApiMonthlySalesRow, CacheEntry, OwnCustomerSalesSummary } from './types.js'
import { normalizeRfc } from './excel.js'
import { prisma } from './db.js'
import { Prisma } from './generated/prisma/client.js'

export interface CustomerCacheFile {
  version: number
  updatedAt: string
  entries: Record<string, CacheEntry>
}

export function getCacheKey(taxId: string, periodKey: string) {
  return `${normalizeRfc(taxId)}::${periodKey}`
}

function toSummary(row: {
  taxId: string
  customerName: string
  customerCode: string | null
  totalAmount: unknown
  subtotalAmount: unknown
  activeMonths: number[]
  monthly: unknown
}): OwnCustomerSalesSummary {
  return {
    taxId: row.taxId,
    customerName: row.customerName,
    customerCode: row.customerCode || undefined,
    totalAmount: Number(row.totalAmount),
    subtotalAmount: Number(row.subtotalAmount),
    activeMonths: row.activeMonths,
    monthly: row.monthly as ApiMonthlySalesRow[],
  }
}

export class CustomerSalesCache {
  async read(): Promise<CustomerCacheFile> {
    const rows = await prisma.customerSalesCache.findMany()
    return {
      version: 1,
      updatedAt: rows.reduce(
        (latest, row) => row.updatedAt.toISOString() > latest ? row.updatedAt.toISOString() : latest,
        new Date(0).toISOString(),
      ),
      entries: Object.fromEntries(rows.map((row) => [getCacheKey(row.taxId, row.periodKey), {
        ...toSummary(row),
        year: row.year,
        periodKey: row.periodKey,
        status: 'success' as const,
        fetchedAt: row.fetchedAt.toISOString(),
      }])),
    }
  }

  async getMany(taxIds: string[], periodKey: string) {
    const normalizedTaxIds = taxIds.map(normalizeRfc)
    const rows = await prisma.customerSalesCache.findMany({
      where: { periodKey, taxId: { in: normalizedTaxIds } },
    })
    const foundByTaxId = new Map(rows.map((row) => [row.taxId, toSummary(row)]))

    return {
      found: normalizedTaxIds.flatMap((taxId) => foundByTaxId.has(taxId) ? [foundByTaxId.get(taxId)!] : []),
      missing: normalizedTaxIds.filter((taxId) => !foundByTaxId.has(taxId)),
      data: null,
    }
  }

  async saveMany(summaries: OwnCustomerSalesSummary[], periodKey: string) {
    if (summaries.length === 0) return

    await prisma.$transaction(summaries.map((summary) => prisma.customerSalesCache.upsert({
      where: { taxId_periodKey: { taxId: normalizeRfc(summary.taxId), periodKey } },
      create: {
        taxId: normalizeRfc(summary.taxId), periodKey, customerName: summary.customerName,
        customerCode: summary.customerCode || null, totalAmount: summary.totalAmount,
        subtotalAmount: summary.subtotalAmount, activeMonths: summary.activeMonths,
        monthly: summary.monthly as unknown as Prisma.InputJsonValue, year: summary.monthly[0]?.year ?? 0,
        status: 'success', fetchedAt: new Date(),
      },
      update: {
        customerName: summary.customerName, customerCode: summary.customerCode || null,
        totalAmount: summary.totalAmount, subtotalAmount: summary.subtotalAmount,
        activeMonths: summary.activeMonths, monthly: summary.monthly as unknown as Prisma.InputJsonValue,
        year: summary.monthly[0]?.year ?? 0, status: 'success', fetchedAt: new Date(),
      },
    })))
  }

  async clear() {
    await prisma.customerSalesCache.deleteMany()
  }
}
