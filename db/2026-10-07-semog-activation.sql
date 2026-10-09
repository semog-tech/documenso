BEGIN;
ALTER TABLE semog_bridge.draft_receipts ADD COLUMN estrutura jsonb;
ALTER TABLE semog_bridge.draft_receipts ADD CONSTRAINT draft_structure_object CHECK (estrutura IS NULL OR jsonb_typeof(estrutura)='object');
CREATE TABLE semog_bridge.activation_receipts (
  "operacaoId" uuid PRIMARY KEY,
  "rascunhoOperacaoId" uuid NOT NULL UNIQUE REFERENCES semog_bridge.draft_receipts("operacaoId") ON DELETE RESTRICT,
  "envelopeId" text NOT NULL UNIQUE REFERENCES public."Envelope"(id) ON DELETE RESTRICT,
  "teamId" integer NOT NULL REFERENCES public."Team"(id) ON DELETE RESTRICT,
  "userId" integer NOT NULL REFERENCES public."User"(id) ON DELETE RESTRICT,
  hash text NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
  resultado jsonb NOT NULL CHECK (jsonb_typeof(resultado)='object'),
  "criadoEm" timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON semog_bridge.activation_receipts FROM PUBLIC;
ALTER TABLE semog_bridge.activation_receipts ENABLE ROW LEVEL SECURITY;
COMMIT;
