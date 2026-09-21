#!/bin/sh
# Runs once, on first database initialisation only (postgres entrypoint). The application role the
# ai-bills migrations expect: LOGIN, no BYPASSRLS, password from the stack environment. Grants on
# tables are made by the app's own migrations (drizzle/0001_rls.sql), which run as the owner.
# The password goes in as a psql variable, so any character in it is quoted correctly.
set -eu
psql -v ON_ERROR_STOP=1 -v app_password="$POSTGRES_APP_PASSWORD" -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zecori_app') THEN CREATE ROLE zecori_app LOGIN; END IF;
END $$;
ALTER ROLE zecori_app WITH LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
GRANT CONNECT ON DATABASE :"DBNAME" TO zecori_app;
SQL
