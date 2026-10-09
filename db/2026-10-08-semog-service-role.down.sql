-- Aplicar depois dos cinco inversos da ponte. Nunca usa DROP OWNED ou CASCADE.
BEGIN;
DO $$
DECLARE r record;
BEGIN
  IF to_regnamespace('semog_bridge') IS NOT NULL THEN
    RAISE EXCEPTION 'Remova primeiro o schema da ponte com os inversos revisados';
  END IF;
  SELECT oid INTO r FROM pg_roles WHERE rolname = 'semog_bridge_service';
  IF FOUND THEN
    IF shobj_description(r.oid, 'pg_authid') IS DISTINCT FROM 'Semog signing bridge service role: 2026-10-08' THEN
      RAISE EXCEPTION 'Role preexistente não gerenciada por esta migração';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = r.oid OR member = r.oid) THEN
      RAISE EXCEPTION 'Role possui memberships; revisar manualmente antes do rollback';
    END IF;
    DROP ROLE semog_bridge_service;
  END IF;
END $$;
COMMIT;
