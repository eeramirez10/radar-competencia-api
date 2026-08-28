import path from 'node:path'
import compression from 'compression'
import cors from 'cors'
import express from 'express'
import multer from 'multer'
import { CustomerSalesCache } from './cache.js'
import { CompetitorDataset } from './competitor-dataset.js'
import {
  buildCompetitorOverlap,
  buildCustomerCompetitionRows,
  buildCustomerDirectoryMatches,
  getDirectoryMatchedTaxIds,
  getExcelCustomerTaxIds,
  getInvoiceTimestamp,
  normalizeRfc,
} from './excel.js'
import { getCustomerDirectory, saveCustomerDirectory } from './customer-directory.js'
import { prisma } from './db.js'
import type { OwnCustomerSalesSummary } from './types.js'
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_API_PATH,
  fetchCustomerMonthlySalesSummary,
  summarizeOwnCustomerSales,
  fetchCustomerSalesByTaxIdsWithCache,
} from './customer-api.js'
import { generateSimpleWorkbook } from './report-generator.js'
import { archiveUploadedFiles } from './file-storage.js'

const DATABASE_STORAGE = process.env.DATABASE_STORAGE_LABEL || 'postgresql-docker'
const SUPPORTED_DIRECTORY_EXTENSIONS = ['.xlsx', '.xls', '.csv'] as const
const PRIMARY_KEY = 'FolioFiscal'

const app = express()
const upload = multer({ storage: multer.memoryStorage() })
const cache = new CustomerSalesCache()
const competitorDataset = new CompetitorDataset()

function getCurrentYearDateRange() {
  const year = new Date().getFullYear()
  return {
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
  }
}

function isValidDateInput(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function buildPeriodKey(startDate: string, endDate: string) {
  return `${startDate}__${endDate}`
}

function getYearFromDateInput(value: string) {
  return Number(value.slice(0, 4)) || 0
}

function isInvoiceWithinRange(invoice: { issuedAt: string }, startDate: string, endDate: string) {
  const timestamp = getInvoiceTimestamp(invoice.issuedAt)
  if (!timestamp) return false

  const start = new Date(`${startDate}T00:00:00`).getTime()
  const end = new Date(`${endDate}T23:59:59.999`).getTime()
  return timestamp >= start && timestamp <= end
}

function isSupportedDirectoryExtension(extension: string): extension is (typeof SUPPORTED_DIRECTORY_EXTENSIONS)[number] {
  return (SUPPORTED_DIRECTORY_EXTENSIONS as readonly string[]).includes(extension.toLowerCase())
}

function validateDirectoryFile(originalFileName: string) {
  const extension = path.extname(originalFileName).toLowerCase()
  if (!isSupportedDirectoryExtension(extension)) {
    throw new Error('El padrón mis-clientes debe ser .xlsx, .xls o .csv.')
  }
}

function resolveCustomerCrossConfig(body: Record<string, unknown> | undefined) {
  const companyRfc = normalizeRfc(String(body?.companyRfc || ''))
  const fallbackRange = getCurrentYearDateRange()
  const startDate = String(body?.startDate || fallbackRange.startDate)
  const endDate = String(body?.endDate || fallbackRange.endDate)
  const apiBaseUrl = String(body?.apiBaseUrl || process.env.CUSTOMER_API_BASE_URL || DEFAULT_API_BASE_URL)
  const apiPath = String(body?.apiPath || process.env.CUSTOMER_API_PATH || DEFAULT_API_PATH)

  if (!isValidDateInput(startDate) || !isValidDateInput(endDate)) {
    throw new Error('startDate y endDate deben venir en formato YYYY-MM-DD.')
  }

  if (new Date(`${startDate}T00:00:00`).getTime() > new Date(`${endDate}T23:59:59.999`).getTime()) {
    throw new Error('startDate no puede ser mayor que endDate.')
  }

  return { companyRfc, startDate, endDate, apiBaseUrl, apiPath }
}

app.use(cors())
app.use(compression({ threshold: 1_024 }))
app.use(express.json({ limit: '10mb' }))

async function getAnalysisBase(companyRfc?: string, startDate?: string, endDate?: string) {
  const dataset = await competitorDataset.read()
  if (dataset.invoices.length === 0) {
    throw new Error('No hay data de competidores cargada en el backend.')
  }

  const { meta: directoryMeta, rows: directory } = await getCustomerDirectory()
  if (!directoryMeta) {
    throw new Error('No existe todavía un padrón mis-clientes (.xlsx, .xls o .csv) en el backend.')
  }
  const invoices = dataset.invoices
  const dateScopedInvoices = startDate && endDate
    ? invoices.filter((invoice) => isInvoiceWithinRange(invoice, startDate, endDate))
    : invoices
  const normalizedCompanyRfc = normalizeRfc(companyRfc || '')
  const scopedInvoices = normalizedCompanyRfc
    ? dateScopedInvoices.filter((invoice) => invoice.direction === 'emitida' && normalizeRfc(invoice.companyRfc) === normalizedCompanyRfc)
    : dateScopedInvoices
  const directoryMatches = buildCustomerDirectoryMatches({ directory, invoices: scopedInvoices })

  return { dataset, directory, invoices: scopedInvoices, directoryMatches, companyRfc: normalizedCompanyRfc }
}

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ ok: true, service: 'radar-competencia-backend', database: DATABASE_STORAGE })
  } catch {
    res.status(503).json({ ok: false, service: 'radar-competencia-backend', database: 'unavailable' })
  }
})

