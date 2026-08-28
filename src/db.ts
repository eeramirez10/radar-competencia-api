import 'dotenv/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client.js'

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error('DATABASE_URL es requerida para conectar radar-competencia-backend con PostgreSQL.')
}

const adapter = new PrismaPg({ connectionString })

export const prisma = new PrismaClient({ adapter })
