import path from 'node:path'
import { migrateLegacyFiles } from './file-storage.js'

const sourceDirectory = process.argv[2] || path.resolve('data')

try {
  const result = await migrateLegacyFiles(sourceDirectory)
  if (!result.sourceFound) {
    console.log(`Migración de archivos omitida: no existe ${sourceDirectory}`)
  } else {
    console.log(`Migración de archivos lista: ${result.copied} copiados, ${result.skipped} existentes, destino ${result.target}`)
  }
} catch (error) {
  console.error('No se pudieron migrar los archivos al volumen.', error)
  process.exitCode = 1
}