app.get('/api/cache/status', async (_req, res) => {
  const data = await cache.read()
  res.json({
    ok: true,
    storage: DATABASE_STORAGE,
    entries: Object.keys(data.entries).length,
    updatedAt: data.updatedAt,
  })
})

app.get('/api/competitors/data', async (_req, res) => {
  try {
    const dataset = await competitorDataset.read()
    const invoices = dataset.invoices
    const requestedVersion = String(_req.query.version || '')
    res.setHeader(
      'Cache-Control',
      requestedVersion && requestedVersion === dataset.updatedAt
        ? 'private, max-age=86400, immutable'
        : 'private, no-cache',
    )
    res.setHeader('X-Dataset-Version', dataset.updatedAt)
    res.json({
      ok: true,
      invoices,
      total: invoices.length,
      primaryKey: PRIMARY_KEY,
      updatedAt: dataset.updatedAt,
    })
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo leer el dataset de competidores.',
    })
  }
})

app.get('/api/competitors/status', async (_req, res) => {
  try {
    const status = await competitorDataset.getStatus()
    res.setHeader('Cache-Control', 'private, no-cache')
    res.json({
      ok: true,
      storage: DATABASE_STORAGE,
      ...status,
      primaryKey: PRIMARY_KEY,
    })
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo consultar el estado del dataset.',
    })
  }
})

app.post('/api/competitors/upload', upload.array('files'), async (req, res) => {
  try {
    const files = (req.files as Express.Multer.File[]) || []
    if (files.length === 0) {
      res.status(400).json({ ok: false, error: 'Debes subir al menos un archivo de competencia (.xlsx, .xls o .csv).' })
      return
    }

    const result = await competitorDataset.addFiles(
      files.map((file) => ({ fileName: file.originalname, buffer: file.buffer })),
    )
    const archivedFiles = await archiveUploadedFiles(
      'competitors',
      files.map((file) => ({ fileName: file.originalname, buffer: file.buffer })),
    )

    res.json({
      ok: true,
      storage: DATABASE_STORAGE,
      primaryKey: PRIMARY_KEY,
      totalInvoices: result.totalInvoices,
      inserted: result.inserted,
      duplicatesIgnored: result.duplicatesIgnored,
      uploaded: result.uploaded,
      archivedFiles,
      updatedAt: result.updatedAt,
    })
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudieron subir los archivos de competencia.',
    })
  }
})

