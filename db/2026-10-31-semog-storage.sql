-- Armazenamento: permite trocar o PDF inline (BYTES_64) de um envelope ENCERRADO da ponte pelo mesmo conteúdo no
-- R2 (S3_PATH, chave = SHA-256 dos bytes), sem desligar nenhuma trigger. A guarda continua valendo para tudo o mais.
-- Aplicar depois de 2026-10-30-semog-cancel (redefine a função de guarda a partir daquela versão; o par irmão
-- 2026-10-31-semog-outbox-suprimido é independente). Sem modelo Prisma novo. ESCRITA, NÃO APLICADA. Idempotente:
-- funções por CREATE OR REPLACE, tabela por IF NOT EXISTS.
-- Papel: o dono das tabelas do Documenso, o mesmo da conexão Prisma privilegiada do host (como nos pares irmãos).
--
-- Como passa pela guarda: a única mudança aceita em DocumentData é feita por semog_bridge.migrate_document_data_to_s3.
-- Ela (1) recalcula NO BANCO a chave a partir dos bytes que a própria linha guarda — o chamador não escolhe a chave;
-- (2) exige envelope da ponte, encerrado e sem nada pendente (ou original órfão de um envelope assim); (3) grava um
-- token aleatório numa tabela que nenhum outro papel lê ou escreve, amarrado à linha e à transação corrente, e
-- marca a sessão com ele. A guarda aceita o UPDATE só se esse token existir para esta linha NESTA transação e se a
-- transformação conferir de novo (tipo, chaves, demais colunas iguais). Um set_config manual não basta: sem o token
-- na tabela, a guarda recusa como antes.
BEGIN;
CREATE TABLE IF NOT EXISTS semog_bridge.storage_migration_tokens (
  token uuid PRIMARY KEY,
  "documentDataId" text NOT NULL,
  xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
ALTER TABLE semog_bridge.storage_migration_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON semog_bridge.storage_migration_tokens FROM PUBLIC;

-- Content address of an inline Base64 PDF: the same key the bridge writes (semog/pdf/<sha256>.pdf).
CREATE OR REPLACE FUNCTION semog_bridge.semog_pdf_key(p_base64 text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT 'semog/pdf/'||encode(sha256(decode(p_base64,'base64')),'hex')||'.pdf'
$$;
-- The envelope a DocumentData belongs to: the item that points at it, or the partial seal that owns it.
CREATE OR REPLACE FUNCTION semog_bridge.storage_owner(p_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
  SELECT COALESCE(
    (SELECT "envelopeId" FROM public."EnvelopeItem" WHERE "documentDataId"=p_id LIMIT 1),
    (SELECT "envelopeId" FROM semog_bridge.partial_seals WHERE "documentDataId"=p_id));
$$;
-- A bridge envelope: drafted by the bridge or enrolled in it.
CREATE OR REPLACE FUNCTION semog_bridge.storage_is_bridge_envelope(p_env text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
  SELECT EXISTS(SELECT 1 FROM semog_bridge.draft_receipts WHERE "envelopeId"=p_env)
    OR EXISTS(SELECT 1 FROM semog_bridge.snapshots WHERE "envelopeId"=p_env);
$$;
-- An unreferenced row is accepted only as the pre-seal original of a bridge envelope: the sealed row the item now
-- points at keeps the very same INITIAL_DATA (inline, or already migrated to its content address).
CREATE OR REPLACE FUNCTION semog_bridge.storage_orphan_owner(p_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
  SELECT i."envelopeId" FROM public."DocumentData" o
    JOIN public."DocumentData" s ON s.id<>o.id
      AND (s."initialData"=o."initialData" OR (s.type='S3_PATH' AND s."initialData"=semog_bridge.semog_pdf_key(o."initialData")))
    JOIN public."EnvelopeItem" i ON i."documentDataId"=s.id
    WHERE o.id=p_id AND o.type='BYTES_64' AND semog_bridge.storage_is_bridge_envelope(i."envelopeId")
    LIMIT 1;
$$;
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
-- The only DocumentData change the guard accepts here: issued by the migration function in this very transaction,
-- inline -> its own content address, nothing else touched.
CREATE OR REPLACE FUNCTION semog_bridge.storage_migration_allows(p_old jsonb, p_new jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
  SELECT EXISTS(SELECT 1 FROM semog_bridge.storage_migration_tokens t
      WHERE t.token::text=current_setting('semog_bridge.storage_migration',true)
        AND t."documentDataId"=p_old->>'id' AND t.xid=pg_current_xact_id())
    AND p_old->>'type'='BYTES_64' AND p_new->>'type'='S3_PATH'
    AND (p_new-ARRAY['type','data','initialData'])=(p_old-ARRAY['type','data','initialData'])
    AND p_new->>'data'=semog_bridge.semog_pdf_key(p_old->>'data')
    AND p_new->>'initialData'=semog_bridge.semog_pdf_key(p_old->>'initialData')
    AND semog_bridge.storage_migration_eligible(COALESCE(semog_bridge.storage_owner(p_old->>'id'),semog_bridge.storage_orphan_owner(p_old->>'id')));
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
-- Default privileges grant EXECUTE (and table rights) to named roles; revoking from PUBLIC alone would leave them.
REVOKE ALL ON FUNCTION semog_bridge.semog_pdf_key(text),semog_bridge.storage_owner(text),
  semog_bridge.storage_is_bridge_envelope(text),semog_bridge.storage_orphan_owner(text),
  semog_bridge.storage_migration_eligible(text),semog_bridge.storage_migration_allows(jsonb,jsonb),
  semog_bridge.migrate_document_data_to_s3(text,text,text) FROM PUBLIC;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname<>current_user AND rolname NOT LIKE 'pg\_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION semog_bridge.semog_pdf_key(text),semog_bridge.storage_owner(text),'
      'semog_bridge.storage_is_bridge_envelope(text),semog_bridge.storage_orphan_owner(text),'
      'semog_bridge.storage_migration_eligible(text),semog_bridge.storage_migration_allows(jsonb,jsonb),'
      'semog_bridge.migrate_document_data_to_s3(text,text,text) FROM %I',r.rolname);
    EXECUTE format('REVOKE ALL ON semog_bridge.storage_migration_tokens FROM %I',r.rolname);
    EXECUTE format('REVOKE ALL ON FUNCTION semog_bridge.guard_native_mutation() FROM %I',r.rolname);
  END LOOP;
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
REVOKE ALL ON FUNCTION semog_bridge.guard_native_mutation() FROM PUBLIC;
COMMIT;
