#!/bin/sh
set -eu

node dist/migrate-storage.js /app/legacy-data

exec node dist/index.js
