# Investigação da latência de selagem em produção

Data: 04/11/2026. Fork `semog-tech/documenso`. Branch de trabalho
`leandrosemog/investigacao-selagem-producao`, criada da produção
`leandrosemog/documenso-2.18`, commit `8e5233cad3147974707d10a859f5df25401e6c91`.
Foram lidos [o contrato do host](../semog-signing-host.md),
[a investigação de leitura única](2026-11-04-ponte-leitura-unica.md) e
[o ensaio do PR #8](2026-11-03-base64-nativo.md).

## Conclusão e limites

A última manifestação produz um efeito durável `seal` em `semog_bridge.outbox`.
O worker privado do host o consome em um ciclo serial de polling, com intervalo
padrão de **1 segundo após terminar cada ciclo**. A selagem não ocorre inline
no POST da manifestação, nem depende de cron, BullMQ ou `BackgroundJob`.
Os dois efeitos examinados foram entregues na **primeira tentativa**.

O banco permite localizar o intervalo da transação de selagem até a atribuição
de `completedAt`: **9,248 s no teste 1 e 6,887 s no teste 2**. Não permite separar
retrospectivamente renderização, normalização, save, CMS, upload ou espera de
lock. Os logs atuais não medem essas etapas; atribuir os 7–9 s à CPU, R2 ou
banco seria especulação. Este PR acrescenta os tempos necessários, sem mudar
selagem, guardas, leases, retries, formato público ou polling.

Os **1,712 s** do PR #8 foram medidos com **Prisma em memória, rede bloqueada e
PDF de 52.371.024 bytes**. Não são medição com Postgres e R2. Os dois PDFs originais
operacionais têm 55.207.556 bytes; o recibo de selagem confirma `S3_PATH` em ambos.
Uma comparação direta entre esses ambientes não isola uma regressão.

## Acesso e método

Produção acessada exclusivamente por `ssh semog`, usando `docker logs`,
`docker stats --no-stream` dos dois contêineres autorizados e `docker exec` do
contêiner PostgreSQL com `psql -U documenso -c 'SELECT ...'`.
Nenhum restart, escrita, assinatura, envelope, migração ou deploy operacional.
Os logs foram filtrados localmente para campos de tempos; as consultas retornaram
somente horários, status, contagens, armazenamento e tamanhos. Não foram coletados
PDFs, e-mails, tokens ou pedidos de manifestação. Os identificadores fornecidos
pelo solicitante foram substituídos por **teste 1** (09h16 UTC) e **teste 2**
(12h53 UTC), sempre em 04/11/2026.

Fontes primárias consultadas: `Envelope` (`status`, `completedAt`, `updatedAt`),
`DocumentAuditLog` (`type`, `createdAt`), `semog_bridge.operations` (estado e
metadados específicos do recibo), `semog_bridge.outbox` (tipo, estado, tentativa,
criação e confirmação), `DocumentData` (tipo e comprimentos) e contagem de
`BackgroundJob` nos intervalos 09:16:15–09:16:40 e 12:53:30–12:53:55 UTC.
Esta contagem deu zero. O banco não preserva o horário de claim depois do ack:
`lease` e `leaseAte` são limpos; não há como recuperar exatamente o início do consumo.

## Linha do tempo dos dois testes

Todos os horários abaixo são UTC. Os logs usam o horário interno do logger;
o prefixo `docker --timestamps` é o recebimento da linha e sofre buffering
(por exemplo, evento 12:53:37,249 recebido pelo Docker às 12:53:38,394).
Não interpretar esse buffering como tempo de execução. Logs de estágio não
carregam correlação por envelope; sua associação aos testes é temporal, não
uma identificação inequívoca se houver concorrência.

| Marco / fonte | Teste 1 | Teste 2 |
| --- | --- | --- |
| Última reserva `operations.criadaEm` | 09:16:20,252956 | 12:53:37,450435 |
| Último `DOCUMENT_FIELD_INSERTED` | 09:16:20,913 | 12:53:38,312 |
| Último `DOCUMENT_RECIPIENT_COMPLETED` | 09:16:20,929 | 12:53:38,320 |
| Efeito `seal.criadaEm` | 09:16:20,947341 | 12:53:38,335098 |
| Fim `execute.transaction` / `manifestation` no log | 09:16:20,958 | 12:53:38,342 |
| Fim de `get.transaction` compatível com conferência do worker | 09:16:21,895 (16 ms) | 12:53:38,825 (14 ms) |
| Auditoria `DOCUMENT_COMPLETED.createdAt` | 09:16:23,233 | 12:53:40,789 |
| `Envelope.completedAt` | 09:16:32,481 | 12:53:47,676 |
| `Envelope.updatedAt` | 09:16:32,483 | 12:53:47,677 |
| Webhook de conclusão suprimido, `outbox.criadaEm` | 09:16:32,594536 | 12:53:48,190881 |
| Efeito `seal.entregueEm`, `delivered`, tentativa 1 | 09:16:34,254756 | 12:53:51,606503 |
| Primeira consulta concluída observada no log (`get.transaction`) | 09:16:37,218 | 12:53:51,745 |

**Precisão dos timestamps:** `DocumentAuditLog.createdAt` usa o default
PostgreSQL `now()`/`CURRENT_TIMESTAMP`: marca o **início da transação**, não o
instante em que a auditoria foi inserida. A auditoria é criada antes do render,
mas sua data não prova que o render começou naquele momento. `completedAt` é
`new Date()` no processo, imediatamente antes da atualização, e **não** o commit.
`updatedAt` também não é um marcador de commit. Comparações de relógios do app
e banco presumem sincronização; o acesso autorizado não mediu o desvio NTP.

| Intervalo calculado | Teste 1 | Teste 2 |
| --- | ---: | ---: |
| Última auditoria nativa de manifestação → `completedAt` | 11,552 s | 9,356 s |
| Criação do efeito → início da transação (proxy pela auditoria) | 2,286 s | 2,454 s |
| Início da transação → atribuição de `completedAt` | 9,248 s | 6,887 s |
| `completedAt` → confirmação do efeito | 1,774 s | 3,931 s |
| Criação do efeito → confirmação do efeito | 13,307 s | 13,271 s |

O segundo horário informado pelo semogapp (12:53:38,420) → `completedAt` resulta
em **9,256 s**. O primeiro horário (~09:16:25) era aproximado e resulta em
~7,481 s; a última manifestação **nativa** foi gravada antes, às 09:16:20,929.
Os timestamps de `assinatura.operacoes` vieram do solicitante; não foi acessado
o Supabase do semogapp. Não se trata de dois cronômetros com o mesmo marco inicial.

## Estágios existentes nos logs

Todos os registros abaixo vieram com `ok=true`; os executores tiveram
`attempts=1`. `reserve.read` e `execute.pdf` registraram 55.207.556 bytes.

| Estágio | Teste 1: fim / ms | Teste 2: fim / ms |
| --- | --- | --- |
| `reserve.read` | 09:16:19,992 / 805 | 12:53:37,249 / 944 |
| `reserve.snapshot` | 09:16:20,238 / 246 | 12:53:37,447 / 198 |
| `execute.pdf` | 09:16:20,859 / 603 | 12:53:38,272 / 817 |
| `execute.transaction` | 09:16:20,958 / 98 | 12:53:38,342 / 69 |
| `manifestation` | 09:16:20,958 / 1.785 | 12:53:38,342 / 2.046 |
| `get.transaction`, antes da selagem | 09:16:21,895 / 16 | 12:53:38,825 / 14 |
| `get.metadata`, concluído | 09:16:37,213 / 20 | 12:53:51,741 / 11 |
| `get.transaction`, concluído | 09:16:37,218 / 68 | 12:53:51,745 / 40 |
| `pdf.source` | 09:16:37,305 / 20 | 12:53:51,820 / 14 |
| `pdf.read` | 09:16:38,511 / 1.205 | 12:53:54,031 / 2.210 |
| `pdf.hash` | 09:16:38,697 / 186 | 12:53:54,272 / 241 |
| `pdf.metadata` | 09:16:38,831 / 7 | 12:53:54,351 / 4 |
| `pdf.transaction` | 09:16:38,833 / 136 | 12:53:54,354 / 82 |

As últimas leituras retornaram 56.439.793 e 56.430.336 bytes, respectivamente.
São downloads **posteriores** à selagem; seus 1,205/2,210 s não podem ser
atribuídos à leitura do original pelo selador. Os intervalos são aninhados:
não somar linhas inclusivas para reconstruir totais.
Os logs do PostgreSQL nos dois recortes vieram vazios: nenhuma duração de SQL
ou evidência histórica de lock/CPU foi recuperada.

## Disparo, esperas e ordem real

Referências locais: `packages/lib/server-only/semog-signing/{execution-effects,
host,outbox,sealing,pdf-store}.ts` e `db/2026-10-07-semog-host.sql`.

1. A execução da última manifestação e seus efeitos são gravados duravelmente.
   O efeito leva o nome compatível `internal.seal-document`, mas o host privado
   chama diretamente `runtime.sealer.seal`; não dispara o job nativo.
2. `createSemogHost.start()` começa imediatamente. Cada tick reclama um `seal`
   por RPC (`semog_signing_claim_seal_effect(120)`), em ordem de criação, com
   `FOR UPDATE SKIP LOCKED`. Depois de terminar, agenda outro tick em 1.000 ms.
   Não há sobreposição no loop. Sob fila, pode esperar outros envelopes mais
   esse intervalo; sem fila, espera até o próximo tick, mais consultas/agendamento.
3. Confere operação, ator, equipe, payload e recibo canônico (`executor.get`).
   Lê o original fora da transação; S3 faz download e conferência SHA-256.
4. Abre transação serializável, trava o envelope e relê seu estado. Confere
   elegibilidade e `ready_to_seal`; cria a auditoria de conclusão na transação.
5. Carrega o original para geometria, renderiza certificado/auditoria, carrega
   o PDF de trabalho, insere páginas/campos, achata, salva, recarrega para
   normalização e chama `PDF.sign` com CMS detached e certificado injetado.
6. Persiste o PDF conforme o armazenamento do original. Em S3/R2, faz PUT por
   conteúdo **antes do commit**; no banco cria `DocumentData`, atualiza o item,
   grava hashes/recibo, atribui `COMPLETED`/`completedAt` e registra o efeito de
   conclusão suprimido. O commit torna tudo visível de forma atômica.
7. **Depois do commit**, relê e confere o objeto selado em R2. Só então confirma
   o efeito na outbox. Essa leitura não atrasa a atribuição de `completedAt`,
   mas atrasa o ack e o próximo ciclo do worker. `completedAt` por si só também
   não garante que outro cliente já observou o commit.

Lease de 120 s é prazo de posse, não uma pausa. O limite de oito tentativas é
para falhas duráveis; ambos os testes usaram uma. `maxWait=10.000 ms` limita
espera por transação no Prisma; `timeout=60.000 ms` limita a transação. Não são
sleeps fixos. A trava pode esperar concorrência, sem duração histórica disponível.
A confirmação pós-commit pode tentar três vezes com backoff de 250/500 ms e
reescrever objeto ausente/adulterado antes de reconferir; não é debounce.
Tentativa 1 da outbox **não exclui** retries internos de transporte/confirmação.
Não há evidência de ocorrência desses retries nos recortes disponíveis.

Não foi comprovada espera evitável responsável pelos 7–9 s. Reduzir o poller
poderia tirar parte de até ~1 s sem fila, mas não explica nem resolve o tempo
dentro da transação. Nenhuma alteração de agendamento, download, validação,
normalização ou durabilidade foi feita sem evidência de custo.

## Instrumentação deste PR

Reutiliza o observer já conectado pelo host ao logger. Registra apenas
`stage`, `ms` arredondados e `ok`; os novos estágios não acrescentam IDs,
conteúdo, hashes, nomes, chaves de objeto, erros ou credenciais. O logger
fornece o timestamp do término; início aproximado = término menos `ms`.
Não há migração, flag nova ou mudança de respostas públicas.

| Estágio novo | Fronteira medida |
| --- | --- |
| `seal.actor`, `seal.receipt-check`, `seal.delivery` | Conferência do ator, recibo e entrega inteira antes do ack |
| `seal.source`, `seal.read`, `seal.preread` | Consulta das fontes; download/decode/hash do reader; pré-leitura inteira |
| `seal.lock`, `seal.envelope` | SQL de trava; consulta do envelope sob trava |
| `seal.audit` | Inserção da auditoria |
| `seal.original-load`, `seal.render` | Parse para geometria; certificado/auditoria renderizados |
| `seal.pdf-load`, `seal.decorate` | Parse de trabalho; páginas, campos e flatten |
| `seal.pdf-save`, `seal.normalize` | Save; reload do resultado antes de assinar |
| `seal.sign` | `PDF.sign` completo: serialização, hash, construção CMS e assinatura |
| `seal.signer` | Operação criptográfica do signer sobre atributos CMS, dentro de `seal.sign` |
| `seal.storage` | Hash/conversão inline ou PUT do selado |
| `seal.document-write`, `seal.receipt-write` | Linhas de documento/item; hashes e recibo durável |
| `seal.complete`, `seal.transaction` | Atualização final e efeito; transação inteira inclusive commit |
| `seal.confirm`, `seal.total` | Releitura/conferência pós-commit; selador inteiro |

`seal.signer` não mede isoladamente toda a construção CMS. O wrapper preserva
certificado, cadeia, algoritmos e o `this` do signer original; o port foi
conferido no pacote instalado `@libpdf/core`. Não muda os bytes entregues ao
signer nem opções da assinatura. Falhas síncronas do observer/formatador de
telemetria passam a ser ignoradas, preservando retorno e erro originais da
operação; esse comportamento é testado. Não há retry adicional da selagem.

Os tempos são inclusivos e não isolam CPU de espera. A instrumentação ainda
não mede consumo de CPU, GC, pressão de memória, tráfego ou tentativas do SDK.
Na próxima execução operacional autorizada, `seal.read` versus `seal.render`,
`seal.pdf-save`, `seal.sign`, `seal.storage` e `seal.document-write` localizarão
a etapa dominante entre reader, PDF, storage e SQL. `seal.lock` mostrará espera pela trava;
`seal.transaction` menos seus filhos também abrange setup/commit/trabalho
não isolado. Sob concorrência entre processos, não associar eventos apenas
por proximidade temporal: usar um recorte isolado para este diagnóstico.

## Ambiente de produção e comparação

Snapshot `docker stats --no-stream` durante a investigação:

| Contêiner | CPU instantânea | Memória / limite | PIDs |
| --- | ---: | --- | ---: |
| Documenso | 6,71% | 1,902 GiB / 6 GiB | 39 |
| PostgreSQL | 0,07% | 206 MiB / 15,62 GiB | 15 |

Isso não mede CPU/quota, throttling, GC, concorrência ou memória **durante os
testes**; não autoriza concluir falta ou sobra de CPU. Não foi usado
`docker inspect`/exec no app porque não faz parte do acesso autorizado.
As métricas cumulativas de rede/disco não foram usadas como taxa do teste.
O digest/commit da imagem em execução não foi inspecionado; o rastreamento do
código usa a branch de produção indicada, cruzada com logs e estado durável.
Não se afirma identidade binária da imagem com esse commit.

Diferenças verificadas em relação ao ensaio de 1,7 s: Postgres real em vez de
Prisma em memória; download/PUT/releitura R2 em vez de inline sem rede; arquivo
e complexidade diferentes; worker/poller além da chamada direta do selador.
CPU/memória do host, concorrência, latência de banco/rede e retries internos
continuam **a confirmar**, sem atribuição causal inventada.

## Validação local

Mac ARM64, Node 24.21.0, PostgreSQL 17.11 Homebrew descartável, OpenSSL 4.0.3. Dependências
instaladas com `npm ci`, Prisma gerado com URLs fictícias em loopback, sem
conexão ou migração nesse passo. Sem build. O script de rodadas recebeu apenas
um observer no cenário de PDF grande, para imprimir as novas etapas.

Duas execuções com PDF sintético de ~55 MiB e anexo aleatório não compressível:
primeiro somente cenário grande; depois rodadas completas + cenário grande.
**Ambas usaram Postgres real e armazenamento inline**, sem R2. O teste de
migração S3 posterior usa objetos em memória, sem representar rede operacional.
São duas amostras diagnósticas; não constituem benchmark estatístico nem
previsão de produção. Dados completos dos tempos de selagem:
[evidências JSONL](2026-11-04-selagem-producao-evidencias.jsonl).

| Etapa (ms) | Só cenário grande | Rodadas completas + grande |
| --- | ---: | ---: |
| Consulta de fontes / read-decode | 93 / 28 | 92 / 31 |
| Trava / consulta do envelope | 0 / 272 | 1 / 312 |
| Auditoria | 1 | 1 |
| Parse de geometria / render | 3 / 81 | 1 / 46 |
| Parse de trabalho / decoração | 1 / 15 | 0 / 12 |
| PDF.save / normalização | 37 / 1 | 35 / 1 |
| PDF.sign total / signer | 53 / não instrumentado ainda | 54 / 1 |
| Base64 do selado (`seal.storage`) | 13 | 12 |
| Documento + item no banco | 2.922 | 2.834 |
| Hashes + recibo | 139 | 121 |
| Conclusão + efeito | 2 | 1 |
| Transação inclusive commit | 3.568 | 3.446 |
| Confirmação pós-commit (inline: nenhuma leitura) | 0 | 0 |
| Selador total / entrega | 3.690 / 3.692 | 3.569 / 3.571 |

A escrita inline no banco dominou essas amostras locais. Isso demonstra por
que Prisma em memória não serve como baseline de produção; **não demonstra
que a escrita no banco domina em produção**, onde `S3_PATH` evita transportar
esses Base64 para gravar o documento. Não foi proposta otimização funcional
com base nessa diferença de armazenamento.

CMS detached dos bytes baixados conferido com `/opt/homebrew/bin/openssl`
(`cms -verify -binary -inform DER -noverify`), com exit 0. O helper exige
ByteRange cobrindo todo o arquivo, excluindo exatamente o token Contents;
`-noverify` dispensa confiança na cadeia efêmera, preservando a verificação
criptográfica. Resultados sintéticos:

- Só grande: 58.108.777 bytes; SHA-256
  `f9ff8a7538022860629d00eb138d7dfbd17cdf38e6127a6bd9b01a484f58090f`.
- Rodadas + grande: 58.104.371 bytes; SHA-256
  `19f54cd966816da5145bda2fc41774f01f0541766cbd52628c76a46e8fc8c270`.

Rodadas completas aprovadas: selos parciais, concorrência, prorrogação, contato,
cancelamento, operações pendentes/vencidas e mutantes dos gatilhos. O cenário
grande também conferiu leitura única após migração S3, bloqueio de escrita
direta e recusa de objeto adulterado. Processos PostgreSQL exclusivos foram
encerrados e diretórios descartáveis removidos pelo `finally`; não restaram
processos `semog-rounds` na conferência final.

Comandos de reprodução (sem acesso operacional):

```sh
node node_modules/@biomejs/biome/bin/biome check packages/lib/server-only/semog-signing apps/remix/server/semog-signing-host.ts apps/remix/server/semog-signing-routes.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.semog-signing.json
node node_modules/vitest/vitest.mjs run --config packages/lib/vitest.config.ts --maxWorkers=2 packages/lib/server-only/semog-signing
node --test apps/remix/app/utils/semog-recipient.test.mjs apps/remix/app/utils/recipient-remark.test.mjs apps/remix/app/utils/remark-page.test.mjs packages/lib/client-only/hooks/load-signature-font.test.mjs
SEMOG_PG_BIN=/opt/homebrew/bin SEMOG_OPENSSL_BIN=/opt/homebrew/bin/openssl SEMOG_LARGE_PDF_ONLY=true node node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-rounds-local.ts
SEMOG_PG_BIN=/opt/homebrew/bin SEMOG_OPENSSL_BIN=/opt/homebrew/bin/openssl SEMOG_LARGE_PDF=true node node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-rounds-local.ts
```

Checks finais: Biome no escopo exato da CI aprovado (104 arquivos, sem avisos);
o script de rodadas também aprovado, com cinco avisos preexistentes sobre
variáveis de ambiente fora do cache Turbo. TypeScript aprovado com
`tsconfig.semog-signing.json`; suíte Vitest completa: 33 arquivos, 311 testes;
patches nativos Node: 33/33. Revisão independente de código e relatório sem
bloqueantes; testes independentes de selagem/tempos: 8/8, incluindo erro do signer
sem atualização para COMPLETED. `git diff --check` aprovado.

## Publicação e próxima medição

PR para `leandrosemog/documenso-2.18`, **sem merge**. O merge dispara a publicação
da imagem por CI. **Avisar Leandro antes do merge**; o deploy em produção cabe
ao Claude com autorização do Leandro. Esta investigação não executou deploy
nem alterou produção. Os tempos novos só estarão disponíveis operacionalmente
depois desse deploy e de um teste autorizado pelo operador.

A próxima medição deve guardar os eventos `seal.*` do início ao ack e os mesmos
marcos do banco, em recorte isolado. Isso permite escolher uma correção baseada
na etapa dominante, mantendo intactos validação do original, CMS, guardas,
operação durável e confirmação do objeto.
