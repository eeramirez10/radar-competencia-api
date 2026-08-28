# radar-competencia-backend

Backend de `radar-competencia`, con PostgreSQL 17 en Docker y Prisma ORM.

## Persistencia

Se guardan en PostgreSQL:

- facturas de competidores, deduplicadas por `FolioFiscal`
- metadatos de archivos importados
- padrón de clientes (el Excel se transforma a filas; el archivo no queda en disco)
- caché de ventas por `RFC + período`
- resultados guardados de los cruces por empresa y período

El backend ya no depende del directorio local `data/` durante su operación. Ese directorio solamente se usa como origen opcional del importador de datos históricos.

## Configuración

1. Copia `.env.example` a `.env`.
2. Cambia `POSTGRES_PASSWORD` por una contraseña larga que sólo use caracteres URL-safe.
3. Conserva las antiguas URLs de Neon fuera del despliegue únicamente como respaldo.

Para desarrollo con PostgreSQL Docker:

```bash
npm install
docker compose up -d postgres
npm run db:deploy
npm run dev
```

Variables requeridas:

```dotenv
POSTGRES_DB=radar_competencia
POSTGRES_USER=radar_app
POSTGRES_PASSWORD=CAMBIA_ESTA_CONTRASENA
DATABASE_URL="postgresql://radar_app:CAMBIA_ESTA_CONTRASENA@localhost:5432/radar_competencia"
DIRECT_URL="postgresql://radar_app:CAMBIA_ESTA_CONTRASENA@localhost:5432/radar_competencia"
```

Dentro de Compose, `DATABASE_URL` y `DIRECT_URL` se sustituyen automáticamente para utilizar el hostname interno `postgres`.

## Importar los datos locales actuales

Después de aplicar la migración:

```bash
npm run db:import-local
```

El comando importa, cuando existen:

- `data/competitor-invoices.json`
- `data/customer-sales-cache.json`
- `data/mis-clientes.xlsx` (también admite `.xls` o `.csv`)

Por seguridad, el importador se detiene si PostgreSQL ya contiene información. Para reemplazar intencionalmente los datos existentes:

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

`compose.yml` levanta PostgreSQL, el backend y los servicios operativos de migración, importación y respaldo. PostgreSQL publica su puerto sólo en `127.0.0.1` y nunca queda expuesto directamente a internet.

Primer despliegue:

```bash
cp .env.example .env
# Edita POSTGRES_PASSWORD antes de continuar.
docker compose build
docker compose up -d postgres
docker compose --profile migrate run --rm migrate
docker compose --profile import run --rm import-local-data
docker compose up -d radar-competencia-api
docker compose ps
docker compose logs -f radar-competencia-api
```

La importación histórica requiere copiar previamente, fuera de Git, `competitor-invoices.json`, `customer-sales-cache.json` y `mis-clientes.xlsx` al directorio `data/` del servidor. El importador usa `--resume`, no borra los originales y puede ejecutarse nuevamente sin duplicar facturas.

En actualizaciones posteriores no vuelvas a importar los archivos:

```bash
git pull
docker compose build
docker compose --profile migrate run --rm migrate
docker compose up -d --force-recreate radar-competencia-api
```

El API queda enlazado a `127.0.0.1:${HOST_PORT:-3010}` para Nginx o Caddy. PostgreSQL queda en `127.0.0.1:${POSTGRES_HOST_PORT:-5432}` para administración local.

Docker conserva dos volúmenes persistentes:

- `radar_competencia_postgres`: base de datos completa
- `radar_competencia_files`: archivos subidos y archivos históricos

El volumen de archivos se monta en `/app/storage`:

- `/app/storage/uploads/competitors`: archivos de competencia nuevos
- `/app/storage/uploads/customer-directory`: padrones nuevos
- `/app/storage/legacy`: copia inicial de los archivos anteriores

El despliegue separa responsabilidades:

1. `postgres` mantiene la base y espera hasta estar saludable;
2. `migrate` aplica las migraciones pendientes de Prisma y termina;
3. `import-local-data` carga la persistencia histórica cuando se solicita con el perfil `import`;
4. `volume-init` prepara las carpetas persistentes;
5. `radar-competencia-api` copia archivos históricos faltantes y levanta el API.

El API usa filesystem de sólo lectura, `/tmp` temporal, `no-new-privileges`, proceso init y rotación local de logs.

`./data` se monta como sólo lectura. La migración no elimina ni modifica sus archivos. Para comprobar el contenido persistente:

```bash
docker compose exec radar-competencia-api find /app/storage -maxdepth 3 -type f
```

No copies `.env` mediante Git; créalo directamente en el servidor.

## Respaldos de PostgreSQL

Crear un respaldo comprimido y verificable en `./backups`:

```bash
docker compose --profile backup run --rm backup
ls -lh backups/
```

Antes de restaurar, genera un respaldo nuevo y detén el API. La restauración reemplaza objetos existentes:

```bash
docker compose stop radar-competencia-api
docker compose exec -T postgres sh -c \
  'pg_restore --clean --if-exists --no-owner --no-privileges \
  --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  < backups/ARCHIVO.dump
docker compose up -d radar-competencia-api
```

Nunca ejecutes `docker compose down -v` en producción: `-v` elimina los volúmenes persistentes.

## Optimización de lecturas

- `/api/competitors/status` usa conteos SQL y ya no descarga todas las facturas.
- El dataset completo se lee una sola vez por proceso y se mantiene en memoria hasta que cambian los datos.
- `/api/competitors/data` usa una versión del dataset, caché privada por 24 horas y compresión gzip.
- El frontend consulta primero el estado, solicita la versión vigente y no repite errores de cuota no recuperables.
- Prisma selecciona únicamente las columnas utilizadas y cuenta con índices para empresa, año, dirección, estado y contraparte.

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