app.post('/api/competitors/remove-file', async (req, res) => {
  try {
    const fileName = String(req.body?.fileName || '')
    const result = await competitorDataset.removeFile(fileName)

    res.json({
      ok: true,
      primaryKey: PRIMARY_KEY,
      fileName,
      removedInvoices: result.removedInvoices,
      removedFiles: result.removedFiles,
      impactedCompanyRfcs: result.impactedCompanyRfcs,
      remainingInvoices: result.remainingInvoices,
      updatedAt: result.updatedAt,
    })
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo eliminar la data del competidor seleccionado.',
    })
  }
})

app.post('/api/competitors/clear', async (_req, res) => {
  await competitorDataset.clear()
  res.json({ ok: true, primaryKey: PRIMARY_KEY })
})

app.get('/api/customers/directory/status', async (_req, res) => {
  try {
    const { meta, rows } = await getCustomerDirectory()
    if (!meta) {
      res.status(404).json({
        ok: false,
        error: 'No existe todavía un padrón mis-clientes en PostgreSQL.',
      })
      return
    }
    res.json({
      ok: true,
      storage: DATABASE_STORAGE,
      fileName: meta.fileName,
      customers: rows.length,
      updatedAt: meta.updatedAt.toISOString(),
    })
  } catch {
    res.status(404).json({
      ok: false,
      error: 'No existe todavía un padrón mis-clientes en PostgreSQL.',
    })
  }
})

app.post('/api/customers/directory/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file
    if (!file) {
      res.status(400).json({ ok: false, error: 'Debes subir el archivo de mis clientes.' })
      return
    }

    validateDirectoryFile(file.originalname)
    const rows = await saveCustomerDirectory(file.originalname, file.buffer)
    const [archivedFile] = await archiveUploadedFiles('customer-directory', [{
      fileName: file.originalname,
      buffer: file.buffer,
    }])

    res.json({
      ok: true,
      storage: DATABASE_STORAGE,
      fileName: file.originalname,
      archivedFile,
      customers: rows.length,
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo guardar el padrón de clientes.',
    })
  }
})

app.get('/api/customers/matches', async (req, res) => {
  try {
    const companyRfc = normalizeRfc(String(req.query.companyRfc || ''))
    if (!companyRfc) {
      res.status(400).json({ ok: false, error: 'companyRfc es requerido para calcular coincidencias por empresa.' })
      return
    }

    const fallbackRange = getCurrentYearDateRange()
    const startDate = String(req.query.startDate || fallbackRange.startDate)
    const endDate = String(req.query.endDate || fallbackRange.endDate)
    const { directory, directoryMatches } = await getAnalysisBase(companyRfc, startDate, endDate)
    res.json({
      ok: true,
      directoryCustomers: directory.length,
      matchedDirectoryCustomers: directoryMatches.length,
      companyRfc,
      directoryMatches,
    })
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudieron obtener las coincidencias locales.',
    })
  }
})

app.get('/api/customers/cross/status', async (req, res) => {
  try {
    const companyRfc = normalizeRfc(String(req.query.companyRfc || ''))
    if (!companyRfc) {
      res.status(400).json({ ok: false, error: 'companyRfc es requerido para consultar el cruce guardado.' })
      return
    }

    const fallbackRange = getCurrentYearDateRange()
    const startDate = String(req.query.startDate || fallbackRange.startDate)
    const endDate = String(req.query.endDate || fallbackRange.endDate)
    const apiBaseUrl = String(req.query.apiBaseUrl || process.env.CUSTOMER_API_BASE_URL || DEFAULT_API_BASE_URL)
    const apiPath = String(req.query.apiPath || process.env.CUSTOMER_API_PATH || DEFAULT_API_PATH)
    const snapshot = await competitorDataset.getCustomerCrossSnapshot({
      companyRfc,
      startDate,
      endDate,
      apiBaseUrl,
      apiPath,
    })

    if (!snapshot) {
      res.json({
        ok: true,
        saved: false,
        companyRfc,
        startDate,
        endDate,
        apiBaseUrl,
        apiPath,
        processed: 0,
        withSales: 0,
        entries: [],
      })
      return
    }

    const entries = Object.values(snapshot.entries)
    res.json({
      ok: true,
      saved: true,
      companyRfc: snapshot.companyRfc,
      startDate: snapshot.startDate,
      endDate: snapshot.endDate,
      apiBaseUrl: snapshot.apiBaseUrl,
      apiPath: snapshot.apiPath,
      savedAt: snapshot.savedAt,
      processed: entries.filter((entry) => entry.crossed).length,
      withSales: entries.filter((entry) => entry.hasSales).length,
      entries,
    })
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo consultar el cruce guardado.',
    })
  }
})

