# Host privado e selagem autônoma

O roteador real `apps/remix/server/router.ts` registra `/api/semog/v1/*` por meio
de `mountSemogSigningRoutes`, com limitador distribuído específico da ponte. O
contador usa SHA256 do token API nativo validado; credenciais inválidas compartilham
um contador. Cabeçalhos de IP encaminhado não compõem a chave. Falha de banco
devolve 503, impedindo a execução da rota. Sem opt-in, o
host devolve 404 e não lê o corpo. As factories verificam token API nativo,
expiração, proprietário desabilitado e equipe antes de ler o JSON.

Rotas: `envelopes-rascunho`, `envelopes-ativacao`, `inscricoes`,
`manifestacoes`, `manifestacoes-visuais`, `manifestacoes/:chaveOperacao`,
`manifestacoes/:chaveOperacao/pdf`, `envelopes/:envelopeId/selos-parciais` e
`envelopes/:envelopeId/selos-parciais/:rodada/pdf` e `envelopes/:envelopeId/prorrogacoes`.
Os contratos existentes não mudaram.

Selo parcial (`POST …/selos-parciais`, corpo estrito `{ rodada, chaveOperacao }`):
sela o que já foi assinado num envelope `PENDING` ativado pela ponte (v2, SES, um
item, sem `REJECTED`, ao menos um faltante), com o mesmo renderizador, certificado
e CMS detached da selagem final, e o carimbo "SELO PARCIAL · n de N · dd/mm/aaaa"
(dia em America/Recife) em todas as páginas, certificado e auditoria inclusive. No
certificado, quem não assinou aparece sem caixa nem ID de assinatura e com
"Não assinou — selo parcial n de N" no lugar do motivo nativo. Grava um
`DocumentData` novo e uma linha em `semog_bridge.partial_seals`; não altera status,
`completedAt`, destinatários, item do envelope, auditoria nem outbox. Mesma chave e
mesma rodada devolvem o mesmo recibo sem renderizar; chave ou rodada divergente
recebe 409, e todos assinados também (o PDF final pertence à selagem nativa).
A transação usa `Read Committed` + `FOR UPDATE` no envelope, não `Serializable`: o
snapshot serializável começa antes da espera pela trava e perderia uma assinatura
confirmada durante essa espera. Toda mutação nativa ou da ponte trava a mesma
linha (executor e gatilho de guarda), então depois da trava cada leitura vê o
estado atual e estável; uma segunda chamada simultânea da mesma rodada espera e
lê o recibo gravado como replay. O `GET …/pdf` confere a
equipe e o SHA-256 gravado antes de devolver os bytes.

Prorrogação (`POST …/prorrogacoes`, corpo estrito `{ chaveOperacao, recipientIds[],
expiraEm }`): reabre uma rodada para quem não assinou. Mesma trava `Read Committed`
+ `FOR UPDATE`, equipe e envelope ativado pela ponte; exige envelope `PENDING` sem
`REJECTED`, cada destinatário SIGNER, `NOT_SIGNED`, sem operação na ponte, com
`expiresAt` atual e `expiraEm` futuro e maior que ele. Revoga a inscrição ativa
(`revogadaEm`, vencida ou não), grava `Recipient.expiresAt` e um `RECIPIENT_UPDATED`
nativo por destinatário (o vocabulário nativo não tem diff de prazo; o instante fica
no recibo `semog_bridge.extension_receipts`). Mesma chave e corpo devolvem o recibo;
corpo divergente recebe 409. Depois disso `/inscricoes` aceita a nova inscrição com o
prazo novo. Como `expiresAt` de todos entra no snapshot de cada inscrição, a
prorrogação recusa (409) se outro faltante fora do pedido tiver inscrição vigente:
mudar o prazo dele quebraria a assinatura pendente desse outro. O progresso de
outros signatários (status, campos) já fica fora do snapshot em ordem paralela, então
reinscrever depois que outros assinaram é compatível. A migração recria o gatilho de
guarda com um único ramo novo, que só libera a troca de `expiresAt` dentro da
transação que gravou o recibo daquela chave, para aquele destinatário e instante.

Para habilitar depois de revisão e aplicação autorizada das migrações:

- Criar o papel restrito com o par `2026-10-08-semog-service-role` antes dos
  demais pares. Ele não concede membership e recusa substituir um papel alheio.
- Aplicar os pares `semog-signing`, `semog-signing-execution`, `semog-draft`,
  `semog-activation`, `2026-10-07-semog-host.sql` e, por último,
  `2026-10-29-semog-partial-seal.sql` e `2026-10-29-semog-extension.sql`. Sem as
  duas últimas, só as rotas novas respondem 503; cada inverso recusa enquanto existir
  selo parcial ou recibo de prorrogação, e o da prorrogação restaura o gatilho de
  guarda idêntico ao de `2026-10-06-semog-signing-execution.sql`. Como os
  pares irmãos, aplicar com o papel dono das tabelas do Documenso — o mesmo da
  conexão Prisma injetada no host —, para que a tabela pertença a ele (RLS ligada
  sem `FORCE`, nenhum grant a `PUBLIC` ou a `semog_bridge_service`).
- Configurar certificado local explicitamente em
  `NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH` ou `NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS`,
  senha correspondente e transporte `local`. Não há fallback para certificado de exemplo.
- Disponibilizar catálogos Lingui compilados e `public/fonts/noto-sans.ttf` no
  diretório do processo Remix. A inicialização verifica o catálogo português,
  o certificado, a fonte e a existência da migração antes de começar.
