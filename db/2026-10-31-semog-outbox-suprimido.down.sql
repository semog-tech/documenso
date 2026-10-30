-- Inverso de 2026-10-31-semog-outbox-suprimido.sql. Idempotente (IF EXISTS).
-- Recusa enquanto houver efeito 'suprimido': devolvê-los a 'pendente' rearmaria de uma vez todos os e-mails e
-- webhooks que a ponte deixou de enviar. Para reverter de propósito, decida item a item antes (e documente).
-- Sem nenhum 'suprimido' o inverso roda; a trava de tabela abaixo espera qualquer gravação em curso terminar antes
-- da conferência, então nenhuma linha 'suprimido' escapa entre a contagem e a troca do CHECK. Depois dele, a
-- imagem nova volta sozinha a gravar 'pendente' (consulta a migração a cada transação).
BEGIN;
LOCK TABLE semog_bridge.outbox IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM semog_bridge.outbox WHERE estado='suprimido') THEN
    RAISE EXCEPTION 'Suppressed effects present; rollback would re-arm every e-mail and webhook at once';
  END IF;
END $$;
DROP TRIGGER IF EXISTS semog_outbox_suppressed_guard ON semog_bridge.outbox;
DROP FUNCTION IF EXISTS semog_bridge.guard_suppressed_effect();
ALTER TABLE semog_bridge.outbox DROP CONSTRAINT IF EXISTS outbox_suprimido_externo;
ALTER TABLE semog_bridge.outbox DROP COLUMN IF EXISTS "suprimidoEm";
ALTER TABLE semog_bridge.outbox DROP CONSTRAINT IF EXISTS outbox_estado_check;
ALTER TABLE semog_bridge.outbox ADD CONSTRAINT outbox_estado_check
  CHECK (estado IN ('pendente','leased','delivered','failed'));
COMMIT;
