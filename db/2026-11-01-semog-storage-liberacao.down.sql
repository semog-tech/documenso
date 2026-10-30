-- Inverso de 2026-11-01-semog-storage-liberacao.sql. ESCRITA, NÃO APLICADA. Idempotente (IF EXISTS; funções por
-- CREATE OR REPLACE). Volta exatamente ao estado de 2026-10-31-semog-storage: guarda sem o ramo de envelope cancelado,
-- elegibilidade só COMPLETED/REJECTED e a função de migração sem a trava do Envelope.
-- O que NÃO volta: linhas já migradas continuam S3_PATH (válidas, lidas pela chave com conferência de SHA-256) e
-- objetos já purgados continuam apagados. O registro de purgas é permanente: a tabela storage_purges só é removida
-- se estiver vazia; com registros, fica (sem funções que escrevam nela) e um NOTICE avisa.
BEGIN;
-- Inscrição de volta exatamente como em 2026-10-06-semog-signing (sem a conferência do initialData).
CREATE OR REPLACE FUNCTION public.semog_signing_register_snapshot(p_snapshot jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, semog_bridge AS $$
DECLARE s semog_bridge.snapshots; old semog_bridge.snapshots;
BEGIN
  s := jsonb_populate_record(NULL::semog_bridge.snapshots, p_snapshot);
  PERFORM 1 FROM public."Envelope" e WHERE e.id = s."envelopeId" AND e."teamId" = s."teamId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'target unavailable'; END IF;
  PERFORM 1 FROM public."Recipient" r WHERE r.id = s."recipientId" AND r."envelopeId" = s."envelopeId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'target unavailable'; END IF;
  SELECT * INTO old FROM semog_bridge.snapshots WHERE "envelopeId" = s."envelopeId" AND "recipientId" = s."recipientId" AND "revogadaEm" IS NULL;
  IF FOUND THEN
    IF old."teamId" IS DISTINCT FROM s."teamId" OR old."hashSnapshot" IS DISTINCT FROM s."hashSnapshot" OR old."hashDocumento" IS DISTINCT FROM s."hashDocumento"
      OR old."hashConsentimento" IS DISTINCT FROM s."hashConsentimento" OR old.conteudo IS DISTINCT FROM s.conteudo OR old."expiraEm" IS DISTINCT FROM s."expiraEm" THEN
      RAISE EXCEPTION 'snapshot conflict';
    END IF;
    RETURN to_jsonb(old) - 'revogadaEm' - 'criadaEm';
  END IF;
  IF s."expiraEm" <= clock_timestamp() OR s."expiraEm" IS NULL THEN RAISE EXCEPTION 'snapshot expired'; END IF;
  INSERT INTO semog_bridge.snapshots(id,"teamId","envelopeId","recipientId","hashDocumento","hashConsentimento","hashSnapshot","expiraEm",conteudo)
  VALUES(s.id,s."teamId",s."envelopeId",s."recipientId",s."hashDocumento",s."hashConsentimento",s."hashSnapshot",s."expiraEm",s.conteudo)
  RETURNING * INTO s;
  RETURN to_jsonb(s) - 'revogadaEm' - 'criadaEm';
END $$;
DROP FUNCTION IF EXISTS semog_bridge.storage_purge_begin(text,integer,text,text,text);
DROP FUNCTION IF EXISTS semog_bridge.storage_purge_finish(uuid,boolean);
DROP FUNCTION IF EXISTS semog_bridge.storage_purge_abandon(uuid,text);
DROP FUNCTION IF EXISTS semog_bridge.storage_purge_candidates(integer,text);
DROP FUNCTION IF EXISTS semog_bridge.storage_purgeable_context(text,integer,text);
DROP FUNCTION IF EXISTS semog_bridge.storage_cancelled_owner(text);
DROP FUNCTION IF EXISTS semog_bridge.storage_cancellation(text);
DO $$ BEGIN
  IF to_regclass('semog_bridge.storage_purges') IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM semog_bridge.storage_purges) THEN
      RAISE NOTICE 'semog_bridge.storage_purges tem registros e é mantida (auditoria permanente).';
    ELSE
      DROP TABLE semog_bridge.storage_purges;
    END IF;
  END IF;
  -- The append-only trigger and its token functions go only with the table; a kept table keeps its protection.
  IF to_regclass('semog_bridge.storage_purges') IS NULL THEN
    DROP FUNCTION IF EXISTS semog_bridge.storage_purges_guard();
    DROP FUNCTION IF EXISTS semog_bridge.storage_purge_arm(uuid);
    DROP FUNCTION IF EXISTS semog_bridge.storage_purge_disarm(uuid);
    DROP TABLE IF EXISTS semog_bridge.storage_purge_tokens;
  END IF;
