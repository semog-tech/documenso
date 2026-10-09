BEGIN;
DROP TRIGGER IF EXISTS semog_envelope_guard ON public."Envelope";
DROP TRIGGER IF EXISTS semog_recipient_guard ON public."Recipient";
DROP TRIGGER IF EXISTS semog_field_guard ON public."Field";
DROP TRIGGER IF EXISTS semog_signature_guard ON public."Signature";
DROP TRIGGER IF EXISTS semog_meta_guard ON public."DocumentMeta";
DROP TRIGGER IF EXISTS semog_item_guard ON public."EnvelopeItem";
DROP TRIGGER IF EXISTS semog_data_guard ON public."DocumentData";
DROP TRIGGER IF EXISTS semog_attachment_guard ON public."EnvelopeAttachment";
DROP FUNCTION IF EXISTS public.semog_signing_finish_operation(integer,uuid,jsonb);
DROP FUNCTION IF EXISTS public.semog_signing_claim_effect(integer);
DROP FUNCTION IF EXISTS public.semog_signing_ack_effect(text,uuid,boolean);
DROP FUNCTION IF EXISTS semog_bridge.guard_native_mutation();
DROP FUNCTION IF EXISTS semog_bridge.ready_to_seal(text);
DROP TABLE IF EXISTS semog_bridge.outbox;
ALTER TABLE semog_bridge.operations DROP COLUMN resultado;
ALTER TABLE semog_bridge.operations DROP COLUMN execucao;
ALTER TABLE semog_bridge.operations DROP CONSTRAINT operations_estado_check;
-- Downgrading after real execution requires exporting evidence and restoring native state first.
-- Deliberately fail rather than relabel committed signatures as pending.
ALTER TABLE semog_bridge.operations ADD CONSTRAINT operations_estado_check CHECK (estado = 'pendente');
COMMIT;
