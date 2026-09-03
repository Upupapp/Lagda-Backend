#!/usr/bin/env bash
#
# Provisions a local PostgreSQL cluster for `npm run test:integration`.
#
# ── Why a script and not a paragraph ───────────────────────────────────────
#
# The integration suite needs a REAL multi-connection PostgreSQL, and the two
# ways to get one wrong both fail confusingly. Prose describing the fix is
# something the next person reads after losing an hour; a command is not.
#
# Idempotent: run it as often as you like. It starts a cluster if none is
# listening, and creates the database if it is absent.
#
#   ./scripts/testing/test-database.sh
#   DATABASE_TEST_URL="postgres://postgres@127.0.0.1:55433/lagda_test" \
#     npm run test:integration
#
set -euo pipefail

PORT="${LAGDA_TEST_PG_PORT:-55433}"
DATA_DIR="${LAGDA_TEST_PG_DATA:-${TMPDIR:-/tmp}/lagda-test-pg/data}"
# ── The socket directory is SHORT on purpose ───────────────────────────────
#
# A Unix socket path may not exceed 103 bytes. Postgres binds TCP first and
# then fails with "could not create any Unix-domain sockets", so a long data
# directory produces a startup failure whose message never mentions length.
SOCKET_DIR="${LAGDA_TEST_PG_SOCKET:-/tmp/lagda-pg}"
DB_NAME="lagda_test"

# ── Finding the binaries ───────────────────────────────────────────────────
#
# `postgres` is usually not on PATH even where it is installed: Postgres.app
# ships under /Applications and adds nothing to the shell. Checking only PATH
# is how one concludes there is no PostgreSQL on a machine that has it.
find_bindir() {
  if command -v initdb >/dev/null 2>&1; then
    dirname "$(command -v initdb)"
    return 0
  fi
  for candidate in /Applications/Postgres.app/Contents/Versions/*/bin \
                   /opt/homebrew/opt/postgresql@*/bin \
                   /usr/lib/postgresql/*/bin; do
    if [ -x "${candidate}/initdb" ]; then
      echo "${candidate}"
      return 0
    fi
  done
  return 1
}

BINDIR="$(find_bindir)" || {
  echo "No PostgreSQL binaries found." >&2
  echo "Looked on PATH, in Postgres.app, in Homebrew and in /usr/lib." >&2
  echo "Set LAGDA_TEST_PG_BIN to a directory containing initdb." >&2
  exit 1
}
export PATH="${LAGDA_TEST_PG_BIN:-$BINDIR}:$PATH"

if pg_isready -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1; then
  echo "PostgreSQL already listening on ${PORT}."
else
  if [ ! -d "$DATA_DIR" ]; then
    echo "Creating a cluster in ${DATA_DIR}"
    mkdir -p "$(dirname "$DATA_DIR")"
    # `trust` because this cluster holds nothing but test fixtures and is
    # bound to the loopback interface. It is not a template for deployment.
    initdb -D "$DATA_DIR" -U postgres --auth=trust --encoding=UTF8 >/dev/null
  fi
  mkdir -p "$SOCKET_DIR"
  pg_ctl -D "$DATA_DIR" -l "${DATA_DIR}/../server.log" \
    -o "-p ${PORT} -k ${SOCKET_DIR} -c listen_addresses=127.0.0.1 -c max_connections=50" \
    start
fi

# ── The name must contain "test" ───────────────────────────────────────────
#
# The harness refuses any other name, because it TRUNCATES between cases and
# an unlucky environment variable must not be able to point that at a
# development database.
if ! psql -h 127.0.0.1 -p "$PORT" -U postgres -lqt | cut -d '|' -f1 | grep -qw "$DB_NAME"; then
  createdb -h 127.0.0.1 -p "$PORT" -U postgres "$DB_NAME"
  echo "Created database ${DB_NAME}."
fi

echo
echo "Ready. Run the suite with:"
echo
echo "  DATABASE_TEST_URL=\"postgres://postgres@127.0.0.1:${PORT}/${DB_NAME}\" \\"
echo "    npm run test:integration"
echo
echo "Migrations are applied by the harness; there is no separate step."
