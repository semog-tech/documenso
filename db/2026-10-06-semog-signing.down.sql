-- Destructive rollback: export snapshots and evidence before using against real data.
BEGIN;
DROP FUNCTION public.semog_signing_get_operation(integer,uuid);
DROP FUNCTION public.semog_signing_reserve_operation(jsonb);
DROP FUNCTION public.semog_signing_revoke_snapshot(integer,uuid);
DROP FUNCTION public.semog_signing_get_snapshot(integer,text,integer);
DROP FUNCTION public.semog_signing_register_snapshot(jsonb);
DROP TABLE semog_bridge.operations;
DROP TABLE semog_bridge.snapshots;
DROP SCHEMA semog_bridge;
COMMIT;
