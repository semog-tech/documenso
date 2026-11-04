# Aviso de fim da selagem ao semogapp

Decisão de Leandro em 04/11/2026. Fork `semog-tech/documenso`, branch
`leandrosemog/documenso-aviso-fim-selagem`, criada de
`leandrosemog/documenso-2.18` no commit `c644774b` (PR #12).
Referências: [host privado](../semog-signing-host.md),
[investigação da selagem](2026-11-04-selagem-producao.md) e
[PDF sem releitura](2026-11-04-pdf-sem-releitura.md).

## Motivação e contrato

No quarto teste, às 20:11 UTC de 04/11/2026, o semogapp só percebeu o fim da
selagem na tentativa seguinte do worker de conclusão, cerca de 3,9 segundos
depois de `seal.delivery`. Esse achado foi fornecido pelo solicitante; este
trabalho não acessa produção nem repete a medição operacional.

Depois do commit e do sucesso de `seal.confirm`, apenas para envelope
`COMPLETED`, o host dispara em melhor esforço:

```http
POST {SEMOG_SELAGEM_AVISO_URL}
Authorization: Bearer {SEMOG_SELAGEM_AVISO_TOKEN}
Content-Type: application/json
```

```json
{"envelopeId":"envelope_...","completedAt":"2026-11-04T20:11:00.000Z"}
```

O instante é o `completedAt` persistido do envelope, em ISO-8601. Não há aviso
para `REJECTED`, cancelamento ou selo parcial. O receptor do semogapp é
implementado em outro worktree. O aviso apenas antecipa a percepção da conclusão;
o polling existente continua sendo a recuperação quando ele não chega.

Cada tentativa tem prazo de 1,5 segundo. Falha de rede, timeout ou resposta 5xx
permitem uma única nova tentativa. Resposta 4xx não causa retry. O envio ocorre
fora da transação e sem aguardar a resposta: a selagem, a confirmação remota,
o ack e o próximo efeito do outbox não dependem do receptor.

Há no máximo dois avisos ativos por instância do host no processo, incluindo
suas novas tentativas. Ao atingir o limite, novos avisos são descartados com
status `skipped-busy`, sem fila em memória. Redirecionamentos HTTP não são
seguidos. O estágio `seal.notify` mede o envio, incluindo eventual retry;
o log específico contém somente `envelopeId`, `status` e `ms`, sem URL,
segredo, corpo de resposta ou erro de transporte. Falhas da telemetria também
não alteram o resultado da selagem.

Não há nova tabela, migração, efeito durável ou mudança dos retries da selagem.
O aviso pode ser perdido em indisponibilidade, saturação ou encerramento do
processo e pode se repetir em replay. O receptor deve tolerar repetição.

## Configuração de produção para o Claude

Adicionar ao serviço Documenso no compose operacional:

```yaml
services:
  documenso:
    environment:
      SEMOG_SELAGEM_AVISO_URL: "${SEMOG_SELAGEM_AVISO_URL}"
      SEMOG_SELAGEM_AVISO_TOKEN: "${SEMOG_SELAGEM_AVISO_TOKEN}"
```

O Claude configura a URL definitiva do receptor e um segredo exclusivo,
compartilhado com o semogapp, somente no runtime. Não incluir valor real em
commit, imagem, relatório ou log. Sem uma das duas envs, o aviso fica desligado
e o comportamento anterior é preservado. Para desligar, remover uma delas.
Não depende de `SEMOG_SIGNING_DELIVERY_ENABLED`: o transporte geral de e-mails
e webhooks continua com suas guardas atuais.

## Validação e publicação

Validação local em macOS ARM64, Node 24.21.0, npm 11.19.0, dependências do
lockfile instaladas por `npm ci` e Prisma gerado com URLs fictícias de loopback,
sem migração nesse passo. Nenhum build nem acesso a produção.

- Biome no escopo da CI: 115 arquivos aprovados.
- TypeScript com `tsconfig.semog-signing.json`: aprovado.
- Vitest da ponte: 39 arquivos, **388 testes aprovados**.
- Patches nativos Node: **33 testes aprovados**.
- Processo HTTP real do host: rotas, limitador, default-off e autenticação
  antes do corpo aprovados.
- Rodadas com PostgreSQL descartável: selos parciais, concorrência, prorrogação,
  contato, cancelamento e mutantes das guardas aprovados; fixture removida
  pelo `finally`.
- Revisão independente: sem bloqueantes de comportamento. A incompatibilidade
  de tipo da fixture de envs ausentes foi corrigida, seguida de TypeScript verde.
- `git diff --check`: aprovado.

Os novos testes usam HTTP real em loopback para contrato JSON/Bearer, sucesso,
timeout de 1,5 s em cada tentativa, desconexão, 5xx seguido de sucesso/falha,
4xx e redirects sem retry, limite de dois envios e liberação dos slots. Sem envs,
não criam notifier, timer ou chamada HTTP. Falhas do logger/observer são isoladas.
Os testes de selagem conferem o instante gravado e replay, ausência de aviso em
`REJECTED` ou quando `seal.confirm` falha, e dois acks com o próximo efeito do
outbox entregue enquanto a resposta 503 do aviso ainda está pendente.

Uma primeira execução completa encontrou uma premissa incorreta no teste:
intervalo entre chegadas ao servidor não mede o timeout que começa antes do
`fetch`. O teste passou a medir o aborto dos sinais de cada transporte real;
o prazo de produção permaneceu 1500 ms. A execução completa seguinte passou.

Limite do ambiente: o ensaio adicional `semog-signing-host-cms-local.ts` não
pôde executar por depender de Docker, indisponível (`spawn docker ENOENT`).
Isso não substitui uma validação integrada no semogapp nem prova redução dos
3,9 segundos em produção. O script removeu seu arquivo gerado; as rodadas
PostgreSQL locais foram executadas separadamente com sucesso.

```sh
node node_modules/@biomejs/biome/bin/biome check packages/lib/server-only/semog-signing apps/remix/server/semog-signing-host.ts apps/remix/server/semog-signing-routes.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.semog-signing.json
node node_modules/vitest/vitest.mjs run --config packages/lib/vitest.config.ts --maxWorkers=2 packages/lib/server-only/semog-signing
node --test apps/remix/app/utils/semog-recipient.test.mjs apps/remix/app/utils/recipient-remark.test.mjs apps/remix/app/utils/remark-page.test.mjs packages/lib/client-only/hooks/load-signature-font.test.mjs
node node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-host-local.ts
SEMOG_PG_BIN=/opt/homebrew/bin SEMOG_OPENSSL_BIN=/opt/homebrew/bin/openssl node node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-rounds-local.ts
```

**Aviso antes do merge:** abrir PR não autoriza merge. O Claude valida o PR e
repassa a autorização de Leandro antes de qualquer merge. O merge na release
dispara a publicação da imagem pela CI; deploy e configuração do segredo cabem
ao Claude depois da autorização. Este trabalho não faz merge nem deploy.
