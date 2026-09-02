import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Express, RequestHandler } from 'express'
import { rateLimit } from 'express-rate-limit'
import { prisma } from './db.js'

const scryptAsync = promisify(scrypt)
const PASSWORD_KEY_LENGTH = 64
const PASSWORD_FORMAT = 'scrypt-v1'
const DEFAULT_SESSION_TTL_HOURS = 12

function normalizeUsername(value: unknown) {
  return String(value || '').trim().toLowerCase()
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex')
  const derivedKey = await scryptAsync(password, salt, PASSWORD_KEY_LENGTH) as Buffer
  return `${PASSWORD_FORMAT}$${salt}$${derivedKey.toString('hex')}`
}

async function verifyPassword(password: string, storedHash: string) {
  const [format, salt, expectedHex] = storedHash.split('$')
  if (format !== PASSWORD_FORMAT || !salt || !expectedHex) return false

  try {
    const expected = Buffer.from(expectedHex, 'hex')
    const actual = await scryptAsync(password, salt, expected.length) as Buffer
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

function getSessionTtlHours() {
  const configured = Number(process.env.AUTH_SESSION_TTL_HOURS || DEFAULT_SESSION_TTL_HOURS)
  if (!Number.isFinite(configured)) return DEFAULT_SESSION_TTL_HOURS
  return Math.min(Math.max(Math.trunc(configured), 1), 168)
}

function getBearerToken(authorization: string | undefined) {
  const match = authorization?.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

export async function ensureAdminUser() {
  const username = normalizeUsername(process.env.ADMIN_USERNAME || 'admin')
  const password = String(process.env.ADMIN_PASSWORD || '')

  if (!username) throw new Error('ADMIN_USERNAME no puede estar vacío.')
  if (password.length < 12) {
    throw new Error('ADMIN_PASSWORD es requerida y debe tener al menos 12 caracteres.')
  }

  const existing = await prisma.user.findUnique({ where: { username } })
  if (!existing) {
    await prisma.user.create({
      data: { username, passwordHash: await hashPassword(password), role: 'admin' },
    })
    console.log(`Usuario administrador creado: ${username}`)
    return
  }

  if (!await verifyPassword(password, existing.passwordHash)) {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash: await hashPassword(password), active: true, role: 'admin' },
      }),
      prisma.authSession.deleteMany({ where: { userId: existing.id } }),
    ])
    console.log(`Contraseña del administrador actualizada: ${username}`)
  }
}

const requireAuth: RequestHandler = async (req, res, next) => {
  const token = getBearerToken(req.header('authorization'))
  if (!token) {
    res.status(401).json({ ok: false, error: 'Autenticación requerida.' })
    return
  }

  const hashedToken = tokenHash(token)
  const session = await prisma.authSession.findUnique({
    where: { tokenHash: hashedToken },
    include: { user: true },
  })
  if (!session || !session.user.active || session.expiresAt.getTime() <= Date.now()) {
    if (session) await prisma.authSession.delete({ where: { id: session.id } }).catch(() => undefined)
    res.status(401).json({ ok: false, error: 'La sesión no es válida o expiró.' })
    return
  }

  res.locals.authUser = {
    id: session.user.id,
    username: session.user.username,
    role: session.user.role,
  }
  res.locals.authTokenHash = hashedToken
  next()
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'Demasiados intentos de acceso. Intenta nuevamente en 15 minutos.' },
})

export function registerAuth(app: Express) {
  app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const username = normalizeUsername(req.body?.username)
    const password = String(req.body?.password || '')
    if (!username || !password || password.length > 1_024) {
      res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos.' })
      return
    }

    const user = await prisma.user.findUnique({ where: { username } })
    if (!user || !user.active || !await verifyPassword(password, user.passwordHash)) {
      res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos.' })
      return
    }

    await prisma.authSession.deleteMany({ where: { expiresAt: { lte: new Date() } } })
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + getSessionTtlHours() * 60 * 60 * 1_000)
    await prisma.authSession.create({
      data: { tokenHash: tokenHash(token), userId: user.id, expiresAt },
    })

    res.json({
      ok: true,
      token,
      expiresAt: expiresAt.toISOString(),
      user: { username: user.username, role: user.role },
    })
  })

  app.use('/api', requireAuth)

  app.get('/api/auth/me', (_req, res) => {
    res.json({ ok: true, user: res.locals.authUser })
  })

  app.post('/api/auth/logout', async (_req, res) => {
    await prisma.authSession.deleteMany({ where: { tokenHash: res.locals.authTokenHash } })
    res.json({ ok: true })
  })
}
