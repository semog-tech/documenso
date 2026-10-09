BEGIN;
-- Separate RPC preserves compatibility while disabled external effects cannot starve local sealing.
CREATE FUNCTION public.semog_signing_claim_seal_effect(p_seconds integer DEFAULT 120) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,semog_bridge AS $$
DECLARE e semog_bridge.outbox;
BEGIN
 IF p_seconds<90 OR p_seconds>300 THEN RAISE EXCEPTION 'invalid seal lease'; END IF;
 SELECT * INTO e FROM semog_bridge.outbox WHERE kind='seal' AND tentativa<8 AND
 (estado='pendente' OR (estado='leased' AND "leaseAte"<clock_timestamp())) ORDER BY "criadaEm",id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE semog_bridge.outbox SET estado='leased',tentativa=tentativa+1,lease=gen_random_uuid(),"leaseAte"=clock_timestamp()+make_interval(secs=>p_seconds)
 WHERE id=e.id RETURNING * INTO e;
 RETURN to_jsonb(e);
END $$;
REVOKE ALL ON FUNCTION public.semog_signing_claim_seal_effect(integer) FROM PUBLIC;
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname NOT IN(current_user,'semog_bridge_service') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.semog_signing_claim_seal_effect(integer) FROM %I',r.rolname);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.semog_signing_claim_seal_effect(integer) TO semog_bridge_service;
COMMIT;