app.post('/api/customers/cross/save', async (req, res) => {
  try {
    const { companyRfc, startDate, endDate, apiBaseUrl, apiPath } = resolveCustomerCrossConfig(req.body)
    const entries = (Array.isArray(req.body.entries) ? req.body.entries : []) as Array<Record<string, unknown>>

    if (!companyRfc) {
      res.status(400).json({ ok: false, error: 'companyRfc es requerido para guardar el cruce.' })
      return
    }

    if (entries.length === 0) {
      res.status(400).json({ ok: false, error: 'Debes enviar al menos un resultado de cruce para guardar.' })
      return
    }

    const snapshot = await competitorDataset.saveCustomerCrossSnapshot({
      companyRfc,
      startDate,
      endDate,
      apiBaseUrl,
      apiPath,
      entries: entries.map((entry) => ({
        taxId: normalizeRfc(String(entry?.taxId || '')),
        crossed: true,
        hasSales: Boolean(entry?.hasSales || entry?.ownCustomerSummary),
        savedAt: String(entry?.savedAt || new Date().toISOString()),
        ownCustomerSummary: (entry.ownCustomerSummary as OwnCustomerSalesSummary | null) || null,
      })),
    })

    const savedEntries = Object.values(snapshot.entries)
    res.json({
      ok: true,
      saved: true,
      companyRfc: snapshot.companyRfc,
      savedAt: snapshot.savedAt,
      processed: savedEntries.filter((entry) => entry.crossed).length,
      withSales: savedEntries.filter((entry) => entry.hasSales).length,
      entries: savedEntries,
    })
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo guardar el cruce en backend.',
    })
  }
})

app.post('/api/customers/fetch-by-rfc', async (req, res) => {
  try {
    const taxId = normalizeRfc(String(req.body.taxId || ''))
    if (!taxId) {
      res.status(400).json({ ok: false, error: 'taxId es requerido.' })
      return
    }

    const { startDate, endDate, apiBaseUrl, apiPath } = resolveCustomerCrossConfig(req.body)
    const apiTimeoutMs = Number(req.body.apiTimeoutMs || 20000)
    const periodKey = buildPeriodKey(startDate, endDate)
    const reportYear = Number(req.body.year || getYearFromDateInput(endDate) || getYearFromDateInput(startDate))

    const { found } = await cache.getMany([taxId], periodKey)
    let summary: OwnCustomerSalesSummary | null = found[0] || null
    let apiRows = summary?.monthly || []
    let cacheHit = false
    let apiFetched = false

    if (summary) {
      cacheHit = true
    } else {
      const rows = await fetchCustomerMonthlySalesSummary({
        baseUrl: apiBaseUrl,
        apiPath,
        taxId,
        startDate,
        endDate,
        timeoutMs: apiTimeoutMs,
      })

      apiRows = rows
      summary = summarizeOwnCustomerSales(rows)

      if (summary) {
        await cache.saveMany([summary], periodKey)
        apiFetched = true
      }
    }

    res.json({
      ok: true,
      taxId,
      apiRows,
      ownCustomerSummary: summary,
      totals: summary
        ? {
            subtotalAmount: summary.subtotalAmount,
            totalAmount: summary.totalAmount,
            monthlyCount: summary.monthly.length,
          }
        : {
            subtotalAmount: 0,
            totalAmount: 0,
            monthlyCount: 0,
          },
      cacheHit,
      apiFetched,
      year: reportYear,
      apiBaseUrl,
      apiPath,
    })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo consultar la API por RFC.',
    })
  }
})

