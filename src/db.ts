import 'dotenv/config'
import { PrismaNeon } from '@prisma/adapter-neon'
import { PrismaClient } from './generated/prisma/client.js'

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error('DATABASE_URL es requerida para conectar radar-competencia-backend con Neon.')
}

const adapter = new PrismaNeon({ connectionString })

export const prisma = new PrismaClient({ adapter })
