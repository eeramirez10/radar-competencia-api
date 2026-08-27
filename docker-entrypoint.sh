#!/bin/sh
set -eu

npm run db:deploy
node dist/migrate-storage.js /app/legacy-data

exec node dist/index.js