app.post('/api/customers/analyze-one', async (req, res) => {
  try {
    const companyRfc = normalizeRfc(String(req.body.companyRfc || ''))
    if (!companyRfc) {
      res.status(400).json({ ok: false, error: 'companyRfc es requerido para analizar un cliente por empresa.' })
      return
    }

    const { startDate, endDate, apiBaseUrl, apiPath } = resolveCustomerCrossConfig(req.body)
    const { invoices, directoryMatches } = await getAnalysisBase(companyRfc, startDate, endDate)
    const taxId = normalizeRfc(String(req.body.taxId || ''))
    if (!taxId) {
      res.status(400).json({ ok: false, error: 'taxId es requerido.' })
      return
    }

    const directoryMatch = directoryMatches.find((row) => normalizeRfc(row.customerTaxId) === taxId)
    if (!directoryMatch) {
      res.status(404).json({ ok: false, error: 'Ese cliente no existe en las coincidencias locales actuales.' })
      return
    }

    const apiTimeoutMs = Number(req.body.apiTimeoutMs || 20000)
    const periodKey = buildPeriodKey(startDate, endDate)
    const reportYear = Number(req.body.year || getYearFromDateInput(endDate) || getYearFromDateInput(startDate))

    const { found } = await cache.getMany([taxId], periodKey)
    let summary: OwnCustomerSalesSummary | null = found[0] || null
    let cacheHit = false
    let apiFetched = false

    if (summary) {
      cacheHit = true
    } else {
      const rows = await fetchCustomerMonthlySalesSummary({
        baseUrl: apiBaseUrl,
        apiPath,
        taxId,
        startDate,
        endDate,
        timeoutMs: apiTimeoutMs,
      })

      summary = summarizeOwnCustomerSales(rows)
      if (summary) {
        await cache.saveMany([summary], periodKey)
        apiFetched = true
      }
    }

    const competitorInvoices = invoices
      .filter(
        (invoice) =>
          invoice.direction === 'emitida' &&
          invoice.status === 'Vigente' &&
          normalizeRfc(invoice.counterpartyRfc) === taxId,
      )
      .sort((a, b) => getInvoiceTimestamp(b.issuedAt) - getInvoiceTimestamp(a.issuedAt))

    const customerSummaries = summary ? [summary] : []
    const customerCompetition = buildCustomerCompetitionRows({ customerSummaries, invoices })
    const competitorOverlap = buildCompetitorOverlap({ customerSummaries, invoices })

    res.json({
      ok: true,
      taxId,
      matchedDirectoryCustomers: directoryMatches.length,
      companyRfc,
      directoryMatch,
      ownCustomerSummary: summary,
      competitorInvoices,
      customerCompetition: customerCompetition[0] || null,
      competitorOverlap,
      cacheHit,
      apiFetched,
      year: reportYear,
    })
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo analizar el cliente.',
    })
  }
})

