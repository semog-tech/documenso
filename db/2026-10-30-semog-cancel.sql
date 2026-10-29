-- Cancelamento: cancela pelo portal Semog um envelope PENDING ativado pela ponte, revogando as inscrições ativas.
-- Aplicar depois de 2026-10-29-semog-contact. Sem modelo Prisma novo.
-- Papel: o dono das tabelas do Documenso, o mesmo da conexão Prisma privilegiada injetada no host
-- (como nos pares irmãos). A tabela pertence a ele; RLS ligada sem FORCE e sem grant a outros papéis.
-- Sem esta migração, o cancelamento nativo (POST /api/v2/envelope/cancel) de um envelope com inscrição ativa é
-- recusado pelo gatilho de guarda, e continua sendo: o cancelamento nativo não grava recibo.
-- O gatilho de guarda é recriado com um único ramo novo (além dos da prorrogação e do contato). Ele libera um
-- UPDATE de Envelope somente quando:
--   * o status passa de PENDING para CANCELLED, completedAt fica preenchido e nenhuma outra coluna muda além
--     de updatedAt;
--   * semog_bridge.cancel_key (set_config local à transação) é a chave de um recibo deste envelope;
--   * o recibo foi gravado pela própria transação (coluna transacao xid8 = pg_current_xact_id_if_assigned()).
-- O status muda antes da revogação das inscrições, então passa por este ramo, e não pela guarda desarmada.
-- O restante da função é idêntico ao de 2026-10-29-semog-contact.sql.
BEGIN;
CREATE TABLE semog_bridge.cancel_receipts (
  "chaveOperacao" uuid PRIMARY KEY,
  "envelopeId" text NOT NULL REFERENCES public."Envelope"(id) ON DELETE RESTRICT,
  "teamId" integer NOT NULL REFERENCES public."Team"(id) ON DELETE RESTRICT,
  "userId" integer NOT NULL REFERENCES public."User"(id) ON DELETE RESTRICT,
  motivo text NOT NULL CHECK (motivo = btrim(motivo) AND char_length(motivo) BETWEEN 1 AND 500),
  hash text NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
  -- Filled in by the same transaction once the snapshots are revoked; never NULL once committed.
  resultado jsonb CHECK (resultado IS NULL OR jsonb_typeof(resultado)='object'),
  "criadoEm" timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Top-level transaction that wrote the receipt (also from a subtransaction); xid8 needs PostgreSQL 13+.
  transacao xid8 NOT NULL DEFAULT pg_current_xact_id()
);
ALTER TABLE semog_bridge.cancel_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON semog_bridge.cancel_receipts FROM PUBLIC, semog_bridge_service;

