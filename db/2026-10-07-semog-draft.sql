BEGIN;
CREATE TABLE semog_bridge.draft_receipts (
  "operacaoId" uuid PRIMARY KEY,
  "externalId" uuid NOT NULL,
  "teamId" integer NOT NULL REFERENCES public."Team"(id) ON DELETE RESTRICT,
  "userId" integer NOT NULL REFERENCES public."User"(id) ON DELETE RESTRICT,
  hash text NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
  "envelopeId" text NOT NULL UNIQUE REFERENCES public."Envelope"(id) ON DELETE RESTRICT,
  resultado jsonb NOT NULL CHECK (jsonb_typeof(resultado)='object'),
  "criadoEm" timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("teamId", "externalId")
);
REVOKE ALL ON semog_bridge.draft_receipts FROM PUBLIC;
ALTER TABLE semog_bridge.draft_receipts ENABLE ROW LEVEL SECURITY;
-- The bridge uses its existing explicitly injected privileged Prisma connection.
-- No grant to anonymous roles, no SECURITY DEFINER function and no regeneration of Prisma models.
COMMIT;