app.post('/api/customers/analyze', async (req, res) => {
  try {
    const { startDate, endDate, apiBaseUrl, apiPath } = resolveCustomerCrossConfig(req.body)
    const { directory, invoices, directoryMatches } = await getAnalysisBase(undefined, startDate, endDate)
    const apiConcurrency = Number(req.body.apiConcurrency || 4)
    const apiTimeoutMs = Number(req.body.apiTimeoutMs || 20000)

    const periodKey = buildPeriodKey(startDate, endDate)
    const reportYear = getYearFromDateInput(startDate) === getYearFromDateInput(endDate)
      ? getYearFromDateInput(startDate)
      : 0

    const detectedExcelCustomers = getExcelCustomerTaxIds(invoices)
    const matchedDirectoryTaxIds = getDirectoryMatchedTaxIds(directoryMatches)
    const { summaries, cacheHits, apiFetches, missingCount } = await fetchCustomerSalesByTaxIdsWithCache({
      cache,
      baseUrl: apiBaseUrl,
      apiPath,
      taxIds: matchedDirectoryTaxIds,
      startDate,
      endDate,
      concurrency: apiConcurrency,
      timeoutMs: apiTimeoutMs,
      periodKey,
    })

    const customerCompetition = buildCustomerCompetitionRows({ customerSummaries: summaries, invoices })
    const competitorOverlap = buildCompetitorOverlap({ customerSummaries: summaries, invoices })

    res.json({
      ok: true,
      competitorDatasetStorage: DATABASE_STORAGE,
      detectedExcelCustomers,
      directoryCustomers: directory.length,
      matchedDirectoryCustomers: directoryMatches.length,
      ownCustomerSummaries: summaries,
      directoryMatches,
      customerCompetition,
      competitorOverlap,
      invoices,
      cacheHits,
      apiFetches,
      missingCount,
      year: reportYear,
      primaryKey: PRIMARY_KEY,
    })
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo analizar clientes.',
    })
  }
})

app.post('/api/report/generate', async (req, res) => {
  try {
    const dataset = await competitorDataset.read()
    if (dataset.invoices.length === 0) {
      res.status(400).json({ ok: false, error: 'No hay data de competidores cargada en el backend.' })
      return
    }

    const { startDate, endDate, apiBaseUrl, apiPath } = resolveCustomerCrossConfig(req.body)
    const apiConcurrency = Number(req.body.apiConcurrency || 4)
    const apiTimeoutMs = Number(req.body.apiTimeoutMs || 20000)

    const invoices = dataset.invoices.filter((invoice) => isInvoiceWithinRange(invoice, startDate, endDate))
    const periodKey = buildPeriodKey(startDate, endDate)
    const reportYear = getYearFromDateInput(startDate) === getYearFromDateInput(endDate)
      ? getYearFromDateInput(startDate)
      : 0

    const customerTaxIds = getExcelCustomerTaxIds(invoices)
    const { summaries, cacheHits, apiFetches, missingCount } = await fetchCustomerSalesByTaxIdsWithCache({
      cache,
      baseUrl: apiBaseUrl,
      apiPath,
      taxIds: customerTaxIds,
      startDate,
      endDate,
      concurrency: apiConcurrency,
      timeoutMs: apiTimeoutMs,
      periodKey,
    })

    const companyName = invoices[0]?.companyName || 'TUVANSA'
    const workbook = await generateSimpleWorkbook({
      invoices,
      ownCustomerSummaries: summaries,
      companyName,
      year: reportYear,
      cacheHits,
      apiFetches,
    })

    const buffer = await workbook.xlsx.writeBuffer()
    const safeName = companyName.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'radar_competencia'

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_dashboard.xlsx"`)
    res.setHeader('X-Cache-Hits', String(cacheHits))
    res.setHeader('X-API-Fetches', String(apiFetches))
    res.setHeader('X-Missing-Results', String(missingCount))
    res.setHeader('X-Primary-Key', PRIMARY_KEY)
    res.send(Buffer.from(buffer))
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo generar el reporte.',
    })
  }
})

app.post('/api/cache/clear', async (_req, res) => {
  await cache.clear()
  res.json({ ok: true })
})

const port = Number(process.env.PORT || 3010)
const server = app.listen(port, () => {
  console.log(`radar-competencia-backend listo en http://localhost:${port}`)
})

async function shutdown() {
  server.close(async () => {
    await prisma.$disconnect()
    process.exit(0)
  })
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
