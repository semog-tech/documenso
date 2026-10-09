BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM semog_bridge.activation_receipts) OR EXISTS (SELECT 1 FROM semog_bridge.draft_receipts WHERE estrutura IS NOT NULL) THEN
    RAISE EXCEPTION 'Bridge receipts in use; rollback would remove safety/idempotency evidence';
  END IF;
END $$;
DROP TABLE semog_bridge.activation_receipts;
ALTER TABLE semog_bridge.draft_receipts DROP CONSTRAINT draft_structure_object;
ALTER TABLE semog_bridge.draft_receipts DROP COLUMN estrutura;
COMMIT;
