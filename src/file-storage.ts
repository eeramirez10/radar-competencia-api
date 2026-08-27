import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const STORAGE_ROOT = path.resolve(process.env.STORAGE_DIR || 'storage')

function safeFileName(fileName: string) {
  const extension = path.extname(fileName).toLowerCase()
  const stem = path.basename(fileName, extension)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${stem || 'archivo'}${extension}`
}

export async function archiveUploadedFiles(
  category: 'competitors' | 'customer-directory',
  files: Array<{ fileName: string; buffer: Buffer }>,
) {
  const directory = path.join(STORAGE_ROOT, 'uploads', category)
  await fs.mkdir(directory, { recursive: true })

  return Promise.all(files.map(async (file) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const storedName = `${timestamp}_${randomUUID()}_${safeFileName(file.fileName)}`
    const target = path.join(directory, storedName)
    await fs.writeFile(target, file.buffer, { flag: 'wx' })
    return path.relative(STORAGE_ROOT, target)
  }))
}

async function copyDirectoryWithoutOverwrite(source: string, target: string): Promise<{ copied: number; skipped: number }> {
  await fs.mkdir(target, { recursive: true })
  const entries = await fs.readdir(source, { withFileTypes: true })
  let copied = 0
  let skipped = 0

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name)
    const targetPath = path.join(target, entry.name)

    if (entry.isDirectory()) {
      const nested = await copyDirectoryWithoutOverwrite(sourcePath, targetPath)
      copied += nested.copied
      skipped += nested.skipped
      continue
    }

    if (!entry.isFile()) continue

    try {
      await fs.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL)
      copied += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      skipped += 1
    }
  }

  return { copied, skipped }
}

export async function migrateLegacyFiles(sourceDirectory: string) {
  const source = path.resolve(sourceDirectory)
  const target = path.join(STORAGE_ROOT, 'legacy')

  try {
    await fs.access(source)
  } catch {
    return { copied: 0, skipped: 0, sourceFound: false, target }
  }

  const result = await copyDirectoryWithoutOverwrite(source, target)
  return { ...result, sourceFound: true, target }
}
