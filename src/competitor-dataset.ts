import type { NormalizedInvoice, OwnCustomerSalesSummary } from './types.js'
import { dedupeInvoices, normalizeRfc, workbookRowsFromBuffer } from './excel.js'
import { prisma } from './db.js'
import { Prisma } from './generated/prisma/client.js'

export interface CompetitorUploadFileMeta {
  fileName: string
  storedAt: string
  recordsRead: number
  inserted: number
  duplicatesIgnored: number
  directionsDetected: Array<'emitida' | 'recibida'>
  companiesDetected?: Array<{ companyRfc: string; companyName: string }>
}

export interface SavedCustomerCrossEntry {
  taxId: string
  crossed: boolean
  hasSales: boolean
  savedAt: string
  ownCustomerSummary: OwnCustomerSalesSummary | null
}

export interface CustomerCrossSnapshot {
  key: string
  companyRfc: string
  startDate: string
  endDate: string
  apiBaseUrl: string
  apiPath: string
  savedAt: string
  entries: Record<string, SavedCustomerCrossEntry>
}

export type CustomerCrossSnapshotsByCompany = Record<string, Record<string, CustomerCrossSnapshot>>

export interface CompetitorDatasetStore {
  version: 1
  updatedAt: string
  invoices: NormalizedInvoice[]
  files: CompetitorUploadFileMeta[]
  customerCrossByCompany: CustomerCrossSnapshotsByCompany
}

const DATASET_STATE_ID = 'competitor-dataset'
const BATCH_SIZE = 2_000
const invoiceSelect = {
  id: true,
  sourceFileName: true,
  direction: true,
  companyRfc: true,
  companyName: true,
  counterpartyRfc: true,
  counterpartyName: true,
  issuedAt: true,
  certifiedAt: true,
  subtotal: true,
  total: true,
  status: true,
  effect: true,
  year: true,
  month: true,
  monthKey: true,
} satisfies Prisma.InvoiceSelect

function invoiceFromDb(row: {
  id: string; sourceFileName: string; direction: string; companyRfc: string; companyName: string
  counterpartyRfc: string; counterpartyName: string; issuedAt: string; certifiedAt: string
  subtotal: unknown; total: unknown; status: string; effect: string; year: number; month: number; monthKey: string
}): NormalizedInvoice {
  return {
    ...row,
    direction: row.direction as NormalizedInvoice['direction'],
    subtotal: Number(row.subtotal),
    total: Number(row.total),
    status: row.status as NormalizedInvoice['status'],
    effect: row.effect as NormalizedInvoice['effect'],
  }
}

function snapshotEntryFromDb(entry: {
  taxId: string; crossed: boolean; hasSales: boolean; savedAt: Date; ownCustomerSummary: unknown
}): SavedCustomerCrossEntry {
  return {
    taxId: entry.taxId,
    crossed: entry.crossed,
    hasSales: entry.hasSales,
    savedAt: entry.savedAt.toISOString(),
    ownCustomerSummary: entry.ownCustomerSummary as OwnCustomerSalesSummary | null,
  }
}

function fileFromDb(file: {
  fileName: string; storedAt: Date; recordsRead: number; inserted: number; duplicatesIgnored: number
  directions: unknown; companies: unknown
}): CompetitorUploadFileMeta {
  return {
    fileName: file.fileName,
    storedAt: file.storedAt.toISOString(),
    recordsRead: file.recordsRead,
    inserted: file.inserted,
    duplicatesIgnored: file.duplicatesIgnored,
    directionsDetected: file.directions as CompetitorUploadFileMeta['directionsDetected'],
    companiesDetected: (file.companies || undefined) as CompetitorUploadFileMeta['companiesDetected'],
  }
}

export function buildCustomerCrossSnapshotKey(input: {
  companyRfc: string; startDate: string; endDate: string; apiBaseUrl: string; apiPath: string
}) {
  return JSON.stringify({
    companyRfc: normalizeRfc(input.companyRfc), startDate: input.startDate, endDate: input.endDate,
    apiBaseUrl: input.apiBaseUrl, apiPath: input.apiPath,
  })
}

async function touchDataset() {
  await prisma.radarState.upsert({
    where: { id: DATASET_STATE_ID }, create: { id: DATASET_STATE_ID }, update: { updatedAt: new Date() },
  })
}

