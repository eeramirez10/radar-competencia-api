import type { LocalCustomerDirectoryRow } from './types.js'
import { parseCustomerDirectoryFromBuffer } from './excel.js'
import { prisma } from './db.js'

const DIRECTORY_ID = 'current'

export async function getCustomerDirectory() {
  const [meta, rows] = await Promise.all([
    prisma.customerDirectoryMeta.findUnique({ where: { id: DIRECTORY_ID } }),
    prisma.customerDirectoryEntry.findMany(),
  ])
  return { meta, rows: rows satisfies LocalCustomerDirectoryRow[] }
}

export async function saveCustomerDirectory(fileName: string, buffer: Buffer) {
  const rows = parseCustomerDirectoryFromBuffer(fileName, buffer)
  await prisma.$transaction(async (tx) => {
    await tx.customerDirectoryEntry.deleteMany()
    if (rows.length > 0) await tx.customerDirectoryEntry.createMany({ data: rows })
    await tx.customerDirectoryMeta.upsert({
      where: { id: DIRECTORY_ID }, create: { id: DIRECTORY_ID, fileName }, update: { fileName },
    })
  })
  return rows
}

export async function clearCustomerDirectory() {
  await prisma.$transaction([
    prisma.customerDirectoryEntry.deleteMany(),
    prisma.customerDirectoryMeta.deleteMany({ where: { id: DIRECTORY_ID } }),
  ])
}
