# Ponte Semog: implementação local isolada

A ponte implementa inscrição de snapshot, assinatura tipográfica ou visual e recusa em envelopes SES v2 com um PDF, campos próprios TEXT/SIGNATURE e autenticação sem fatores nativos adicionais. Nenhuma rota está montada e nenhum worker é iniciado automaticamente. Todas as factories exigem `enabled:true`; ausência de certificado ou adapter de envio falha explicitamente.

`createSemogSigningRuntime` compõe Prisma real, autenticação de API token SHA512 vinculada à equipe, reader de PDF inline/S3 explicitamente injetado, repository, serviço, HTTP, executor, sealer e outbox. O host deve impor sua política de acesso/rate limit e fornecer fontes/certificado/transporte. Não há leitura de arquivo env ou credencial global pela ponte.

## HTTP do adapter isolado

Bearer é validado antes de ler o corpo. Respostas usam no-store e erros sanitizados.

- POST `/api/semog/v1/inscricoes`: `{envelopeId,recipientId,consentimento,expiraEm}`; devolve IDs, hashes e expiração, sem conteúdo privado/token.
- POST `/api/semog/v1/manifestacoes`: DTO existente de assinar/recusar, limite streaming 64 KiB.
- POST `/api/semog/v1/manifestacoes-visuais`: mesmo DTO, `assinaturaVisual:{fieldId,pngBase64,hash,metodo:'desenhar'|'upload'}`, limite streaming 8 MiB. `pngBase64` não contém DATA URL, `hash` é SHA256 dos bytes normalizados. Campos contém apenas os valores textuais; o mesmo fieldId não pode aparecer no visual e nos campos. Recusa proíbe visual. PNG real/canonical Base64/hash são conferidos, máximo 5 MiB decoded e 20M pixels, método precisa estar habilitado no snapshot. O motor grava Signature.image como DATA URL nativa e typedSignature=null.
- GET `/api/semog/v1/manifestacoes/{uuid}`: estado durável da ação. Destinatário concluído não implica envelope/PDF concluído.
- GET `/api/semog/v1/manifestacoes/{uuid}/pdf`: PDF assinado da operação/equipe, só depois da selagem, com `X-Documento-SHA256` dos bytes entregues. Não expõe storage key ou URL pública.

## Garantias transacionais

Executor bloqueia envelope, operação e snapshot em ordem consistente, relê initialData/PDF dentro da transação, compara snapshot estrutural/consentimento/hashDocumento, ownership dos campos e hashes do pedido durável. Field, Signature, Recipient, auditorias, recibo e outbox entram na mesma transação Serializable. Falha reverte tudo; apenas a intenção previamente reservada permanece pendente para retry. Conflitos Serializable/deadlock recebem até três tentativas. Mesma chave/pedido reproduz o resultado; outra ação/hash/chave não substitui a intenção.

Recibo associa actor, equipe, snapshot, hashSnapshot, PDF e IDs de auditorias nativas. A função de finalização exige recibo e auditoria do destinatário, não apenas seu estado SIGNED/REJECTED. Snapshot revogado/expirado bloqueia nova execução; replay já concluído preserva prova histórica.

Guardas PostgreSQL bloqueiam edição, mudança de contato/autenticação/geometria/PDF, cancelamento e assinatura por rota nativa dos destinatários inscritos. Para editar/cancelar é necessário revogar o snapshot pelo caminho administrativo autorizado. Progresso legítimo de destinatário paralelo sem inscrição continua permitido. Guardas usam a identidade anterior de linhas, impedindo transferências para fugir do envelope protegido. Selagem pode trocar DocumentData mantendo initialData, gerar QR token e concluir envelope somente quando todos os participantes necessários assinaram ou houve recusa e existe intenção de selagem. Não suporta resealing de envelopes já concluídos.

