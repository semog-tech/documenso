-- Selo parcial: PDF selado de um envelope PENDING, sem concluir, recusar ou re-apontar o envelope.
-- Aplicar depois dos pares da ponte (inclusive 2026-10-07-semog-host). Sem modelo Prisma novo.
-- Papel: o dono das tabelas do Documenso, o mesmo da conexão Prisma privilegiada injetada no host
-- (como nos pares irmãos). A tabela pertence a ele; RLS ligada sem FORCE e sem grant a outros papéis.
BEGIN;
CREATE TABLE semog_bridge.partial_seals (
  "chaveOperacao" uuid PRIMARY KEY,
  "teamId" integer NOT NULL REFERENCES public."Team"(id) ON DELETE RESTRICT,
  "envelopeId" text NOT NULL REFERENCES public."Envelope"(id) ON DELETE RESTRICT,
  rodada integer NOT NULL CHECK (rodada BETWEEN 1 AND 1000),
  "documentDataId" text NOT NULL UNIQUE REFERENCES public."DocumentData"(id) ON DELETE RESTRICT,
  "hashPdf" text NOT NULL CHECK ("hashPdf" ~ '^[a-f0-9]{64}$'),
  assinantes jsonb NOT NULL CHECK (jsonb_typeof(assinantes) = 'array' AND jsonb_array_length(assinantes) > 0),
  "criadoEm" timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("envelopeId", rodada)
);
ALTER TABLE semog_bridge.partial_seals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON semog_bridge.partial_seals FROM PUBLIC, semog_bridge_service;
COMMIT;