async function insertInvoices(invoices: NormalizedInvoice[]) {
  let inserted = 0
  for (let index = 0; index < invoices.length; index += BATCH_SIZE) {
    const result = await prisma.invoice.createMany({
      data: invoices.slice(index, index + BATCH_SIZE),
      skipDuplicates: true,
    })
    inserted += result.count
  }
  return inserted
}

export class CompetitorDataset {
  private cachedDataset: CompetitorDatasetStore | null = null
  private pendingRead: Promise<CompetitorDatasetStore> | null = null

  private invalidateCache() {
    this.cachedDataset = null
    this.pendingRead = null
  }

  async read(): Promise<CompetitorDatasetStore> {
    if (this.cachedDataset) return this.cachedDataset
    if (this.pendingRead) return this.pendingRead

    this.pendingRead = (async () => {
      const [invoiceRows, fileRows, state] = await Promise.all([
        prisma.invoice.findMany({ select: invoiceSelect }),
        prisma.competitorFile.findMany({ orderBy: { storedAt: 'asc' } }),
        prisma.radarState.findUnique({ where: { id: DATASET_STATE_ID } }),
      ])
      const dataset: CompetitorDatasetStore = {
        version: 1,
        updatedAt: state?.updatedAt.toISOString() || new Date(0).toISOString(),
        invoices: invoiceRows.map(invoiceFromDb),
        files: fileRows.map(fileFromDb),
        customerCrossByCompany: {},
      }
      this.cachedDataset = dataset
      return dataset
    })()

    try {
      return await this.pendingRead
    } finally {
      this.pendingRead = null
    }
  }

  async getStatus() {
    const [invoices, emitidas, recibidas, fileRows, state] = await Promise.all([
      prisma.invoice.count(),
      prisma.invoice.count({ where: { direction: 'emitida' } }),
      prisma.invoice.count({ where: { direction: 'recibida' } }),
      prisma.competitorFile.findMany({ orderBy: { storedAt: 'asc' } }),
      prisma.radarState.findUnique({ where: { id: DATASET_STATE_ID } }),
    ])

    return {
      invoices,
      emitidas,
      recibidas,
      files: fileRows.map(fileFromDb),
      updatedAt: state?.updatedAt.toISOString() || new Date(0).toISOString(),
    }
  }

  async clear() {
    await prisma.$transaction([
      prisma.invoice.deleteMany(), prisma.competitorFile.deleteMany(), prisma.customerCrossSnapshot.deleteMany(),
    ])
    await touchDataset()
    this.invalidateCache()
  }

  async addFiles(files: Array<{ fileName: string; buffer: Buffer }>) {
    const metas: CompetitorUploadFileMeta[] = []
    let totalInserted = 0

    for (const file of files) {
      const rows = dedupeInvoices(workbookRowsFromBuffer(file.fileName, file.buffer))
      const inserted = await insertInvoices(rows)
      totalInserted += inserted
      const meta: CompetitorUploadFileMeta = {
        fileName: file.fileName, storedAt: new Date().toISOString(), recordsRead: rows.length,
        inserted, duplicatesIgnored: rows.length - inserted,
        directionsDetected: Array.from(new Set(rows.map((row) => row.direction))),
        companiesDetected: Array.from(new Map(rows.map((row) => [row.companyRfc, {
          companyRfc: row.companyRfc, companyName: row.companyName,
        }])).values()),
      }
      await prisma.competitorFile.create({ data: {
        fileName: meta.fileName, storedAt: new Date(meta.storedAt), recordsRead: meta.recordsRead,
        inserted: meta.inserted, duplicatesIgnored: meta.duplicatesIgnored,
        directions: meta.directionsDetected, companies: meta.companiesDetected,
      } })
      metas.push(meta)
    }

    await touchDataset()
    this.invalidateCache()
    const status = await this.getStatus()
    return {
      uploaded: metas,
      totalInvoices: status.invoices,
      updatedAt: status.updatedAt,
      inserted: totalInserted,
      duplicatesIgnored: metas.reduce((sum, item) => sum + item.duplicatesIgnored, 0),
    }
  }

