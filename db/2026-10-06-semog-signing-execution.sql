BEGIN;
ALTER TABLE semog_bridge.operations DROP CONSTRAINT operations_estado_check;
ALTER TABLE semog_bridge.operations ADD CONSTRAINT operations_estado_check CHECK (estado IN ('pendente','concluida'));
ALTER TABLE semog_bridge.operations ADD COLUMN resultado jsonb CHECK (resultado IS NULL OR jsonb_typeof(resultado) = 'object');
ALTER TABLE semog_bridge.operations ADD COLUMN execucao jsonb CHECK (execucao IS NULL OR jsonb_typeof(execucao) = 'object');
CREATE TABLE semog_bridge.outbox (
  id text PRIMARY KEY,
  "chaveOperacao" uuid NOT NULL REFERENCES semog_bridge.operations("chaveOperacao") ON DELETE RESTRICT,
  "envelopeId" text NOT NULL REFERENCES public."Envelope"(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('job','webhook','seal')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  estado text NOT NULL DEFAULT 'pendente' CHECK (estado IN ('pendente','leased','delivered','failed')),
  tentativa integer NOT NULL DEFAULT 0,
  lease uuid,
  "leaseAte" timestamptz,
  "criadaEm" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "entregueEm" timestamptz
);
ALTER TABLE semog_bridge.outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON semog_bridge.outbox FROM PUBLIC, semog_bridge_service;

CREATE OR REPLACE FUNCTION public.semog_signing_reserve_operation(p_operation jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
DECLARE s semog_bridge.snapshots; o semog_bridge.operations; old semog_bridge.operations;
BEGIN
  o:=jsonb_populate_record(NULL::semog_bridge.operations,p_operation);
  PERFORM 1 FROM public."Envelope" WHERE id=o."envelopeId" AND "teamId"=o."teamId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'envelope unavailable'; END IF;
  SELECT * INTO s FROM semog_bridge.snapshots WHERE id=o."snapshotId" AND "teamId"=o."teamId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'snapshot unavailable'; END IF;
  SELECT * INTO old FROM semog_bridge.operations WHERE "chaveOperacao"=o."chaveOperacao";
  IF FOUND THEN
    IF (to_jsonb(old)-ARRAY['criadaEm','estado','resultado','execucao']) IS DISTINCT FROM
      jsonb_build_object('chaveOperacao',o."chaveOperacao",'snapshotId',o."snapshotId",'teamId',o."teamId",'envelopeId',o."envelopeId",'recipientId',o."recipientId",'hashDocumento',o."hashDocumento",'hashConsentimento',o."hashConsentimento",'acao',o.acao,'hashPedido',o."hashPedido",'pedido',o.pedido,'evidencias',o.evidencias) THEN RAISE EXCEPTION 'operation conflict'; END IF;
    RETURN to_jsonb(old);
  END IF;
  IF s."revogadaEm" IS NOT NULL OR s."expiraEm"<=clock_timestamp() THEN RAISE EXCEPTION 'snapshot inactive'; END IF;
  IF s."envelopeId" IS DISTINCT FROM o."envelopeId" OR s."recipientId" IS DISTINCT FROM o."recipientId" OR
    s."hashDocumento" IS DISTINCT FROM o."hashDocumento" OR s."hashConsentimento" IS DISTINCT FROM o."hashConsentimento" THEN RAISE EXCEPTION 'binding mismatch'; END IF;
  INSERT INTO semog_bridge.operations("chaveOperacao","snapshotId","teamId","envelopeId","recipientId","hashDocumento","hashConsentimento",acao,"hashPedido",pedido,evidencias)
    VALUES(o."chaveOperacao",o."snapshotId",o."teamId",o."envelopeId",o."recipientId",o."hashDocumento",o."hashConsentimento",o.acao,o."hashPedido",o.pedido,o.evidencias) RETURNING * INTO o;
  RETURN to_jsonb(o);
END $$;

CREATE FUNCTION semog_bridge.ready_to_seal(p_envelope text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
  SELECT EXISTS(SELECT 1 FROM semog_bridge.outbox WHERE "envelopeId"=p_envelope AND kind='seal')
  AND (EXISTS(SELECT 1 FROM public."Recipient" WHERE "envelopeId"=p_envelope AND "signingStatus"='REJECTED')
    OR NOT EXISTS(SELECT 1 FROM public."Recipient" WHERE "envelopeId"=p_envelope AND role<>'CC' AND "signingStatus"<>'SIGNED'));
$$;

CREATE FUNCTION public.semog_signing_finish_operation(p_team integer,p_key uuid,p_result jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
DECLARE o semog_bridge.operations; r public."Recipient";
BEGIN
  SELECT * INTO o FROM semog_bridge.operations WHERE "chaveOperacao"=p_key AND "teamId"=p_team FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation unavailable'; END IF;
  IF o.estado='concluida' THEN
    IF o.resultado IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'result conflict'; END IF;
    RETURN true;
  END IF;
  SELECT * INTO r FROM public."Recipient" WHERE id=o."recipientId" AND "envelopeId"=o."envelopeId";
  IF NOT FOUND OR (o.acao='assinar' AND r."signingStatus"<>'SIGNED') OR (o.acao='recusar' AND r."signingStatus"<>'REJECTED') THEN
    RAISE EXCEPTION 'native state unconfirmed';
  END IF;
  IF o.execucao IS NULL OR o.execucao->>'snapshotId' IS DISTINCT FROM o."snapshotId"::text
    OR o.execucao->>'hashDocumento' IS DISTINCT FROM o."hashDocumento"
    OR (o.execucao->>'teamId')::integer IS DISTINCT FROM o."teamId"
    OR NOT EXISTS(SELECT 1 FROM semog_bridge.snapshots s WHERE s.id=o."snapshotId" AND s."hashSnapshot"=o.execucao->>'hashSnapshot')
    OR NOT EXISTS(SELECT 1 FROM public."DocumentAuditLog" a WHERE a."envelopeId"=o."envelopeId"
      AND a.id IN (SELECT jsonb_array_elements_text(o.execucao->'auditIds'))
      AND (a.data->>'recipientId')::integer=o."recipientId"
      AND a.type=CASE WHEN o.acao='assinar' THEN 'DOCUMENT_RECIPIENT_COMPLETED' ELSE 'DOCUMENT_RECIPIENT_REJECTED' END)
    THEN RAISE EXCEPTION 'transaction receipt or native audit unavailable'; END IF;
  IF p_result->>'chaveOperacao' IS DISTINCT FROM p_key::text OR p_result->>'envelopeId' IS DISTINCT FROM o."envelopeId"
    OR (p_result->>'recipientId')::integer IS DISTINCT FROM o."recipientId" OR p_result->>'acao' IS DISTINCT FROM o.acao
    OR p_result->>'hashDocumento' IS DISTINCT FROM o."hashDocumento" OR p_result->>'hashConsentimento' IS DISTINCT FROM o."hashConsentimento"
    OR p_result->>'situacao' IS DISTINCT FROM 'concluida' OR p_result->>'documentoConcluido' IS DISTINCT FROM 'false'
    OR p_result->>'pdfDisponivel' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'result binding mismatch'; END IF;
  UPDATE semog_bridge.operations SET estado='concluida',resultado=p_result WHERE "chaveOperacao"=p_key;
  RETURN true;
END $$;

CREATE FUNCTION public.semog_signing_claim_effect(p_seconds integer DEFAULT 60) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
DECLARE e semog_bridge.outbox;
BEGIN
  IF p_seconds<1 OR p_seconds>300 THEN RAISE EXCEPTION 'invalid lease'; END IF;
  SELECT * INTO e FROM semog_bridge.outbox WHERE tentativa<8 AND
    (estado='pendente' OR (estado='leased' AND "leaseAte"<clock_timestamp())) ORDER BY "criadaEm",id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE semog_bridge.outbox SET estado='leased',tentativa=tentativa+1,lease=gen_random_uuid(),"leaseAte"=clock_timestamp()+make_interval(secs=>p_seconds)
    WHERE id=e.id RETURNING * INTO e;
  RETURN to_jsonb(e);
END $$;
CREATE FUNCTION public.semog_signing_ack_effect(p_id text,p_lease uuid,p_success boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
BEGIN
  UPDATE semog_bridge.outbox SET estado=CASE WHEN p_success THEN 'delivered' WHEN tentativa>=8 THEN 'failed' ELSE 'pendente' END,
    "entregueEm"=CASE WHEN p_success THEN clock_timestamp() ELSE NULL END,lease=NULL,"leaseAte"=NULL
    WHERE id=p_id AND lease=p_lease AND estado='leased' AND "leaseAte">clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'lease lost'; END IF;
  RETURN true;
END $$;

-- The transaction key is an execution capability, never a public request parameter or global session setting.
-- Native handlers do not set it. Every permitted mutation is additionally checked against the durable request.
CREATE FUNCTION semog_bridge.guard_native_mutation() RETURNS trigger
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
  END IF;
  RAISE EXCEPTION 'Semog enrolled envelope is immutable outside its durable operation';
END $$;
CREATE TRIGGER semog_envelope_guard BEFORE UPDATE OR DELETE ON public."Envelope" FOR EACH ROW EXECUTE FUNCTION semog_bridge.guard_native_mutation();
CREATE TRIGGER semog_recipient_guard BEFORE INSERT OR UPDATE OR DELETE ON public."Recipient" FOR EACH ROW EXECUTE FUNCTION semog_bridge.guard_native_mutation();
CREATE TRIGGER semog_field_guard BEFORE INSERT OR UPDATE OR DELETE ON public."Field" FOR EACH ROW EXECUTE FUNCTION semog_bridge.guard_native_mutation();
CREATE TRIGGER semog_signature_guard BEFORE INSERT OR UPDATE OR DELETE ON public."Signature" FOR EACH ROW EXECUTE FUNCTION semog_bridge.guard_native_mutation();
CREATE TRIGGER semog_meta_guard BEFORE UPDATE OR DELETE ON public."DocumentMeta" FOR EACH ROW EXECUTE FUNCTION semog_bridge.guard_native_mutation();
CREATE TRIGGER semog_item_guard BEFORE INSERT OR UPDATE OR DELETE ON public."EnvelopeItem" FOR EACH ROW EXECUTE FUNCTION semog_bridge.guard_native_mutation();
CREATE TRIGGER semog_data_guard BEFORE UPDATE OR DELETE ON public."DocumentData" FOR EACH ROW EXECUTE FUNCTION semog_bridge.guard_native_mutation();
CREATE TRIGGER semog_attachment_guard BEFORE INSERT OR UPDATE OR DELETE ON public."EnvelopeAttachment" FOR EACH ROW EXECUTE FUNCTION semog_bridge.guard_native_mutation();
REVOKE ALL ON FUNCTION semog_bridge.ready_to_seal(text),semog_bridge.guard_native_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.semog_signing_finish_operation(integer,uuid,jsonb),public.semog_signing_claim_effect(integer),public.semog_signing_ack_effect(text,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.semog_signing_finish_operation(integer,uuid,jsonb),public.semog_signing_claim_effect(integer),public.semog_signing_ack_effect(text,uuid,boolean) TO semog_bridge_service;
COMMIT;