CREATE FUNCTION semog_bridge.cancel_allows(p_envelope text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
  SELECT COALESCE(current_setting('semog_bridge.cancel_key',true),'')<>'' AND EXISTS(
    SELECT 1 FROM semog_bridge.cancel_receipts r
    WHERE r."chaveOperacao"::text=current_setting('semog_bridge.cancel_key',true)
      AND r.transacao=pg_current_xact_id_if_assigned()
      AND r."envelopeId"=p_envelope);
$$;
REVOKE ALL ON FUNCTION semog_bridge.cancel_allows(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION semog_bridge.guard_native_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
DECLARE before jsonb; after jsonb; env text; rid integer; fid integer; op semog_bridge.operations;
DECLARE key text; has_own boolean; has_snapshots boolean; initial_old text; initial_new text;
BEGIN
  before:=CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE NULL END;
  after:=CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE NULL END;
  IF TG_TABLE_NAME='Envelope' THEN env:=COALESCE(before,after)->>'id';
  ELSIF TG_TABLE_NAME='DocumentMeta' THEN
    SELECT id INTO env FROM public."Envelope" WHERE "documentMetaId"=(COALESCE(after,before)->>'id');
  ELSIF TG_TABLE_NAME='DocumentData' THEN
    SELECT i."envelopeId" INTO env FROM public."EnvelopeItem" i JOIN semog_bridge.snapshots s ON s."envelopeId"=i."envelopeId" AND s."revogadaEm" IS NULL
      WHERE i."documentDataId"=(COALESCE(after,before)->>'id') LIMIT 1;
  ELSIF TG_TABLE_NAME='Signature' THEN
    fid:=(COALESCE(before,after)->>'fieldId')::integer;
    SELECT "envelopeId","recipientId" INTO env,rid FROM public."Field" WHERE id=fid;
  ELSE env:=COALESCE(before,after)->>'envelopeId'; END IF;
  IF env IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  PERFORM 1 FROM public."Envelope" WHERE id=env FOR UPDATE;
  SELECT EXISTS(SELECT 1 FROM semog_bridge.snapshots WHERE "envelopeId"=env AND "revogadaEm" IS NULL) INTO has_snapshots;
  IF NOT has_snapshots THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  key:=current_setting('semog_bridge.execution_key',true);
  IF key IS NOT NULL AND key<>'' THEN
    SELECT * INTO op FROM semog_bridge.operations WHERE "chaveOperacao"=key::uuid AND "envelopeId"=env AND estado='pendente';
  END IF;
  IF TG_TABLE_NAME IN ('Field','Signature') THEN
    rid:=COALESCE(rid,(COALESCE(after,before)->>'recipientId')::integer);
    fid:=COALESCE(fid,(COALESCE(after,before)->>'id')::integer);
    SELECT EXISTS(SELECT 1 FROM semog_bridge.snapshots WHERE "envelopeId"=env AND "recipientId"=rid AND "revogadaEm" IS NULL) INTO has_own;
    IF TG_TABLE_NAME='Signature' AND TG_OP='UPDATE' AND
      (after-ARRAY['typedSignature','signatureImageAsBase64']) IS DISTINCT FROM (before-ARRAY['typedSignature','signatureImageAsBase64']) THEN
      RAISE EXCEPTION 'signature identity is immutable'; END IF;
    IF TG_TABLE_NAME='Signature' AND TG_OP='DELETE' AND NOT has_own
      AND EXISTS(SELECT 1 FROM public."Recipient" WHERE id=rid AND "signingStatus"='NOT_SIGNED') THEN RETURN OLD; END IF;
    IF TG_TABLE_NAME='Field' AND TG_OP='UPDATE' AND (after-ARRAY['inserted','customText'])=(before-ARRAY['inserted','customText']) THEN
      IF NOT has_own AND EXISTS(SELECT 1 FROM public."Recipient" WHERE id=rid AND "signingStatus"='NOT_SIGNED') THEN RETURN NEW; END IF;
      IF op."recipientId"=rid AND op.acao='assinar' AND after->>'inserted'='true' AND EXISTS(
        SELECT 1 FROM jsonb_array_elements(op.pedido->'campos') v WHERE (v->>'fieldId')::integer=fid AND
          ((after->>'type'='TEXT' AND after->>'customText'=v->>'valor') OR (after->>'type'='SIGNATURE' AND after->>'customText'=before->>'customText'))
      ) THEN RETURN NEW; END IF;
      IF op."recipientId"=rid AND op.acao='assinar' AND after->>'type'='SIGNATURE' AND after->>'inserted'='true'
        AND after->>'customText'=before->>'customText' AND (op.pedido->'assinaturaVisual'->>'fieldId')::integer=fid THEN RETURN NEW; END IF;
      IF after=before THEN RETURN NEW; END IF;
    ELSIF TG_TABLE_NAME='Signature' AND TG_OP IN ('INSERT','UPDATE') AND (after->>'recipientId')::integer=rid THEN
      IF NOT has_own AND EXISTS(SELECT 1 FROM public."Recipient" WHERE id=rid AND "signingStatus"='NOT_SIGNED') THEN RETURN NEW; END IF;
      IF op."recipientId"=rid AND op.acao='assinar'
      AND after->'signatureImageAsBase64'='null'::jsonb AND EXISTS(SELECT 1 FROM jsonb_array_elements(op.pedido->'campos') v
        WHERE (v->>'fieldId')::integer=fid AND after->>'typedSignature'=v->>'valor') THEN RETURN NEW; END IF;
      IF op."recipientId"=rid AND op.acao='assinar' AND after->'typedSignature'='null'::jsonb
        AND (op.pedido->'assinaturaVisual'->>'fieldId')::integer=fid
        AND after->>'signatureImageAsBase64'='data:image/png;base64,'||(op.pedido->'assinaturaVisual'->>'pngBase64') THEN RETURN NEW; END IF;
    END IF;
  ELSIF TG_TABLE_NAME='Recipient' AND TG_OP='UPDATE' AND
    (after-ARRAY['signingStatus','signedAt','rejectionReason','readStatus','sendStatus','sentAt','lastReminderSentAt','nextReminderAt','reminderCount','expirationNotifiedAt'])=
    (before-ARRAY['signingStatus','signedAt','rejectionReason','readStatus','sendStatus','sentAt','lastReminderSentAt','nextReminderAt','reminderCount','expirationNotifiedAt']) THEN
    rid:=(after->>'id')::integer;
    SELECT EXISTS(SELECT 1 FROM semog_bridge.snapshots WHERE "envelopeId"=env AND "recipientId"=rid AND "revogadaEm" IS NULL) INTO has_own;
    IF (after-ARRAY['readStatus','sendStatus','sentAt','lastReminderSentAt','nextReminderAt','reminderCount','expirationNotifiedAt'])=
      (before-ARRAY['readStatus','sendStatus','sentAt','lastReminderSentAt','nextReminderAt','reminderCount','expirationNotifiedAt']) THEN RETURN NEW; END IF;
    IF NOT has_own AND before->>'signingStatus'='NOT_SIGNED' THEN RETURN NEW; END IF;
    IF op."recipientId"=rid AND before->>'signingStatus'='NOT_SIGNED' AND after->>'signedAt' IS NOT NULL AND
      ((op.acao='assinar' AND after->>'signingStatus'='SIGNED') OR
       (op.acao='recusar' AND after->>'signingStatus'='REJECTED' AND after->>'rejectionReason'=COALESCE(op.pedido->>'motivo','Documento recusado.'))) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='Envelope' AND TG_OP='UPDATE' AND before->>'status'='PENDING'
    AND after->>'status' IN ('COMPLETED','REJECTED') AND after->>'completedAt' IS NOT NULL
    AND (after-ARRAY['status','completedAt','updatedAt'])=(before-ARRAY['status','completedAt','updatedAt'])
    AND semog_bridge.ready_to_seal(env) THEN RETURN NEW;
  ELSIF TG_TABLE_NAME='Envelope' AND TG_OP='UPDATE' AND after-'updatedAt'=before-'updatedAt' THEN RETURN NEW;
  ELSIF TG_TABLE_NAME='Envelope' AND TG_OP='UPDATE' AND before->>'qrToken' IS NULL AND after->>'qrToken' IS NOT NULL
    AND (after-ARRAY['qrToken','updatedAt'])=(before-ARRAY['qrToken','updatedAt']) AND semog_bridge.ready_to_seal(env) THEN RETURN NEW;
  ELSIF TG_TABLE_NAME='EnvelopeItem' AND TG_OP='UPDATE' AND after-'documentDataId'=before-'documentDataId' AND semog_bridge.ready_to_seal(env) THEN
    SELECT "initialData" INTO initial_old FROM public."DocumentData" WHERE id=before->>'documentDataId';
    SELECT "initialData" INTO initial_new FROM public."DocumentData" WHERE id=after->>'documentDataId';
    IF initial_old IS NOT NULL AND initial_old IS NOT DISTINCT FROM initial_new THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='Recipient' AND TG_OP='UPDATE' AND before->>'signingStatus'='NOT_SIGNED' AND after->>'signingStatus'='NOT_SIGNED'
    AND (after-ARRAY['expiresAt','expirationNotifiedAt'])=(before-ARRAY['expiresAt','expirationNotifiedAt'])
    AND semog_bridge.extension_allows(env,(after->>'id')::integer,after->>'expiresAt') THEN RETURN NEW;
  ELSIF TG_TABLE_NAME='Recipient' AND TG_OP='UPDATE' AND before->>'signingStatus'='NOT_SIGNED' AND after->>'signingStatus'='NOT_SIGNED'
    AND (after-'email')=(before-'email')
    AND semog_bridge.contact_allows(env,(after->>'id')::integer,after->>'email') THEN RETURN NEW;
  ELSIF TG_TABLE_NAME='Envelope' AND TG_OP='UPDATE' AND before->>'status'='PENDING'
    AND after->>'status'='CANCELLED' AND after->>'completedAt' IS NOT NULL
    AND (after-ARRAY['status','completedAt','updatedAt'])=(before-ARRAY['status','completedAt','updatedAt'])
    AND semog_bridge.cancel_allows(env) THEN RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Semog enrolled envelope is immutable outside its durable operation';
END $$;
REVOKE ALL ON FUNCTION semog_bridge.guard_native_mutation() FROM PUBLIC;
COMMIT;
