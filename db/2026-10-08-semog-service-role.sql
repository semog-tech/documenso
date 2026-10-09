-- Pré-condição dos cinco SQL manuais da ponte; não habilita execução ou transporte.
-- Prisma já usa a conexão privilegiada injetada. Não conceder membership implícita.
BEGIN;
DO $$
DECLARE r record;
BEGIN
  SELECT oid, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
         rolreplication, rolbypassrls, rolinherit
    INTO r FROM pg_roles WHERE rolname = 'semog_bridge_service';
  IF NOT FOUND THEN
    CREATE ROLE semog_bridge_service NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS NOINHERIT;
    COMMENT ON ROLE semog_bridge_service IS 'Semog signing bridge service role: 2026-10-08';
  ELSE
    IF r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
       OR r.rolreplication OR r.rolbypassrls OR r.rolinherit
       OR shobj_description(r.oid, 'pg_authid') IS DISTINCT FROM 'Semog signing bridge service role: 2026-10-08'
       OR EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = r.oid OR member = r.oid) THEN
      RAISE EXCEPTION 'Role preexistente incompatível; revisar atributos e memberships';
    END IF;
  END IF;
END $$;
COMMIT;
