# radar-competencia-backend

Backend de `radar-competencia`, con persistencia en Neon PostgreSQL mediante Prisma ORM.

## Persistencia

Se guardan en PostgreSQL:

- facturas de competidores, deduplicadas por `FolioFiscal`
- metadatos de archivos importados
- padrón de clientes (el Excel se transforma a filas; el archivo no queda en disco)
- caché de ventas por `RFC + período`
- resultados guardados de los cruces por empresa y período

El backend ya no depende del directorio local `data/` durante su operación. Ese directorio solamente se usa como origen opcional del importador de datos históricos.

## Configuración con Neon

1. Copia `.env.example` a `.env`.
2. En Neon, copia la URL con pooling en `DATABASE_URL` (su hostname contiene `-pooler`).
3. Copia la URL directa, sin `-pooler`, en `DIRECT_URL`.
4. Aplica las migraciones y arranca el backend:

```bash
npm install
npm run db:deploy
npm run dev
```

Variables requeridas:

```dotenv
DATABASE_URL="postgresql://USUARIO:CONTRASENA@HOST-POOLER/neondb?sslmode=require"
DIRECT_URL="postgresql://USUARIO:CONTRASENA@HOST/neondb?sslmode=require"
```

`DATABASE_URL` es la conexión usada por la aplicación con el adaptador oficial de Neon. `DIRECT_URL` se usa únicamente por Prisma CLI para migraciones.

## Importar los datos locales actuales

Después de aplicar la migración:

```bash
npm run db:import-local
```

El comando importa, cuando existen:

- `data/competitor-invoices.json`
- `data/customer-sales-cache.json`
- `data/mis-clientes.xlsx` (también admite `.xls` o `.csv`)

Por seguridad, el importador se detiene si Neon ya contiene facturas. Para reemplazar intencionalmente los datos existentes:

```bash
npm run db:import-local -- --replace
```

Si una importación se interrumpe, puede continuarse sin limpiar los registros ya copiados:

```bash
npm run db:import-local -- --resume
```

## Scripts

```bash
npm run dev              # desarrollo
npm run build            # genera Prisma Client y compila TypeScript
npm start                # ejecuta dist/index.js
npm run db:generate      # regenera Prisma Client
npm run db:migrate       # crea/aplica migraciones en desarrollo
npm run db:deploy        # aplica migraciones existentes
npm run db:studio        # abre Prisma Studio
npm run db:import-local  # importa la persistencia local histórica
npm run storage:migrate-local # copia data/ hacia storage/legacy sin borrar originales
```

## Docker y despliegue en servidor

El archivo `compose.yml` levanta únicamente el backend; PostgreSQL continúa alojado en Neon. Antes de iniciar, coloca en `.env` las variables `DATABASE_URL` y `DIRECT_URL` de Neon.

```bash
docker compose build
docker compose --profile migrate run --rm migrate
docker compose up -d radar-competencia-api
docker compose ps
docker compose logs -f radar-competencia-api
```

El servicio queda enlazado únicamente a `127.0.0.1:3010`, listo para publicarse mediante Nginx, Caddy u otro reverse proxy. Puedes cambiar el puerto del host con `HOST_PORT` sin modificar el puerto interno del contenedor.

Docker crea el volumen persistente `radar_competencia_files`, montado en `/app/storage`:

- `/app/storage/uploads/competitors`: archivos de competencia nuevos
- `/app/storage/uploads/customer-directory`: padrones nuevos
- `/app/storage/legacy`: copia inicial de los archivos anteriores

El despliegue separa responsabilidades:

1. `migrate` aplica las migraciones pendientes de Prisma en Neon y termina;
2. `volume-init` crea las carpetas persistentes y les asigna permisos al usuario `node`;
3. `radar-competencia-api` copia desde `./data` solamente los archivos faltantes y levanta el API.

El API usa filesystem de sólo lectura, `/tmp` temporal, `no-new-privileges`, proceso init y rotación local de logs.

`./data` se monta como sólo lectura. La migración no elimina ni modifica sus archivos. Para comprobar el contenido persistente:

```bash
docker compose exec radar-competencia-api find /app/storage -maxdepth 3 -type f
```

Al copiar el proyecto al servidor, incluye el directorio `data/` si deseas migrar esos archivos históricos al volumen en el primer arranque. No copies el archivo `.env` mediante Git; créalo directamente en el servidor.

## Endpoints principales

- `GET /health`
- `GET /api/cache/status`
- `POST /api/cache/clear`
- `GET /api/competitors/status`
- `POST /api/competitors/upload`
- `POST /api/competitors/remove-file`
- `POST /api/competitors/clear`
- `GET /api/customers/directory/status`
- `POST /api/customers/directory/upload`
- `GET /api/customers/matches`
- `GET /api/customers/cross/status`
- `POST /api/customers/cross/save`
- `POST /api/report/generate`
