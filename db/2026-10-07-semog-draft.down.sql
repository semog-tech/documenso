BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM semog_bridge.draft_receipts) THEN
    RAISE EXCEPTION 'Draft receipts exist; preserve idempotency before removing the bridge';
  END IF;
END $$;
DROP TABLE semog_bridge.draft_receipts;
COMMIT;
