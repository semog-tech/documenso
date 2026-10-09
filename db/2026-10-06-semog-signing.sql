BEGIN;
CREATE SCHEMA semog_bridge;
REVOKE ALL ON SCHEMA semog_bridge FROM PUBLIC;

CREATE TABLE semog_bridge.snapshots (
  id uuid PRIMARY KEY,
  "teamId" integer NOT NULL,
  "envelopeId" text NOT NULL REFERENCES public."Envelope"(id) ON DELETE RESTRICT,
  "recipientId" integer NOT NULL REFERENCES public."Recipient"(id) ON DELETE RESTRICT,
  "hashDocumento" text NOT NULL CHECK ("hashDocumento" ~ '^[a-f0-9]{64}$'),
  "hashConsentimento" text NOT NULL CHECK ("hashConsentimento" ~ '^[a-f0-9]{64}$'),
  "hashSnapshot" text NOT NULL CHECK ("hashSnapshot" ~ '^[a-f0-9]{64}$'),
  "expiraEm" timestamptz NOT NULL,
  conteudo jsonb NOT NULL CHECK (jsonb_typeof(conteudo) = 'object'),
  "revogadaEm" timestamptz,
  "criadaEm" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX snapshots_active_recipient ON semog_bridge.snapshots("envelopeId", "recipientId") WHERE "revogadaEm" IS NULL;
CREATE TABLE semog_bridge.operations (
  "chaveOperacao" uuid PRIMARY KEY,
  "snapshotId" uuid NOT NULL UNIQUE REFERENCES semog_bridge.snapshots(id) ON DELETE RESTRICT,
  "teamId" integer NOT NULL,
  "envelopeId" text NOT NULL,
  "recipientId" integer NOT NULL,
  "hashDocumento" text NOT NULL CHECK ("hashDocumento" ~ '^[a-f0-9]{64}$'),
  "hashConsentimento" text NOT NULL CHECK ("hashConsentimento" ~ '^[a-f0-9]{64}$'),
  acao text NOT NULL CHECK (acao IN ('assinar', 'recusar')),
  "hashPedido" text NOT NULL CHECK ("hashPedido" ~ '^[a-f0-9]{64}$'),
  pedido jsonb NOT NULL CHECK (jsonb_typeof(pedido) = 'object'),
  evidencias jsonb NOT NULL CHECK (jsonb_typeof(evidencias) = 'object'),
  "criadaEm" timestamptz NOT NULL DEFAULT clock_timestamp(),
  estado text NOT NULL DEFAULT 'pendente' CHECK (estado = 'pendente'),
  UNIQUE("envelopeId", "recipientId")
);
ALTER TABLE semog_bridge.snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE semog_bridge.operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA semog_bridge FROM PUBLIC, semog_bridge_service;

CREATE FUNCTION public.semog_signing_register_snapshot(p_snapshot jsonb) RETURNS jsonb
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

CREATE FUNCTION public.semog_signing_get_snapshot(p_team_id integer,p_envelope_id text,p_recipient_id integer) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, semog_bridge AS $$
  SELECT to_jsonb(s) - 'revogadaEm' - 'criadaEm' FROM semog_bridge.snapshots s
  WHERE s."teamId" = p_team_id AND s."envelopeId" = p_envelope_id AND s."recipientId" = p_recipient_id AND s."revogadaEm" IS NULL;
$$;
CREATE FUNCTION public.semog_signing_revoke_snapshot(p_team_id integer,p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, semog_bridge AS $$
BEGIN
  UPDATE semog_bridge.snapshots SET "revogadaEm" = COALESCE("revogadaEm",clock_timestamp()) WHERE id = p_id AND "teamId" = p_team_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'snapshot unavailable'; END IF;
  RETURN true;
END $$;

CREATE FUNCTION public.semog_signing_reserve_operation(p_operation jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, semog_bridge AS $$
DECLARE s semog_bridge.snapshots; o semog_bridge.operations; old semog_bridge.operations;
BEGIN
  o := jsonb_populate_record(NULL::semog_bridge.operations,p_operation);
  SELECT * INTO s FROM semog_bridge.snapshots WHERE id = o."snapshotId" AND "teamId" = o."teamId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'snapshot unavailable'; END IF;
  SELECT * INTO old FROM semog_bridge.operations WHERE "chaveOperacao" = o."chaveOperacao";
  IF FOUND THEN
    IF (to_jsonb(old) - 'criadaEm' - 'estado') IS DISTINCT FROM
      jsonb_build_object('chaveOperacao',o."chaveOperacao",'snapshotId',o."snapshotId",'teamId',o."teamId",'envelopeId',o."envelopeId",'recipientId',o."recipientId",'hashDocumento',o."hashDocumento",'hashConsentimento',o."hashConsentimento",'acao',o.acao,'hashPedido',o."hashPedido",'pedido',o.pedido,'evidencias',o.evidencias) THEN
      RAISE EXCEPTION 'operation conflict';
    END IF;
    RETURN to_jsonb(old);
  END IF;
  IF s."revogadaEm" IS NOT NULL OR s."expiraEm" <= clock_timestamp() THEN RAISE EXCEPTION 'snapshot inactive'; END IF;
  IF s."envelopeId" IS DISTINCT FROM o."envelopeId" OR s."recipientId" IS DISTINCT FROM o."recipientId"
    OR s."hashDocumento" IS DISTINCT FROM o."hashDocumento" OR s."hashConsentimento" IS DISTINCT FROM o."hashConsentimento" THEN
    RAISE EXCEPTION 'operation binding mismatch';
  END IF;
  INSERT INTO semog_bridge.operations("chaveOperacao","snapshotId","teamId","envelopeId","recipientId","hashDocumento","hashConsentimento",acao,"hashPedido",pedido,evidencias)
  VALUES(o."chaveOperacao",o."snapshotId",o."teamId",o."envelopeId",o."recipientId",o."hashDocumento",o."hashConsentimento",o.acao,o."hashPedido",o.pedido,o.evidencias)
  RETURNING * INTO o;
  RETURN to_jsonb(o);
END $$;
CREATE FUNCTION public.semog_signing_get_operation(p_team_id integer,p_key uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, semog_bridge AS $$
  SELECT to_jsonb(o) FROM semog_bridge.operations o WHERE o."teamId" = p_team_id AND o."chaveOperacao" = p_key;
$$;

REVOKE ALL ON FUNCTION public.semog_signing_register_snapshot(jsonb), public.semog_signing_get_snapshot(integer,text,integer), public.semog_signing_revoke_snapshot(integer,uuid), public.semog_signing_reserve_operation(jsonb), public.semog_signing_get_operation(integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.semog_signing_register_snapshot(jsonb), public.semog_signing_get_snapshot(integer,text,integer), public.semog_signing_revoke_snapshot(integer,uuid), public.semog_signing_reserve_operation(jsonb), public.semog_signing_get_operation(integer,uuid) TO semog_bridge_service;
COMMIT;