END $$;
-- Finished and quiet: completed/rejected, no pending operation or seal, no live enrollment of an unsigned recipient.
CREATE OR REPLACE FUNCTION semog_bridge.storage_migration_eligible(p_env text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
  SELECT semog_bridge.storage_is_bridge_envelope(p_env)
    AND EXISTS(SELECT 1 FROM public."Envelope" e WHERE e.id=p_env AND e.status IN ('COMPLETED','REJECTED') AND e."completedAt" IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM semog_bridge.operations WHERE "envelopeId"=p_env AND estado='pendente')
    AND NOT EXISTS(SELECT 1 FROM semog_bridge.outbox WHERE "envelopeId"=p_env AND kind='seal' AND estado IN ('pendente','leased'))
    AND NOT EXISTS(SELECT 1 FROM semog_bridge.snapshots s JOIN public."Recipient" r ON r.id=s."recipientId"
      WHERE s."envelopeId"=p_env AND s."revogadaEm" IS NULL AND s."expiraEm">clock_timestamp() AND r."signingStatus"='NOT_SIGNED');
$$;
-- Called by scripts/semog-signing-storage-migration.ts only after the object was uploaded AND read back with the
-- same SHA-256. The expected keys are a double check: the function recomputes them from the row itself.
CREATE OR REPLACE FUNCTION semog_bridge.migrate_document_data_to_s3(p_id text, p_data_key text, p_initial_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
DECLARE d public."DocumentData"; env text; data_key text; initial_key text; issued uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO d FROM public."DocumentData" WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DocumentData % not found', p_id; END IF;
  IF d.type<>'BYTES_64' THEN RAISE EXCEPTION 'DocumentData % is not inline', p_id; END IF;
  data_key:=semog_bridge.semog_pdf_key(d.data);
  initial_key:=semog_bridge.semog_pdf_key(d."initialData");
  IF data_key IS DISTINCT FROM p_data_key OR initial_key IS DISTINCT FROM p_initial_key THEN
    RAISE EXCEPTION 'DocumentData % content address mismatch', p_id;
  END IF;
  env:=COALESCE(semog_bridge.storage_owner(p_id),semog_bridge.storage_orphan_owner(p_id));
  IF env IS NULL THEN RAISE EXCEPTION 'DocumentData % is not linked to a bridge envelope', p_id; END IF;
  IF NOT semog_bridge.storage_migration_eligible(env) THEN
    RAISE EXCEPTION 'Envelope % is not a finished bridge envelope; its PDF stays inline', env;
  END IF;
  INSERT INTO semog_bridge.storage_migration_tokens(token,"documentDataId") VALUES(issued,p_id);
  PERFORM set_config('semog_bridge.storage_migration',issued::text,true);
  UPDATE public."DocumentData" SET type='S3_PATH', data=data_key, "initialData"=initial_key WHERE id=p_id;
  DELETE FROM semog_bridge.storage_migration_tokens WHERE token=issued;
  PERFORM set_config('semog_bridge.storage_migration','',true);
  RETURN jsonb_build_object('id',p_id,'envelopeId',env,'data',data_key,'initialData',initial_key);
END $$;

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
  -- Only through migrate_document_data_to_s3: its token for this row and transaction (storage_migration_allows).
  ELSIF TG_TABLE_NAME='DocumentData' AND TG_OP='UPDATE' AND semog_bridge.storage_migration_allows(before,after) THEN
    RETURN NEW;
  ELSIF TG_TABLE_NAME='Envelope' AND TG_OP='UPDATE' AND before->>'status'='PENDING'
    AND after->>'status'='CANCELLED' AND after->>'completedAt' IS NOT NULL
    AND (after-ARRAY['status','completedAt','updatedAt'])=(before-ARRAY['status','completedAt','updatedAt'])
    AND semog_bridge.cancel_allows(env) THEN RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Semog enrolled envelope is immutable outside its durable operation';
END $$;
REVOKE ALL ON FUNCTION semog_bridge.storage_migration_eligible(text),
  semog_bridge.migrate_document_data_to_s3(text,text,text),semog_bridge.guard_native_mutation() FROM PUBLIC;
COMMIT;
