-- Outbox: efeitos job/webhook passam a nascer em estado final 'suprimido' enquanto a entrega externa estiver
-- desligada (SEMOG_SIGNING_DELIVERY_ENABLED != true), e os que já se acumularam como 'pendente' são marcados
-- 'suprimido' (sem DELETE: a linha continua como evidência do que a ponte teria enviado).
-- Aplicar depois de 2026-10-30-semog-cancel. Sem modelo Prisma novo. ESCRITA, NÃO APLICADA. Idempotente: rodar de
-- novo só repete o backfill.
-- Papel: o dono das tabelas do Documenso, o mesmo da conexão Prisma privilegiada do host (como nos pares irmãos).
--
-- Ordem de deploy: cada gravação da imagem nova consulta, na própria transação, se esta migração existe
-- (semog_bridge.guard_suppressed_effect()); sem ela grava 'pendente' como antes. Então qualquer ordem é segura
-- para as gravações novas. O backfill, porém, só alcança o que estava pendente quando ele rodou: se a migração
-- vier ANTES da imagem nova, a imagem antiga continua gravando 'pendente' até o deploy — rode este arquivo de novo
-- (ou só o UPDATE do backfill) depois do deploy da imagem nova.
BEGIN;
ALTER TABLE semog_bridge.outbox DROP CONSTRAINT IF EXISTS outbox_estado_check;
ALTER TABLE semog_bridge.outbox ADD CONSTRAINT outbox_estado_check
  CHECK (estado IN ('pendente','leased','delivered','failed','suprimido'));
ALTER TABLE semog_bridge.outbox ADD COLUMN IF NOT EXISTS "suprimidoEm" timestamptz;
ALTER TABLE semog_bridge.outbox DROP CONSTRAINT IF EXISTS outbox_suprimido_externo;
ALTER TABLE semog_bridge.outbox ADD CONSTRAINT outbox_suprimido_externo
  CHECK (estado<>'suprimido' OR kind IN ('job','webhook'));

-- 'suprimido' é final: nenhum caminho (claim, ack, UPDATE manual de um adaptador futuro) o tira desse estado.
-- Os claims já só pegam 'pendente' ou 'leased' vencido; esta trava torna isso uma garantia, não um acaso.
CREATE OR REPLACE FUNCTION semog_bridge.guard_suppressed_effect() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,semog_bridge AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.estado='suprimido' AND NEW.estado IS DISTINCT FROM 'suprimido' THEN
    RAISE EXCEPTION 'Suppressed Semog effect % is final and is never delivered', OLD.id;
  END IF;
  IF NEW.estado='suprimido' AND NEW."suprimidoEm" IS NULL THEN
    NEW."suprimidoEm":=clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION semog_bridge.guard_suppressed_effect() FROM PUBLIC;
DO $$ DECLARE r record; BEGIN
  -- Default privileges grant EXECUTE to named roles; revoking from PUBLIC alone would leave them in place.
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname<>current_user AND rolname NOT LIKE 'pg\_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION semog_bridge.guard_suppressed_effect() FROM %I',r.rolname);
  END LOOP;
END $$;
DROP TRIGGER IF EXISTS semog_outbox_suppressed_guard ON semog_bridge.outbox;
CREATE TRIGGER semog_outbox_suppressed_guard BEFORE INSERT OR UPDATE ON semog_bridge.outbox
  FOR EACH ROW EXECUTE FUNCTION semog_bridge.guard_suppressed_effect();

-- Backfill: só job/webhook ainda pendentes. 'leased' não existe para eles com a entrega desligada (o worker
-- reclama só selagens); se existir, fica de fora e aparece na conferência abaixo.
UPDATE semog_bridge.outbox SET estado='suprimido' WHERE kind IN ('job','webhook') AND estado='pendente';
DO $$ DECLARE restantes integer; BEGIN
  SELECT count(*) INTO restantes FROM semog_bridge.outbox WHERE kind IN ('job','webhook') AND estado IN ('pendente','leased');
  RAISE NOTICE 'Efeitos externos suprimidos; ainda pendentes/leased: %', restantes;
END $$;
COMMIT;
