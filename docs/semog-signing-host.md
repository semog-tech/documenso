# Host privado e selagem autônoma

O roteador real `apps/remix/server/router.ts` registra `/api/semog/v1/*` por meio
de `mountSemogSigningRoutes`, com limitador distribuído específico da ponte. O
contador usa SHA256 do token API nativo validado; credenciais inválidas compartilham
um contador. Cabeçalhos de IP encaminhado não compõem a chave. Falha de banco
devolve 503, impedindo a execução da rota. Sem opt-in, o
host devolve 404 e não lê o corpo. As factories verificam token API nativo,
expiração, proprietário desabilitado e equipe antes de ler o JSON.

Rotas: `envelopes-rascunho`, `envelopes-ativacao`, `inscricoes`,
`manifestacoes`, `manifestacoes-visuais`, `manifestacoes/:chaveOperacao` e
`manifestacoes/:chaveOperacao/pdf`. Os contratos existentes não mudaram.

Para habilitar depois de revisão e aplicação autorizada das migrações:

- Criar o papel restrito com o par `2026-10-08-semog-service-role` antes dos
  demais pares. Ele não concede membership e recusa substituir um papel alheio.
- Aplicar os pares `semog-signing`, `semog-signing-execution`, `semog-draft`,
  `semog-activation` e, por último, `2026-10-07-semog-host.sql`.
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
```

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