Sealer usa renderer v2 nativo, rotação, fontes reais e @libpdf/core com Signer explicitamente injetado. Antes da assinatura CMS, acrescenta certificado e páginas de auditoria com os renderers nativos `renderCertificate`/`renderAuditLogs`, usando destinatários, assinaturas, proprietário, claim e eventos reais da mesma transação. Não fabrica eventos de envio/abertura ausentes. Recusa recebe carimbo equivalente ao nativo com Noto Sans fornecida pelo host, sem fetch localhost. PDF novo, estado final, auditoria, recibo com documentDataId/hashPdf e intenção de webhook são atômicos. Falha criptográfica reverte também o evento real de conclusão. Consulta/download conferem recibo de selagem e hash do PDF final, além da relação com o PDF original; status nativo sozinho não libera arquivo.

O host deve fornecer `getDocumentI18n(language):Promise<I18n>` ao runtime/sealer. `createSemogDocumentI18n(loadMessages)` cria uma instância Lingui isolada por documento a partir do catálogo nativo compilado fornecido pelo host; ausência ou idioma incompatível bloqueia a selagem. O renderer nativo requer `public/fonts` e `public/static/logo.png` no diretório de execução da aplicação Remix, além do transform Lingui já presente no build nativo. O ensaio compila o catálogo PO instalado em memória, sem modificar traduções nem dependências. Canal WhatsApp comprovado no ledger é identificado como WhatsApp no certificado; não recebe o rótulo de autenticação por e-mail.

## Outbox e integrações pendentes no host

Outbox usa lease exclusiva, SKIP LOCKED, prazo, até oito tentativas e ACK vinculado ao lease. Erro de entrega é explícito e retorna a intenção para retry. IDs duráveis acompanham jobs/webhooks; entrega é at-least-once. O provider deve deduplicar esses IDs (provider local nativo não oferece essa garantia). Schemas nativos instalados validam os payloads antes do adapter.

Adapters reais de WhatsApp/e-mail/webhook, certificado de produção, rate limit e montagem HTTP não foram ativados. Os jobs de e-mail nativos são intenções: o host precisa aplicar templates e links Semog para preservar a experiência própria. TSA/LTV e S3 exigem configuração/verificação adicional do ambiente; o certificado visual e as páginas de auditoria já estão implementados e testados na composição nativa. A disponibilidade do PDF depende do recibo gerado pelo sealer da ponte; um job nativo externo sozinho não fabrica esse recibo.

Migrações são pares locais `db/2026-10-06-semog-signing*.sql`. Down da execução funciona antes de ações reais; depois de conclusão ele falha atomicamente para não transformar prova executada em mera reserva. Nenhuma migração foi aplicada em banco remoto.

## Verificação reproduzível

Node 24 e dependências v2.18 existentes, sem install/client regeneration:

```powershell
pnpm dlx node@24 node_modules/vitest/vitest.mjs run -c packages/lib/vitest.config.ts packages/lib/server-only/semog-signing --configLoader runner --cache=false
pnpm dlx node@24 node_modules/typescript/bin/tsc --noEmit -p tsconfig.semog-signing.json
pnpm dlx node@24 node_modules/@biomejs/biome/bin/biome check packages/lib/server-only/semog-signing scripts/semog-signing-execution-local.ts tsconfig.semog-signing.json
pnpm dlx node@24 node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-execution-local.ts
```

O último comando cria PostgreSQL 16 descartável em porta loopback aleatória, gera o catálogo inteiro pelo Prisma migrate diff, aplica up/down/up, usa Prisma real, certificado efêmero gerado pelo OpenSSL do Git e remove container/temporários. Prova assinatura tipográfica e visual, parecer TEXT exato, recusa/carimbo, rollback após gravação de campos, concorrência/replay, isolamento, guardas, selagem, API token nativo/download e CMS detached verificado criptograficamente por OpenSSL. Outbox usa adapters explicitamente em memória; nenhuma mensagem externa é enviada. A junction de dependências aponta para a cópia v2.18 instalada; imports das definições de jobs usam o namespace nativo para evitar carregar duas cópias de classes privadas.