  async removeFile(fileName: string) {
    const normalizedFileName = String(fileName || '').trim()
    if (!normalizedFileName) throw new Error('fileName es requerido para eliminar la data de un competidor.')

    const impactedRows = await prisma.invoice.findMany({
      where: { sourceFileName: normalizedFileName }, select: { companyRfc: true }, distinct: ['companyRfc'],
    })
    if (impactedRows.length === 0) throw new Error(`No se encontró data cargada para ${normalizedFileName}.`)
    const impactedCompanyRfcs = impactedRows.map((row) => normalizeRfc(row.companyRfc)).filter(Boolean)

    const [removedInvoices, removedFiles] = await prisma.$transaction([
      prisma.invoice.deleteMany({ where: { sourceFileName: normalizedFileName } }),
      prisma.competitorFile.deleteMany({ where: { fileName: normalizedFileName } }),
      prisma.customerCrossSnapshot.deleteMany({ where: { companyRfc: { in: impactedCompanyRfcs } } }),
    ])
    await touchDataset()
    this.invalidateCache()
    const status = await this.getStatus()
    return {
      removedInvoices: removedInvoices.count,
      removedFiles: removedFiles.count,
      impactedCompanyRfcs,
      remainingInvoices: status.invoices,
      updatedAt: status.updatedAt,
    }
  }

  async getCustomerCrossSnapshot(input: {
    companyRfc: string; startDate: string; endDate: string; apiBaseUrl: string; apiPath: string
  }) {
    const key = buildCustomerCrossSnapshotKey(input)
    const snapshot = await prisma.customerCrossSnapshot.findUnique({ where: { key }, include: { entries: true } })
    if (!snapshot) return null
    return {
      key: snapshot.key, companyRfc: snapshot.companyRfc, startDate: snapshot.startDate,
      endDate: snapshot.endDate, apiBaseUrl: snapshot.apiBaseUrl, apiPath: snapshot.apiPath,
      savedAt: snapshot.savedAt.toISOString(),
      entries: Object.fromEntries(snapshot.entries.map((entry) => [entry.taxId, snapshotEntryFromDb(entry)])),
    } satisfies CustomerCrossSnapshot
  }

  async saveCustomerCrossSnapshot(input: {
    companyRfc: string; startDate: string; endDate: string; apiBaseUrl: string; apiPath: string
    entries: SavedCustomerCrossEntry[]
  }) {
    const companyRfc = normalizeRfc(input.companyRfc)
    const key = buildCustomerCrossSnapshotKey({ ...input, companyRfc })
    const savedAt = new Date()
    const snapshot = await prisma.customerCrossSnapshot.upsert({
      where: { key },
      create: { key, companyRfc, startDate: input.startDate, endDate: input.endDate,
        apiBaseUrl: input.apiBaseUrl, apiPath: input.apiPath, savedAt },
      update: { savedAt },
    })
    for (let index = 0; index < input.entries.length; index += 20) {
      const batch = input.entries.slice(index, index + 20)
      await prisma.$transaction(batch.map((entry) => {
        const taxId = normalizeRfc(entry.taxId)
        const data = {
          crossed: true, hasSales: Boolean(entry.hasSales || entry.ownCustomerSummary),
          savedAt: new Date(entry.savedAt || savedAt),
          ownCustomerSummary: entry.ownCustomerSummary
            ? entry.ownCustomerSummary as unknown as Prisma.InputJsonValue
            : Prisma.JsonNull,
        }
        return prisma.customerCrossEntry.upsert({
          where: { snapshotId_taxId: { snapshotId: snapshot.id, taxId } },
          create: { snapshotId: snapshot.id, taxId, ...data }, update: data,
        })
      }))
    }
    return (await this.getCustomerCrossSnapshot(input))!
  }

  async importLegacy(data: CompetitorDatasetStore, options: { replace?: boolean } = {}) {
    this.invalidateCache()
    if (options.replace) await this.clear()
    await insertInvoices(dedupeInvoices(data.invoices || []))
    for (const file of data.files || []) {
      const exists = await prisma.competitorFile.findFirst({
        where: { fileName: file.fileName, storedAt: new Date(file.storedAt) }, select: { id: true },
      })
      if (exists) continue
      await prisma.competitorFile.create({ data: {
        fileName: file.fileName, storedAt: new Date(file.storedAt), recordsRead: file.recordsRead,
        inserted: file.inserted, duplicatesIgnored: file.duplicatesIgnored,
        directions: file.directionsDetected, companies: file.companiesDetected,
      } })
    }
    for (const snapshots of Object.values(data.customerCrossByCompany || {})) {
      for (const snapshot of Object.values(snapshots)) {
        await this.saveCustomerCrossSnapshot({ ...snapshot, entries: Object.values(snapshot.entries) })
      }
    }
    await touchDataset()
    this.invalidateCache()
  }
}
