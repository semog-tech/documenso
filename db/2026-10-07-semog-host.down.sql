BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM semog_bridge.outbox WHERE kind='seal' AND estado IN('pendente','leased','failed')) THEN
  RAISE EXCEPTION 'Stop host and reconcile pending seals before rollback';
 END IF;
END $$;
DROP FUNCTION public.semog_signing_claim_seal_effect(integer);
COMMIT;
