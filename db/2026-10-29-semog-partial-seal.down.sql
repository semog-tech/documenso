-- Recusa enquanto houver selo parcial: a linha é a única ligação entre a rodada e o PDF selado.
-- Exportar partial_seals e os DocumentData referenciados antes de qualquer remoção manual.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM semog_bridge.partial_seals) THEN
    RAISE EXCEPTION 'Partial seals in use; rollback would orphan sealed PDFs and their round evidence';
  END IF;
END $$;
DROP TABLE semog_bridge.partial_seals;
COMMIT;
