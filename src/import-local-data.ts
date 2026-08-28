import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CompetitorDataset, type CompetitorDatasetStore } from './competitor-dataset.js'
import { CustomerSalesCache, type CustomerCacheFile } from './cache.js'
import { clearCustomerDirectory, saveCustomerDirectory } from './customer-directory.js'
import { prisma } from './db.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const importDirectory = path.resolve(process.env.DATA_IMPORT_DIR || path.join(root, 'data'))

async function readJson<T>(fileName: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(importDirectory, fileName), 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function main() {
  const replace = process.argv.includes('--replace')
  const resume = process.argv.includes('--resume')
  const [invoiceCount, cacheCount, directoryCount, snapshotCount] = await Promise.all([
    prisma.invoice.count(),
    prisma.customerSalesCache.count(),
    prisma.customerDirectoryEntry.count(),
    prisma.customerCrossSnapshot.count(),
  ])
  const existingRecords = invoiceCount + cacheCount + directoryCount + snapshotCount
  if (existingRecords > 0 && !replace && !resume) {
    throw new Error(
      `PostgreSQL ya contiene ${existingRecords} registros persistidos. Usa --resume para completar una importación interrumpida o --replace para sustituirlos.`,
    )
  }
  if (replace) {
    await Promise.all([new CustomerSalesCache().clear(), clearCustomerDirectory()])
  }

  const dataset = await readJson<CompetitorDatasetStore>('competitor-invoices.json')
  if (dataset) {
    await new CompetitorDataset().importLegacy(dataset, { replace })
    console.log(`Facturas importadas: ${dataset.invoices?.length || 0}`)
  }

  const cacheData = await readJson<CustomerCacheFile>('customer-sales-cache.json')
  if (cacheData) {
    const cache = new CustomerSalesCache()
    const byPeriod = new Map<string, typeof cacheData.entries[string][]>()
    for (const entry of Object.values(cacheData.entries || {})) {
      const periodKey = entry.periodKey || String(entry.year)
      const values = byPeriod.get(periodKey) || []
      values.push(entry)
      byPeriod.set(periodKey, values)
    }
    for (const [periodKey, entries] of byPeriod) await cache.saveMany(entries, periodKey)
    console.log(`Entradas de caché importadas: ${Object.keys(cacheData.entries || {}).length}`)
  }

  for (const extension of ['xlsx', 'xls', 'csv']) {
    const fileName = `mis-clientes.${extension}`
    try {
      const buffer = await fs.readFile(path.join(importDirectory, fileName))
      const rows = await saveCustomerDirectory(fileName, buffer)
      console.log(`Clientes importados: ${rows.length}`)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
