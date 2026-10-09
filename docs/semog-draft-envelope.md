# Rascunho de envelope pela ponte Semog

`createSemogDraftRuntime({enabled:true,client,maximumPdfBytes?})` cria handler e serviço isolados. Não monta rota nem lê `.env`. O host futuro poderá encaminhar exclusivamente POST `/api/semog/v1/envelopes-rascunho` ao handler, com o mesmo Bearer de API token nativo/equipe usado na ponte de assinatura. A ativação não faz parte desta implementação.

Contrato JSON versionado no arquivo `draft-contract.ts`: `operacaoId` e `externalId` UUID, `versao` inteira positiva da versão de negócio, `ordemAssinatura` explícita (`paralela`/`sequencial`), título, PDF Base64 canônico/hash SHA256/nome e lista de signatários identificados por UUID. Cada signatário contém nome/e-mail, cargo opcional, ordem e papel nativo. Cada campo tem UUID estável, TEXT/SIGNATURE, papel CPF/observação/assinatura, página e geometria percentual e obrigatoriedade.

`versao` não é `internalVersion`: todos os rascunhos são envelopes Documenso v2 SES, de um item. A versão de negócio e cargo entram no hash durável da requisição; a Semog deve conservar seu payload original, pois não são colunas nativas. Os cinco papéis nativos são SIGNER, APPROVER, VIEWER, CC e ASSISTANT; os cargos da Semog são outra dimensão. CC/VIEWER não recebem campos. ASSISTANT só admite TEXT em ordem sequencial. SIGNER exige assinatura obrigatória. APPROVER pode não ter campos. Criar estes papéis não amplia o executor de assinatura existente, que hoje aceita SIGNER; outras manifestações dependem de implementação própria futura.

Retorno mínimo: operação, envelope, status histórico DRAFT, item/hash e correspondências UUID→recipientId/fieldId. Nunca token, URL pública, caminho de storage ou PDF. Replay retorna o recibo original mesmo se o envelope tiver evoluído: o retorno prova criação de rascunho, não seu estado atual. O consumidor deve consultar o estado real antes de qualquer envio posterior.

Criação, contador nativo, DocumentData inline BYTES_64, DocumentMeta, EnvelopeItem, destinatários, campos, evento local DOCUMENT_CREATED e recibo entram numa única transação. Stock `createEnvelope` não é chamado: possui Prisma global/limites e dispara webhook DOCUMENT_CREATED; a ponte reutiliza utilitários nativos de ID, fieldMeta, secondaryId e auditoria e mantém tx injetada. Não distribui, não agenda jobs/outbox, não dispara webhook e não envia SMTP/WhatsApp. Configuração é NONE/pt-BR/horário São Paulo. Todo sendStatus permanece NOT_SENT; CC é SIGNED por seu contrato nativo, sem representar assinatura humana.

O recibo usa chave UUID global, unique(equipe,externalId), hash canônico que inclui PDF/versão/ordem/campos e vínculo ao proprietário da API. Advisory locks transacionais serializam chave e correlação; READ COMMITTED permite ao concorrente ler o recibo confirmado. Mesma chave/pedido retorna IDs idênticos; chave divergente para mesmo externalId, conteúdo/equipe/proprietário divergente recebem 409. Falha reverte também documento, campos e contador. Sem replay automático de efeitos externos.

Default PDF 100 MiB, configurável para baixo e nunca acima de 100 MiB. HTTP limita chunks e Content-Length a `4*ceil(maximumPdfBytes/3)+512 KiB` (Base64 mais metadados). Header não é a única defesa. PDF é aberto pelo parser instalado @cantoo/pdf-lib, sem normalizar bytes; conferimos hash, canonical Base64, página real e overflow geométrico. Arquivos criptografados/inválidos são recusados. Base64/JSON e o parser demandam várias cópias em memória: o host deve limitar concorrência, timeout, rate limit e dimensionar memória, ou reduzir `maximumPdfBytes`. A ponte de assinatura anterior ainda limita PDFs a 50 MiB; documentos maiores exigem alinhamento antes de ativar envio.

Migração local pareada: `db/2026-10-07-semog-draft.sql` e `.down.sql`, após as migrações da ponte. Nenhum modelo Prisma/dependência foi alterado. Usa a conexão Prisma privilegiada já injetada; PUBLIC não recebe acesso ao recibo e não há SECURITY DEFINER novo. Down recusa execução se existir recibo, preservando idempotência; antes de uso, up/down/up é reversível. Não aplicada em ambiente remoto.

Verificação local, sem credenciais externas ou instalação/regeneração de dependências:

```powershell
pnpm dlx node@24 node_modules/vitest/vitest.mjs run -c packages/lib/vitest.config.ts packages/lib/server-only/semog-signing --configLoader runner --cache=false
pnpm dlx node@24 node_modules/typescript/bin/tsc --noEmit -p tsconfig.semog-signing.json
pnpm dlx node@24 node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-draft-local.ts
```

O último comando inicia e remove PostgreSQL 16 descartável em loopback, gera apenas SQL pelo `prisma migrate diff`, aplica pares locais e testa Prisma real/HTTP/API token, concorrência, replay, conflito, isolamento, rollback injetado, ausência de distribuição/outbox e PDF válido maior que 15 MiB. Não requer `.env`, não regenera client, não instala dependências e não envia documentos a terceiros.
