import type { ApiMonthlySalesRow, OwnCustomerSalesSummary } from './types.js'
import { isUsableCustomerRfc, normalizeRfc } from './excel.js'
import { CustomerSalesCache } from './cache.js'

export const DEFAULT_API_BASE_URL = 'https://tuvansa-backend-ca-bd6a98f4a4d2.herokuapp.com'
export const DEFAULT_API_PATH = '/api/erp/customers/monthly-sales-summary'

export async function fetchCustomerMonthlySalesSummary({
  baseUrl,
  apiPath,
  taxId,
  startDate,
  endDate,
  timeoutMs,
}: {
  baseUrl: string
  apiPath: string
  taxId: string
  startDate: string
  endDate: string
  timeoutMs: number
}) {
  const url = new URL(apiPath, baseUrl)
  url.searchParams.set('taxId', taxId)
  url.searchParams.set('startDate', startDate)
  url.searchParams.set('endDate', endDate)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`La API respondió ${response.status} ${response.statusText} para ${taxId}`)
    }

    const data = (await response.json()) as ApiMonthlySalesRow[]
    return data.map((row) => ({
      ...row,
      taxId: normalizeRfc(row.taxId),
      customerName: String(row.customerName || row.taxId).trim(),
      customerCode: String(row.customerCode || '').trim(),
      subtotalAmount: Number(row.subtotalAmount || 0),
      totalAmount: Number(row.totalAmount || 0),
    }))
  } finally {
    clearTimeout(timeout)
  }
}

export function summarizeOwnCustomerSales(rows: ApiMonthlySalesRow[]) {
  if (rows.length === 0) return null

  return {
    taxId: rows[0].taxId,
    customerName: rows[0].customerName,
    customerCode: rows[0].customerCode,
    subtotalAmount: rows.reduce((sum, row) => sum + row.subtotalAmount, 0),
    totalAmount: rows.reduce((sum, row) => sum + row.totalAmount, 0),
    activeMonths: Array.from(new Set(rows.map((row) => row.month))).sort((a, b) => a - b),
    monthly: [...rows].sort((a, b) => (a.year - b.year) || (a.month - b.month)),
  } satisfies OwnCustomerSalesSummary
}

export async function fetchCustomerSalesByTaxIdsWithCache({
  cache,
  baseUrl,
  apiPath,
  taxIds,
  startDate,
  endDate,
  concurrency,
  timeoutMs,
  periodKey,
}: {
  cache: CustomerSalesCache
  baseUrl: string
  apiPath: string
  taxIds: string[]
  startDate: string
  endDate: string
  concurrency: number
  timeoutMs: number
  periodKey: string
}) {
  const uniqueTaxIds = Array.from(new Set(taxIds.map(normalizeRfc).filter(isUsableCustomerRfc)))
  const { found, missing } = await cache.getMany(uniqueTaxIds, periodKey)
  const fetched: OwnCustomerSalesSummary[] = []

  for (let index = 0; index < missing.length; index += concurrency) {
    const batch = missing.slice(index, index + concurrency)
    const batchResults = await Promise.all(
      batch.map(async (taxId) => {
        try {
          const rows = await fetchCustomerMonthlySalesSummary({
            baseUrl,
            apiPath,
            taxId,
            startDate,
            endDate,
            timeoutMs,
          })
          return summarizeOwnCustomerSales(rows)
        } catch {
          return null
        }
      }),
    )

    fetched.push(...batchResults.filter((item): item is Exclude<typeof item, null> => item !== null))
  }

  if (fetched.length > 0) {
    await cache.saveMany(fetched, periodKey)
  }

  return {
    summaries: [...found, ...fetched],
    cacheHits: found.length,
    apiFetches: fetched.length,
    missingCount: missing.length - fetched.length,
  }
}