- Ativar `SEMOG_SIGNING_ENABLED=true` e `SEMOG_SIGNING_WORKER_ENABLED=true`.
  Os dois valores são `false` por padrão.

O worker consome somente efeitos `seal` enquanto
`SEMOG_SIGNING_DELIVERY_ENABLED=false`. E-mails e webhooks permanecem pendentes,
sem confirmação fictícia, e não bloqueiam a selagem. A ativação da entrega no
host montado é recusada até existir um adaptador de transporte revisado.
`createSemogHost` aceita esse adaptador explicitamente para composição controlada.

O selador nunca dispara `internal.seal-document` no worker antigo. Confere a
operação privada, equipe, envelope, identificador do documento, recibo canônico
da manifestação e então chama `runtime.sealer.seal`. O PDF usa o renderizador
nativo e CMS detached com o certificado injetado. A cadeia não busca AIA pela
rede; o certificado configurado precisa conter a cadeia necessária.

O consumo usa lease de 120 segundos, confirmação após commit e até oito
tentativas duráveis. Falha é reportada no log sem corpo, token ou CPF. O loop não
sobrepõe chamadas. SIGTERM/SIGINT fecham o HTTP e aguardam a chamada em andamento;
há limite de 75 segundos para desligamento. O rollback recusa selagens pendentes,
em lease ou falhadas: parar o processo e reconciliar antes de remover a função.

Ensaios locais sem `.env`, instalação ou alteração de `node_modules`:

```text
node24 node_modules/vitest/vitest.mjs run -c packages/lib/vitest.config.ts packages/lib/server-only/semog-signing
node24 node_modules/typescript/bin/tsc --noEmit -p tsconfig.semog-signing.json
node24 node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-host-local.ts
node24 node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-host-db-local.ts
node24 node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-host-cms-local.ts
SEMOG_PG_BIN=/opt/homebrew/bin node24 node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-rounds-local.ts
```

O último usa binários locais do PostgreSQL (sem Docker), cria e remove um diretório
descartável e cobre selo parcial, concorrência, prorrogação e a selagem final depois
da segunda rodada.

`node24` representa o executável Node 24 efetivamente disponível. O primeiro
script sobe HTTP em loopback com a mesma função de registro do roteador. O segundo
cria e remove PostgreSQL descartável sem porta publicada e testa leases
concorrentes, isolamento dos efeitos externos, ACLs efetivas e rollback.
O ensaio integrado Semog/fork verifica separadamente selagem criptográfica e
retorno do arquivo final pelo ciclo completo.

Prova autônoma executada em 07/10/2026: `semog-signing-host-cms-local.ts` passou
com Node 24.21.0, PostgreSQL 16 descartável, certificado RSA efêmero e HTTP em
loopback. Reaproveita o bootstrap e o verificador CMS do diagnóstico nativo sem
alterá-lo, com conferência de hash e remoção da fixture temporária. A manifestação
POST deixou todos os destinatários nativos SIGNED, envelope PENDING e PDF
indisponível. Somente `createSemogHost.start()` realizou a selagem; nenhuma chamada
manual ao selador ocorre no ensaio. O download autenticado devolveu PDF com hash
correspondente, certificado/auditoria nativos, observação preservada e CMS detached
verificado com OpenSSL. Uma única auditoria de conclusão e confirmação somente do
efeito `seal` foram conferidas; e-mails/webhooks permaneceram pendentes. O polling
tolera indisponibilidade temporária 503 durante a transação de selagem, exigindo
download final 200 e verificação criptográfica para aprovar. Sem autenticação, o
download continua devolvendo 401.

Referências: [Hono no Node](https://hono.dev/docs/getting-started/nodejs) e
[registro de rotas Hono](https://hono.dev/docs/api/hono).

## Imagem da release por Git e CI

O destino desta integração é `leandrosemog/documenso-2.18`, baseado no upstream
`69efad4ec7f168407e65ffe098e52c1f2c980633`. PRs para essa branch executam
`semog-check.yml`: Node 24.21.0, npm 11.19.1, `npm ci`, geração Prisma,
`tsconfig.semog-signing.json`, a suíte Vitest nativa e os testes Node dos patches
de destinatários. A geração usa URLs de fixture e não conecta ou migra banco.

O push na branch de release reutiliza os mesmos checks antes de construir o
Dockerfile real e publicar `ghcr.io/semog-tech/documenso:sha-<commit>` e
`2.18.0-semog`. Dispatch em outra branch não publica. A base Node Alpine está
fixada por digest; scripts shell e SQL usam LF, preservando shebangs e os
checksums das 164 migrações Prisma já publicadas. Não se alteram lockfile ou
migrações Prisma anteriores nesta integração.

Depois do CI, obter o digest efetivamente publicado e fixar a referência
`ghcr.io/semog-tech/documenso@sha256:<digest>` no deploy autorizado. Registrar
commit, digest, imagem anterior e backup do banco para rollback. O CI não faz
deploy, não aplica os seis pares SQL manuais e não habilita flags. O start
upstream continua executando `prisma migrate deploy`; portanto conferir as
migrações pendentes antes de iniciar uma imagem nova no banco operacional.

Certificado, senha, token API nativo, URLs de banco e flags vêm somente da
configuração de runtime. Nenhum certificado, `.env`, chave privada ou segredo
de aplicação é fornecido ao build. `SEMOG_SIGNING_ENABLED`,
`SEMOG_SIGNING_WORKER_ENABLED` e `SEMOG_SIGNING_DELIVERY_ENABLED` permanecem
desligados na ausência de configuração explícita; entrega segue bloqueada
até existir adaptador revisado.
