-- Liberação de espaço: (1) amplia a migração BYTES_64 -> S3_PATH por token para envelopes CANCELLED (com ou sem
-- recibo de cancelamento da ponte) e PENDING quietos; (2) fecha a brecha da guarda em envelope cancelado; (3) cria o
-- registro permanente de purgas de objeto do R2 (semog_bridge.storage_purges) e as funções que decidem, NO BANCO, o
-- que pode ser purgado. Aplicar depois de 2026-10-31-semog-storage. Sem modelo Prisma novo. ESCRITA, NÃO APLICADA.
-- Idempotente: funções por CREATE OR REPLACE, tabela/índice por IF NOT EXISTS, triggers por DROP IF EXISTS + CREATE.
-- Papel: o dono das tabelas do Documenso, o mesmo da conexão Prisma privilegiada do host (como nos pares irmãos).
--
-- Elegibilidade (storage_migration_eligible), sempre só para envelope da ponte, sem operação pendente e sem selagem
-- na fila:
--   * COMPLETED/REJECTED: como antes (sem inscrição viva e não expirada de quem não assinou);
--   * CANCELLED e PENDING: nenhuma inscrição não revogada de destinatário NOT_SIGNED, expirada ou não. A snapshot
--     guarda o SHA-256 da STRING initialData (Base64 inline ou a chave), não dos bytes: migrar com uma inscrição viva
--     faria a assinatura dela ser recusada. A função de migração trava a linha do Envelope antes de decidir, a mesma
--     trava que inscrição, execução, selagem e cancelamento tomam.
-- Guarda: a linha de DocumentData de envelope da ponte CANCELLED (item ou selo parcial) não aceita UPDATE nem
-- DELETE, exceto a transformação exata da migração por token. Nenhum outro ramo muda; a busca do envelope por
-- snapshot viva passa a olhar o id antigo e o novo (troca de id cascateia para EnvelopeItem depois do BEFORE).
-- Purga: nunca toca linha de DocumentData. storage_purge_begin registra a intenção (pendente) ANTES de qualquer
-- remoção; o chamador apaga o objeto e chama storage_purge_finish (purgada) ou storage_purge_abandon (desistida).
-- Registro pendente sem conclusão = remoção talvez feita, retomada na próxima execução; nunca um registro de purga
-- que não houve, nem objeto apagado sem registro.
BEGIN;
-- Envelope CANCELLED da ponte que referencia esta linha (pelo item ou como selo parcial).
CREATE OR REPLACE FUNCTION semog_bridge.storage_cancelled_owner(p_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
  SELECT o.env FROM (
      SELECT "envelopeId" env FROM public."EnvelopeItem" WHERE "documentDataId"=p_id
      UNION ALL SELECT "envelopeId" FROM semog_bridge.partial_seals WHERE "documentDataId"=p_id) o
    JOIN public."Envelope" e ON e.id=o.env
    WHERE e.status='CANCELLED' AND semog_bridge.storage_is_bridge_envelope(o.env)
    LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION semog_bridge.storage_migration_eligible(p_env text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
  SELECT semog_bridge.storage_is_bridge_envelope(p_env)
    AND NOT EXISTS(SELECT 1 FROM semog_bridge.operations WHERE "envelopeId"=p_env AND estado='pendente')
    AND NOT EXISTS(SELECT 1 FROM semog_bridge.outbox WHERE "envelopeId"=p_env AND kind='seal' AND estado IN ('pendente','leased'))
    AND EXISTS(SELECT 1 FROM public."Envelope" e WHERE e.id=p_env AND (
      (e.status IN ('COMPLETED','REJECTED') AND e."completedAt" IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM semog_bridge.snapshots s JOIN public."Recipient" r ON r.id=s."recipientId"
          WHERE s."envelopeId"=p_env AND s."revogadaEm" IS NULL AND s."expiraEm">clock_timestamp() AND r."signingStatus"='NOT_SIGNED'))
      OR (e.status IN ('CANCELLED','PENDING')
        AND NOT EXISTS(SELECT 1 FROM semog_bridge.snapshots s JOIN public."Recipient" r ON r.id=s."recipientId"
          WHERE s."envelopeId"=p_env AND s."revogadaEm" IS NULL AND r."signingStatus"='NOT_SIGNED'))));
$$;
-- Called by scripts/semog-signing-storage-migration.ts only after the object was uploaded AND read back with the
-- same SHA-256. The expected keys are a double check: the function recomputes them from the row itself. The
-- Envelope row is locked before the decision, so no enrollment, signature, seal or cancel runs alongside it.
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
  PERFORM 1 FROM public."Envelope" WHERE id=env FOR UPDATE;
  IF NOT semog_bridge.storage_migration_eligible(env) THEN
    RAISE EXCEPTION 'Envelope % is not eligible for storage migration (signature, seal or live enrollment pending); its PDF stays inline', env;
  END IF;
  INSERT INTO semog_bridge.storage_migration_tokens(token,"documentDataId") VALUES(issued,p_id);
  PERFORM set_config('semog_bridge.storage_migration',issued::text,true);
  UPDATE public."DocumentData" SET type='S3_PATH', data=data_key, "initialData"=initial_key WHERE id=p_id;
  DELETE FROM semog_bridge.storage_migration_tokens WHERE token=issued;
  PERFORM set_config('semog_bridge.storage_migration','',true);
  RETURN jsonb_build_object('id',p_id,'envelopeId',env,'data',data_key,'initialData',initial_key);
END $$;

-- Registro permanente: o que foi purgado, de quais envelopes, por quê, com que base de retenção e por quem. Hash,
-- motivo e autoria do cancelamento continuam em cancel_receipts / DocumentAuditLog; aqui fica o destino do objeto.
CREATE TABLE IF NOT EXISTS semog_bridge.storage_purges (
  id uuid PRIMARY KEY,
  chave text NOT NULL CHECK (chave ~ '^semog/pdf/[a-f0-9]{64}\.pdf$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  envelopes text[] NOT NULL CHECK (cardinality(envelopes) > 0),
  motivo text NOT NULL CHECK (motivo = btrim(motivo) AND char_length(motivo) BETWEEN 1 AND 500),
  "canceladoEm" timestamptz,
  "retencaoDias" integer NOT NULL CHECK ("retencaoDias" >= 1),
  -- Envelope purgado antes da retenção, por pedido explícito (CLI --agora); NULL na purga por retenção.
  "envelopeImediato" text,
  quem text NOT NULL CHECK (quem = btrim(quem) AND char_length(quem) BETWEEN 1 AND 200),
  estado text NOT NULL CHECK (estado IN ('pendente','purgada','desistida')),
  "registradaEm" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "concluidaEm" timestamptz,
  "objetoAusente" boolean,
  -- DocumentData que passaram a apontar para a chave entre o registro e a remoção (esperado: sempre vazio).
  conflitos text[],
  observacao text CHECK (observacao IS NULL OR char_length(observacao) <= 500),
  CHECK (chave = 'semog/pdf/'||sha256||'.pdf'),
  CHECK ((estado = 'pendente') = ("concluidaEm" IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS storage_purges_one_pending ON semog_bridge.storage_purges(chave) WHERE estado='pendente';
ALTER TABLE semog_bridge.storage_purges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON semog_bridge.storage_purges FROM PUBLIC;
-- Same pattern as storage_migration_tokens: a write to storage_purges is accepted only with a token that the purge
-- function itself stored here, for that row and in this very transaction. A set_config alone does not pass.
CREATE TABLE IF NOT EXISTS semog_bridge.storage_purge_tokens (
  token uuid PRIMARY KEY,
  "purgeId" uuid NOT NULL,
  xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
ALTER TABLE semog_bridge.storage_purge_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON semog_bridge.storage_purge_tokens FROM PUBLIC;
CREATE OR REPLACE FUNCTION semog_bridge.storage_purge_arm(p_purge uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
DECLARE issued uuid:=gen_random_uuid();
BEGIN
  INSERT INTO semog_bridge.storage_purge_tokens(token,"purgeId") VALUES(issued,p_purge);
  PERFORM set_config('semog_bridge.storage_purge',issued::text,true);
  RETURN issued;
END $$;
CREATE OR REPLACE FUNCTION semog_bridge.storage_purge_disarm(p_token uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
BEGIN
  DELETE FROM semog_bridge.storage_purge_tokens WHERE token=p_token;
  PERFORM set_config('semog_bridge.storage_purge','',true);
END $$;

-- Append-only, written only by the purge functions (token of storage_purge_arm): no DELETE, no TRUNCATE, and a
-- row moves once, from 'pendente' to 'purgada' or 'desistida', keeping what it recorded.
CREATE OR REPLACE FUNCTION semog_bridge.storage_purges_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
DECLARE armed boolean;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'storage purge records are permanent'; END IF;
  SELECT EXISTS(SELECT 1 FROM semog_bridge.storage_purge_tokens t
    WHERE t.token::text=current_setting('semog_bridge.storage_purge',true) AND t."purgeId"=NEW.id
      AND t.xid=pg_current_xact_id()) INTO armed;
  IF TG_OP='INSERT' AND NEW.estado='pendente' AND armed THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.estado='pendente' AND NEW.estado IN ('purgada','desistida') AND armed AND NEW.id=OLD.id
    AND (to_jsonb(NEW)-ARRAY['estado','concluidaEm','objetoAusente','conflitos','observacao'])
      =(to_jsonb(OLD)-ARRAY['estado','concluidaEm','objetoAusente','conflitos','observacao']) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'storage purge records change only through the purge functions';
END $$;
DROP TRIGGER IF EXISTS storage_purges_guard ON semog_bridge.storage_purges;
CREATE TRIGGER storage_purges_guard BEFORE INSERT OR UPDATE OR DELETE ON semog_bridge.storage_purges
  FOR EACH ROW EXECUTE FUNCTION semog_bridge.storage_purges_guard();
DROP TRIGGER IF EXISTS storage_purges_no_truncate ON semog_bridge.storage_purges;
CREATE TRIGGER storage_purges_no_truncate BEFORE TRUNCATE ON semog_bridge.storage_purges
  FOR EACH STATEMENT EXECUTE FUNCTION semog_bridge.storage_purges_guard();

-- A DocumentData row whose object may go: the item of a CANCELLED bridge envelope cancelled longer ago than the
-- retention (or the envelope named for immediate purge), and never a partial seal. Anything else — another
-- envelope, a sealed PDF, an orphan with no item — keeps the object.
CREATE OR REPLACE FUNCTION semog_bridge.storage_purgeable_context(p_id text, p_retention_days integer, p_immediate text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
  SELECT NOT EXISTS(SELECT 1 FROM semog_bridge.partial_seals WHERE "documentDataId"=p_id)
    AND EXISTS(SELECT 1 FROM public."EnvelopeItem" i JOIN public."Envelope" e ON e.id=i."envelopeId"
      WHERE i."documentDataId"=p_id AND e.status='CANCELLED' AND semog_bridge.storage_is_bridge_envelope(e.id)
        AND (e.id=p_immediate OR e."completedAt"<=clock_timestamp()-make_interval(days=>p_retention_days)));
$$;
-- Keys that may be purged now: every S3_PATH row pointing at the key (data or initialData) is purgeable, and the
-- key was not already purged after its latest cancellation. p_immediate limits the search to that envelope.
CREATE OR REPLACE FUNCTION semog_bridge.storage_purge_candidates(p_retention_days integer, p_immediate text)
RETURNS TABLE(chave text, envelopes text[], "canceladoEm" timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
  WITH scope AS (
    SELECT DISTINCT k.chave FROM public."DocumentData" d
      JOIN public."EnvelopeItem" i ON i."documentDataId"=d.id
      JOIN public."Envelope" e ON e.id=i."envelopeId"
      CROSS JOIN LATERAL (VALUES (d.data),(d."initialData")) k(chave)
      WHERE d.type='S3_PATH' AND e.status='CANCELLED' AND (p_immediate IS NULL OR e.id=p_immediate)
        AND k.chave ~ '^semog/pdf/[a-f0-9]{64}\.pdf$'
  ), refs AS (
    SELECT s.chave, i."envelopeId" env, e."completedAt" em,
      semog_bridge.storage_purgeable_context(d.id,p_retention_days,p_immediate) purgeable
    FROM scope s JOIN public."DocumentData" d ON d.type='S3_PATH' AND (d.data=s.chave OR d."initialData"=s.chave)
      LEFT JOIN public."EnvelopeItem" i ON i."documentDataId"=d.id
      LEFT JOIN public."Envelope" e ON e.id=i."envelopeId"
  )
  SELECT r.chave, array_agg(DISTINCT r.env ORDER BY r.env), max(r.em) FROM refs r
    GROUP BY r.chave
    HAVING bool_and(r.purgeable)
      AND NOT EXISTS(SELECT 1 FROM semog_bridge.storage_purges p
        WHERE p.chave=r.chave AND p.estado='purgada' AND p."concluidaEm">=max(r.em));
$$;
-- Registers the intent BEFORE any removal. Re-validates in the database under a per-key lock and the lock of every
-- envelope pointing at the key. A key already pending returns that row (resume), re-judged by ITS own terms.
CREATE OR REPLACE FUNCTION semog_bridge.storage_purge_begin(p_chave text, p_retention_days integer, p_immediate text,
  p_motivo text, p_quem text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
DECLARE p semog_bridge.storage_purges; c record; mark uuid:=gen_random_uuid(); token uuid;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days<1 THEN RAISE EXCEPTION 'retention must be at least 1 day'; END IF;
  IF p_immediate IS NOT NULL AND NOT (semog_bridge.storage_is_bridge_envelope(p_immediate)
    AND EXISTS(SELECT 1 FROM public."Envelope" WHERE id=p_immediate AND status='CANCELLED')) THEN
    RAISE EXCEPTION 'Envelope % is not a cancelled bridge envelope; immediate purge refused', p_immediate;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('semog_bridge.storage_purge:'||p_chave,0));
  PERFORM 1 FROM public."Envelope" e WHERE e.id IN (SELECT i."envelopeId" FROM public."EnvelopeItem" i
    JOIN public."DocumentData" d ON d.id=i."documentDataId" WHERE d.data=p_chave OR d."initialData"=p_chave)
    ORDER BY e.id FOR UPDATE;
  SELECT * INTO p FROM semog_bridge.storage_purges WHERE chave=p_chave AND estado='pendente';
  IF FOUND THEN
    RETURN to_jsonb(p)||jsonb_build_object('purgavel',EXISTS(SELECT 1 FROM
      semog_bridge.storage_purge_candidates(p."retencaoDias",p."envelopeImediato") k WHERE k.chave=p_chave));
  END IF;
  SELECT * INTO c FROM semog_bridge.storage_purge_candidates(p_retention_days,p_immediate) k WHERE k.chave=p_chave;
  IF NOT FOUND THEN RAISE EXCEPTION 'Key % is not purgeable', p_chave; END IF;
  token:=semog_bridge.storage_purge_arm(mark);
  INSERT INTO semog_bridge.storage_purges(id,chave,sha256,envelopes,motivo,"canceladoEm","retencaoDias","envelopeImediato",quem,estado)
    VALUES(mark,p_chave,substring(p_chave from 11 for 64),c.envelopes,p_motivo,c."canceladoEm",p_retention_days,p_immediate,p_quem,'pendente')
    RETURNING * INTO p;
  PERFORM semog_bridge.storage_purge_disarm(token);
  RETURN to_jsonb(p)||jsonb_build_object('purgavel',true);
END $$;
-- After the object is gone (or was already absent): records it, plus any row that started pointing at the key in
-- between — the truth, even when it is bad news. Idempotent on a finished row.
CREATE OR REPLACE FUNCTION semog_bridge.storage_purge_finish(p_id uuid, p_absent boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
DECLARE p semog_bridge.storage_purges; found_conflicts text[]; token uuid;
BEGIN
  SELECT * INTO p FROM semog_bridge.storage_purges WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'storage purge % not found', p_id; END IF;
  IF p.estado='purgada' THEN RETURN to_jsonb(p); END IF;
  IF p.estado<>'pendente' THEN RAISE EXCEPTION 'storage purge % is %', p_id, p.estado; END IF;
  SELECT COALESCE(array_agg(d.id ORDER BY d.id),'{}') INTO found_conflicts FROM public."DocumentData" d
    WHERE d.type='S3_PATH' AND (d.data=p.chave OR d."initialData"=p.chave)
      AND NOT semog_bridge.storage_purgeable_context(d.id,p."retencaoDias",p."envelopeImediato");
  token:=semog_bridge.storage_purge_arm(p_id);
  UPDATE semog_bridge.storage_purges SET estado='purgada', "concluidaEm"=clock_timestamp(), "objetoAusente"=p_absent,
    conflitos=found_conflicts WHERE id=p_id RETURNING * INTO p;
  PERFORM semog_bridge.storage_purge_disarm(token);
  RETURN to_jsonb(p);
END $$;
-- The object was NOT removed (recent upload, key no longer purgeable): the intent is closed with the reason.
CREATE OR REPLACE FUNCTION semog_bridge.storage_purge_abandon(p_id uuid, p_observacao text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
DECLARE p semog_bridge.storage_purges; token uuid;
BEGIN
  SELECT * INTO p FROM semog_bridge.storage_purges WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'storage purge % not found', p_id; END IF;
  IF p.estado='desistida' THEN RETURN to_jsonb(p); END IF;
  IF p.estado<>'pendente' THEN RAISE EXCEPTION 'storage purge % is %', p_id, p.estado; END IF;
  token:=semog_bridge.storage_purge_arm(p_id);
  UPDATE semog_bridge.storage_purges SET estado='desistida', "concluidaEm"=clock_timestamp(), observacao=p_observacao
    WHERE id=p_id RETURNING * INTO p;
  PERFORM semog_bridge.storage_purge_disarm(token);
  RETURN to_jsonb(p);
END $$;

-- Default privileges grant EXECUTE (and table rights) to named roles; revoking from PUBLIC alone would leave them.
REVOKE ALL ON FUNCTION semog_bridge.storage_cancelled_owner(text),semog_bridge.storage_migration_eligible(text),
  semog_bridge.migrate_document_data_to_s3(text,text,text),semog_bridge.storage_purges_guard(),
  semog_bridge.storage_purgeable_context(text,integer,text),semog_bridge.storage_purge_candidates(integer,text),
  semog_bridge.storage_purge_begin(text,integer,text,text,text),semog_bridge.storage_purge_finish(uuid,boolean),
  semog_bridge.storage_purge_abandon(uuid,text),semog_bridge.storage_purge_arm(uuid),
  semog_bridge.storage_purge_disarm(uuid) FROM PUBLIC;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname<>current_user AND rolname NOT LIKE 'pg\_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION semog_bridge.storage_cancelled_owner(text),'
      'semog_bridge.storage_migration_eligible(text),semog_bridge.migrate_document_data_to_s3(text,text,text),'
      'semog_bridge.storage_purges_guard(),semog_bridge.storage_purgeable_context(text,integer,text),'
      'semog_bridge.storage_purge_candidates(integer,text),semog_bridge.storage_purge_begin(text,integer,text,text,text),'
      'semog_bridge.storage_purge_finish(uuid,boolean),semog_bridge.storage_purge_abandon(uuid,text),'
      'semog_bridge.storage_purge_arm(uuid),semog_bridge.storage_purge_disarm(uuid) FROM %I',r.rolname);
    EXECUTE format('REVOKE ALL ON semog_bridge.storage_purges, semog_bridge.storage_purge_tokens FROM %I',r.rolname);
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
    -- Old AND new id: an id change cascades to EnvelopeItem after this BEFORE trigger, so the new id alone is unlinked.
    SELECT i."envelopeId" INTO env FROM public."EnvelopeItem" i JOIN semog_bridge.snapshots s ON s."envelopeId"=i."envelopeId" AND s."revogadaEm" IS NULL
      WHERE i."documentDataId" IN (before->>'id',after->>'id') LIMIT 1;
    -- A cancelled bridge envelope has no live snapshot left to arm the guard, but its PDF row stays as it is: only
    -- the token-bound storage migration may change it, and nothing may delete it.
    IF env IS NULL THEN
      env:=COALESCE(semog_bridge.storage_cancelled_owner(before->>'id'),semog_bridge.storage_cancelled_owner(after->>'id'));
      IF env IS NOT NULL THEN
        PERFORM 1 FROM public."Envelope" WHERE id=env FOR UPDATE;
        IF TG_OP='UPDATE' AND semog_bridge.storage_migration_allows(before,after) THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'Semog cancelled envelope keeps its PDF row; only the storage migration may change it';
      END IF;
    END IF;
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
