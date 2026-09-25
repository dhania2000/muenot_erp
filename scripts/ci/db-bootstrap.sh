#!/usr/bin/env bash
# Build a throwaway MySQL database for CI / local E2E runs.
#
#   DB_HOST=127.0.0.1 DB_USER=ci DB_PASSWORD=ci-pass DB_NAME=erp_ci scripts/ci/db-bootstrap.sh
#
# Applies database/schema.sql, then replays every migration in filename order
# with --force. The historical migration chain is not replay-clean on an empty
# database (date-order dependencies, FK type drift); the app self-heals its
# own tables at runtime (ensure*Schema), so failures are reported, not fatal.
# The report is written to $REPORT (default: migration-report.md) and uploaded
# as a CI artifact so drift is visible and fixable.
set -euo pipefail

: "${DB_HOST:?DB_HOST required}" "${DB_USER:?DB_USER required}" "${DB_NAME:?DB_NAME required}"
DB_PORT="${DB_PORT:-3306}"
REPORT="${REPORT:-migration-report.md}"
export MYSQL_PWD="${DB_PASSWORD:-}"
MYSQL=(mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" --protocol=TCP)

"${MYSQL[@]}" -e "DROP DATABASE IF EXISTS \`$DB_NAME\`; CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
"${MYSQL[@]}" "$DB_NAME" < database/schema.sql

total=0
failed=0
{
  echo "# Migration replay report"
  echo
  echo "Database: \`$DB_NAME\` on \`$DB_HOST\`"
  echo
  echo "| Migration | Error |"
  echo "|---|---|"
} > "$REPORT"

for file in $(ls database/migrations/*.sql | sort); do
  total=$((total + 1))
  errors=$("${MYSQL[@]}" --force "$DB_NAME" < "$file" 2>&1 | grep '^ERROR' || true)
  if [ -n "$errors" ]; then
    failed=$((failed + 1))
    while IFS= read -r line; do
      echo "| \`$(basename "$file")\` | ${line//|/\\|} |" >> "$REPORT"
    done <<< "$errors"
  fi
done

{
  echo
  echo "**$failed of $total migrations reported errors.** Duplicate-column/table errors are harmless replays;"
  echo "missing-table and foreign-key errors mean the migration depends on a table created later or at runtime."
} >> "$REPORT"

echo "schema.sql applied; $total migrations replayed, $failed with errors (see $REPORT)"
