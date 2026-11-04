# Medição do recebimento do PDF e criação do rascunho

Data: 04/11/2026. Fork `semog-tech/documenso`, branch
`codex/medicao-recebimento-rascunho`, criada de
`leandrosemog/documenso-2.18` em `d54ca2f0a15ec63c7c8a08c22b7e06d210063abf`.
Referências: [host](../semog-signing-host.md),
[leitura única](2026-11-04-ponte-leitura-unica.md) e
[selagem / PR #10](2026-11-04-selagem-producao.md).

## O que já sabemos e o que falta medir

O solicitante informou dois intervalos operacionais, para PDF de aproximadamente
55 MB: **4,6 s às 09:07 e 13,3 s às 12:46**, entre começar o registro no motor
no semogapp e `Envelope.createdAt`. Os logs do segundo teste se perderam no
redeploy. Esses números não foram reproduzidos nem investigados em produção
neste trabalho. Nenhum acesso a produção, banco operacional, PDF ou credencial
operacional foi feito. Ainda não é possível atribuir os 8,7 s de diferença a
upload, PDF, banco, rede, GC ou retries.

O intervalo informado inclui trabalho do semogapp e transporte até o Documenso.
Além disso, `createdAt` não é um cronômetro de fim: no schema Prisma é
`@default(now())`; com PostgreSQL, `now()` marca o início da transação. O PUT e a
releitura prévia acontecem antes dela; a criação de linhas, o commit, a confirmação
posterior e a resposta ainda precisam terminar. Compare durações monotônicas
por etapa e a resposta completa, sem tratar `createdAt` como horário do commit.

Este PR só acrescenta observação. Não muda contrato, armazenamento, validações,
idempotência, limites, timeouts, isolamento, número de leituras/escritas, retries
ou respostas. O custo em segundos em produção virá do próximo teste após deploy
autorizado. Também não mede custo financeiro ou consumo de CPU/RAM.

## Caminho encontrado

O cliente real está em `server/documenso/envelopeRascunho.ts`, função
`criarClienteEnvelopeRascunho`, injetada por
`server/assinatura/prestacaoEnvioComposicao.ts`. A preparação fica em
`server/assinatura/envelopePreparacao.ts`. Leitura local do worktree paralelo
`semogapp/envio-registro-motor`, sem alterá-lo:

1. Semogapp reserva a operação, baixa o PDF do bucket dele (HEAD + GET completo,
   `transformToByteArray`) e confere tamanho/hash; o cliente confere hash novamente.
2. Faz `POST /api/semog/v1/envelopes-rascunho`, timeout de 60 s, redirects recusados.
   O formato preferido é multipart: `metadados` JSON e `arquivo` PDF binário;
   um iterável envia fatias de 1 MiB do buffer já existente, sem Content-Length.
3. Somente se o multipart receber **HTTP 400**, repete com JSON e `pdfBase64`.
   Não há evidência preservada de qual formato os testes históricos usaram.
4. No fork, `apps/remix/server/router.ts` monta `semog-signing-routes.ts`;
   rate limit e autenticação nativa precedem o corpo. O host chama
   `draft-runtime.ts` → `draft-http.ts` → `draft-service.ts`.
5. `readSemogBoundedBody` acumula chunks até EOF e faz `Buffer.concat`.
   O parser multipart devolve uma view sobre esse buffer; JSON faz UTF-8 + parse,
   e a validação legada decodifica Base64. O serviço valida schema, tamanho,
   SHA-256, parse do PDF, páginas dos campos e hash canônico de idempotência.
6. `putSemogStoredPdf` chama o store S3/R2 **antes da transação**. O transporte
   confere o hash dos bytes; faz HEAD, e, se já existir, GET + hash para decidir
   reutilização. Se necessário, calcula checksum e faz `PutObject`.
   Depois o helper faz GET + hash de conferência, inclusive quando houve PUT.
7. Abre transação `ReadCommitted` (`maxWait=10 s`, `timeout=60 s`): ator/equipe,
   advisory locks, replay, contador, `DocumentData`, envelope/meta/item,
   destinatários/campos, auditoria e recibo/estrutura. Replay também passa
   pelo armazenamento anterior à transação. Não dispara webhook/e-mail nativo.
8. Depois do commit, `ensureSemogStoredPdf` confirma presença por HEAD no R2;
   sem HEAD disponível usa GET + hash. Se ausente, reescreve e relê. Falhas de
   confirmação têm até três tentativas com backoff de 250/500 ms, já existentes.
   Só depois constrói a resposta JSON.

**Sim: o corpo inteiro fica bufferizado no Documenso antes de começar o upload.**
O envio em fatias pelo semogapp não torna esse recebimento um pipeline até o R2.
Há buffers completos nos dois serviços, além de cópias/alocações temporárias.

**Não há Base64 do PDF no multipart normal.** O fallback JSON representa N bytes
em `4 × ceil(N/3)` caracteres, aproximadamente **33,3% a mais**, além do JSON.
Para 55.000.000 bytes: 73.333.336 caracteres, mais 18.333.336 bytes ASCII de carga.
Isso não estima o pico de RAM (strings e cópias dependem do runtime).
`S3_PATH` guarda a chave no banco, não Base64 do PDF. O checksum SHA-256 em Base64
no header do PUT tem apenas 44 caracteres; não é o documento inflado.

## Leitura da próxima medição e alinhamento com o semogapp

No worktree paralelo, os nomes observados são `documenso.prepararNativo`
(preparação inteira), `reservarEnvelope`, `r2.download`, `r2.hash`,
`documenso.criarNativo` (cliente + recibo) e `registrarEnvelope` (registro local).
O [relatório paralelo do semogapp](https://github.com/semog-tech/semogapp/blob/obs/envio-registro-motor/docs/superpowers/plans/2026-11-04-envio-registro-motor.md)
fica em `docs/superpowers/plans/2026-11-04-envio-registro-motor.md`.
Ele também define `documenso.http.primeiroByte` (até primeiro chunk não vazio
da resposta) e `documenso.http.total` (até EOF; em erro sem consumo, até headers).
Esses bytes são da resposta, enquanto `draft.body.bytes` é o corpo recebido.
O hash local do cliente permanece agregado em `documenso.criarNativo`.
O namespace `draft.*` abaixo identifica exclusivamente
o fork, e `storage.s3.*` identifica o transporte compartilhado. Não renomear
`r2.download` do semogapp para confundi-lo com a releitura no bucket Documenso.

Os nomes `rascunho.*` propostos pelo relatório paralelo ficam mapeados aos
nomes efetivamente implementados neste PR:

| Nome proposto no relatório semogapp | Nome efetivo no fork |
| --- | --- |
| `rascunho.http.receber` | `draft.body` |
| `rascunho.pdf.hash` | `draft.hash` |
| `rascunho.r2.gravar` | `storage.s3.put` para PUT; `draft.storage` para o conjunto com conferências |
| `rascunho.envelope.criar` | `draft.envelope-items`; `draft.transaction` inclui o commit |
| `rascunho.http.responder` | `draft.response`; `draft.total` inclui o processamento anterior |

Não são aliases emitidos em duplicidade. `documenso.http.*` contém rede e
processamento do fork; não somar seu total ao total do servidor.

O observer já usado pelo host publica `semogStage: { stage, ms, ok, bytes? }`.
Só há nomes fixos, duração arredondada e tamanho; não há pessoas, IDs de
envelope/operação, tokens, corpo, hashes, chaves, nomes de arquivo ou erros.
Falhas de observer/formatador não alteram retorno nem erro original. Bytes são
registrados nas etapas bem-sucedidas, nunca conteúdo ou tamanhos declarados
sem conferência. O timestamp do logger é o fim; início aproximado = fim menos ms.

| Etapa | Fronteira medida |
| --- | --- |
| `draft.total`, `draft.authenticate` | Handler até Response de sucesso; autenticação antes do corpo |
| `draft.body` | Leitura limitada até EOF + concatenação; bytes do corpo HTTP |
| `draft.parse.json`, `draft.parse.multipart` | UTF-8/JSON ou separação multipart + JSON dos metadados; multipart informa bytes do PDF |
| `draft.validate`, `draft.validate.schema` | Validação inteira; parse Zod |
| `draft.decode.base64`, `draft.hash` | Decode legado; conferência SHA-256/tamanho; bytes do PDF |
| `draft.pdf-load`, `draft.request-hash` | Parse PDF + validação de páginas; hash canônico do pedido |
| `draft.storage` | Persistência inicial completa: write + releitura/hash, ou conversão inline |
| `draft.storage.write` | Método write do store, inclusivo: hash, HEAD/GET para reutilizar e PUT quando necessário |
| `draft.storage.read`, `draft.storage.head` | Leitura bruta e confirmação de presença feitas pelo helper; SHA-256 do readback está no pai `draft.storage` |
| `storage.s3.hash`, `storage.s3.checksum` | Hash antes de write e do objeto existente; checksum SHA-256 do PUT |
| `storage.s3.head`, `storage.s3.read`, `storage.s3.put` | Chamadas reais ao SDK: HEAD; GET + corpo completo; PUT sem cálculo prévio do checksum |
| `draft.transaction` | Transação completa, incluindo aquisição e commit |
| `draft.actor`, `draft.lock`, `draft.replay` | Ator/equipe sob transação; advisory locks; consulta/conferência de replay |
| `draft.native` | Criação nativa completa, sem recibo da ponte |
| `draft.document`, `draft.envelope-items` | Contador + DocumentData; envelope com meta/item aninhados |
| `draft.recipients-fields`, `draft.audit` | Loop de todos os destinatários/campos; auditoria de criação |
| `draft.receipt` | Snapshot/hash da estrutura e gravação do recibo |
| `draft.confirm`, `draft.response` | Confirmação pós-commit com retries existentes; serialização/construção da resposta de sucesso |

`storage.s3.*` também aparece em outras operações que usam o store do host,
inclusive selagem: não atribuir esses eventos ao rascunho fora de um recorte
isolado. Um HEAD de objeto novo lança `NotFound` no SDK e registra
`storage.s3.head ok=false`; o store converte essa ausência normalmente em
`exists=false`. Esse evento isolado **não significa falha do pedido**.
Erros de outras etapas registram `ok=false` antes da sanitização HTTP;
`draft.total` falho termina antes de construir a resposta de erro, e rota
inexistente pode terminar normalmente com 404. `ok` indica término da função
medida, não uma classificação universal do status HTTP.

As etapas são inclusivas: não somar pai com filhos. `draft.total` começa no
handler após middleware/obtenção do host e termina na construção da Response;
não mede TLS/proxy, inicialização do host, rate limit, envio efetivo da resposta
na rede ou download prévio no semogapp. `draft.body` inclui espera pelo corpo e
concatenação; não recupera tempo já gasto num buffer anterior ao handler.
`storage.s3.put` mede o `client.send` inteiro, inclusive retries internos do SDK,
sem discriminar tentativas. Sob concorrência não há correlação inequívoca por
pedido: fazer primeiro um teste isolado e preservar os logs antes do redeploy.

## Opções futuras, ganho esperado e risco

Estas são propostas, sem implementação neste PR e sem promessa numérica de
ganho antes da medição operacional.

| Opção | Ganho que se espera medir | Risco / condições |
| --- | --- | --- |
| Stream do corpo ao R2 com hash incremental | Sobrepor recepção e upload; aproximar transferência de `max(receber, enviar)` em vez da soma, reduzir buffers completos no recebimento | Parser multipart incremental com limites e backpressure; cancelar upload incompleto; checksum final só conhecido no EOF; chave por hash exige staging/finalização; validar PDF/páginas antes de publicar envelope. O parse atual ainda exige bytes completos: usar spool limitado/arquivo temporário ou mudar o leitor, sem fingir memória constante. Retries de stream não rebobinável precisam de estratégia explícita. |
| Aceitar referência de objeto já copiado ao bucket Documenso, CopyObject pelo semogapp | Retirar o PDF da chamada HTTP semogapp → Documenso e o PUT pelo processo Documenso; manter um GET completo para SHA-256 e parse antes de criar linhas | Autenticar e vincular equipe/operação/hash/tamanho; bucket fixo, sem URL arbitrária; confirmar bytes uma vez e reutilizar no parse. Não confiar em chave, ETag ou metadata como prova de SHA-256. Garantir objeto estável entre conferência e uso, coordenar purga/retries/órfãos e isolamento de credenciais. |
| Upload direto com URL pré-assinada ou credencial temporária de um objeto no bucket Documenso; finalize por referência | Evitar proxy do PDF no Documenso e manter credenciais permanentes separadas; mesma validação final com uma leitura | Fluxo em duas fases, expiração e limpeza de uploads abandonados; não é CopyObject entre buckets. Ainda transfere bytes pelo emissor, salvo arquitetura específica. |
| Remover Base64/fallback depois de comprovar compatibilidade | Evitar segunda tentativa e inflação de ~33% quando o fallback ocorre | Não dá ganho no multipart que já funciona; retirada exige combinar versões e distinguir 400 de contrato antigo de 400 por dados inválidos. |
| Rever releituras e hashes repetidos após medir | Economizar GET/hash se eles dominarem; semogapp e store já conferem bytes em mais de uma camada | Não remover prova de integridade/durabilidade por conveniência. Checksum aceito pelo serviço, objeto imutável e coordenação da purga precisam de evidência/testes antes de substituir uma releitura. |
| Medir reutilização, banco e transporte | Distinguir upload novo de objeto existente; avaliar pool, contador/locks e latência/connection reuse quando as etapas mostrarem espera | Ajustar concorrência/timeouts sem evidência pode ampliar contenção e falhas. Não mudar transações/guardas neste PR. |

CopyObject é suportado na [matriz oficial S3 do R2](https://developers.cloudflare.com/r2/api/s3/api/).
Isso não comprova que as **duas credenciais atuais, cada uma de um bucket**, possam
autorizar uma cópia server-side numa só chamada. Não há campo para passar uma
segunda credencial no CopySource. [Tokens R2](https://developers.cloudflare.com/r2/api/tokens/)
permitem restringir buckets; validar em buckets descartáveis a política mínima
de leitura na origem/escrita no destino e a cópia entre os dois buckets da mesma
conta. Não trocar as credenciais atuais por uma chave ampla.
[Credenciais temporárias R2](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)
são limitadas a **um bucket** e podem restringir objetos/prefixos; não resolvem
sozinhas autorização cross-bucket. Se o escopo assimétrico necessário não for
possível, usar serviço de cópia restrito ou upload direto ao destino; registrar
essa limitação antes de escolher a arquitetura. Fontes oficiais consultadas
em 04/11/2026; a viabilidade completa permanece a confirmar por ensaio.

## Validação local

macOS ARM64, Node 24.21.0, dependências do lockfile instaladas por `npm ci`;
Prisma gerado com URLs de fixture em loopback, sem conexão nem migração nesse
passo. Nenhum build executado. Portões da CI executados:

```sh
node node_modules/@biomejs/biome/bin/biome check packages/lib/server-only/semog-signing apps/remix/server/semog-signing-host.ts apps/remix/server/semog-signing-routes.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.semog-signing.json
node node_modules/vitest/vitest.mjs run --config packages/lib/vitest.config.ts --maxWorkers=2 packages/lib/server-only/semog-signing
node --test apps/remix/app/utils/semog-recipient.test.mjs apps/remix/app/utils/recipient-remark.test.mjs apps/remix/app/utils/remark-page.test.mjs packages/lib/client-only/hooks/load-signature-font.test.mjs
node node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-host-local.ts
SEMOG_PG_BIN=/opt/homebrew/bin SEMOG_OPENSSL_BIN=/opt/homebrew/bin/openssl node node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-rounds-local.ts
```

Biome aprovado no escopo da CI (105 arquivos); TypeScript aprovado; Vitest
34 arquivos/319 testes aprovados. Depois dessa suíte foi acrescentado um teste
de callback transacional; o arquivo final `draft-timing.test.ts` foi executado
separadamente com seus cinco casos. Testes Node: 33/33 aprovados.
O novo arquivo segue o padrão observacional de `timing.test.ts`: observer que
lança não muda o resultado, erro original preservado, formato seguro dos eventos,
EOF antes de storage, JSON/Base64 e multipart, schema/hash/PDF recusados;
callback com native/repository reais e Prisma simulado verifica criação,
replay e falha de commit. Os testes S3 cobrem PUT/checksum, reutilização sem PUT,
erro original de GET e observer falhando. São provas funcionais locais, não
benchmark de rede R2 ou previsão de produção.

O processo HTTP em loopback passou com rotas/middleware reais, default-off e
autenticação antes do corpo. O ensaio de rodadas passou contra PostgreSQL 17
descartável: selos parciais, concorrência, prorrogação, contato, cancelamento,
operações pendentes/vencidas e mutantes das guardas. Nenhum processo PostgreSQL
exclusivo desse ensaio restou após o `finally`. Não se usou R2 real.
Revisão independente de código, testes e relatório sem bloqueantes;
`git diff --check` aprovado. Checks não justificam atribuir tempos à produção.

## Publicação e autorização

PR para `leandrosemog/documenso-2.18`, **sem merge**. Aviso antes de qualquer merge:
o Claude valida e repassa a autorização do Leandro. O deploy da imagem é feito
pelo Claude. Este PR não executa deploy, migração ou teste operacional.
Após deploy autorizado, capturar as etapas do semogapp e do fork em um envio
isolado de aproximadamente 55 MB, registrar formato, tamanho, versão/imagem e
horários, preservando logs antes de redeploy. Repetir para observar variância;
não atribuir causalidade a uma única amostra nem comparar relógios sem considerar
desvio. O tempo end-to-end deve ser medido no semogapp, incluindo sua resposta
e persistência; os eventos do fork separam o trecho que ele controla.
