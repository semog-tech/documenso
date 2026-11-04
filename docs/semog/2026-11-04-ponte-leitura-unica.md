# Ponte: consulta por metadados e download com uma leitura

## Escopo e referência

Trabalho iniciado a partir de `0b87ef3e72a6fd2e272f3cb1116a951dcee30752`, da branch
`leandrosemog/documenso-2.18` do fork `semog-tech/documenso`, em
`codex/ponte-leitura-unica`. Nenhum acesso à produção ou ao banco operacional.

A referência de produção foi fornecida pelo solicitante: logs do semogapp #695,
04/11/2026 02:42 UTC, prestação de aproximadamente 55 MB. A conclusão levou
18,05 s: conferência nativa inicial 1,44 s; estado da ponte 3,81 s; download até
primeiro byte 4,97 s; corpo 0,42 s; parse final 0,63 s; gravação R2 2,02 s;
releitura R2 1,77 s; conferência nativa final 1,55 s; após conclusão 0,30 s.
O worker ainda acumulou cerca de 10 s reconciliando outras operações ativas em
série: aproximadamente 32 s da última assinatura até a conclusão gravada.
Esses valores não foram medidos novamente por este trabalho.

O PR trata as leituras redundantes no fork. A fila serial do semogapp, suas
conferências nativas e as escritas/releituras R2 dele permanecem fora deste escopo.
Uma redução local não equivale a uma previsão do tempo total em produção.

## Garantias e limites

O estado passa a consultar a operação durável, o envelope e o recibo de selagem
sob a mesma trava do envelope. O selador grava metadados adicionais no JSON do
recibo, na mesma transação da conclusão: tipo de armazenamento, hashes das
representações persistidas, hash do original e tamanho do PDF selado. O formato
público das respostas não incorpora esses campos internos.

Para recibos novos inline, o banco confere os hashes das colunas contra o
recibo, sem enviar Base64 ao processo nem decodificar PDF. Isso ainda exige ler
e calcular digest das strings no PostgreSQL; não é uma consulta de custo
constante em relação ao tamanho do documento. Para recibos inline antigos,
o caminho de compatibilidade calcula os hashes do conteúdo no próprio banco.
Em S3, as chaves por conteúdo permitem conferir os hashes sem buscar o objeto.

O download lê somente o selado antes da transação e vincula os bytes lidos à
linha e ao recibo conferidos sob trava. O hash dos bytes precisa corresponder
ao hash da selagem. Não se renderiza, normaliza ou grava novamente o PDF nesse
caminho. O parse repetido deixa de ser necessário para bytes que reproduzem
o hash do arquivo já selado.

Os gatilhos `semog_bridge`, a reserva da operação, a aplicação da manifestação
e os efeitos duráveis continuam protegendo as mutações. O recibo é parte do
estado confiável do banco. A consulta de estado não atesta a disponibilidade
atual do bucket nem detecta sozinha um objeto substituído no armazenamento:
essas falhas aparecem na leitura e conferência do download. Nenhuma credencial,
PDF operacional ou certificado privado integra a evidência versionada.

## Evidência local

### Comparação com PDF grande

Fixture sintética: PDF válido com anexo aleatório referenciado no catálogo,
55 MiB de carga não compressível. Original: **57.728.494 bytes**; selado:
**58.321.016 bytes**. Não representa a complexidade visual de uma prestação
escaneada. O selador nativo preservou a carga, acrescentou campos, certificado
e auditoria e produziu CMS detached.

O executor original do commit base foi extraído com `git show` e recebeu somente
instrumentação de duração. Original e otimizado consultaram o **mesmo banco,
operação e PDF selado**, três `get` e três `pdf` consecutivos para cada versão.
As medições foram realizadas diretamente no executor, sem HTTP nem rede R2.
São tempos do servidor, não tempo até o primeiro byte HTTP.

| Caminho | Original: três amostras (ms) | Otimizado: três amostras (ms) | Mediana original → otimizado |
| --- | --- | --- | --- |
| Estado `get` | 5.112,55 / 3.449,47 / 2.624,23 | 270,40 / 304,05 / 362,75 | **3.449,47 → 304,05 ms** |
| Download `pdf` | 1.644,69 / 1.525,99 / 1.579,25 | 1.086,29 / 1.079,73 / 770,38 | **1.579,25 → 1.079,73 ms** |
| Leituras de PDF em `get` | 2 por chamada | 0 | original + selado → nenhuma |
| Leituras de PDF em `pdf` | 2 por chamada | 1 | original + selado → somente selado |

Etapas, em milissegundos; cada célula é a mediana da etapa entre as três chamadas:

| Etapa | `get` original | `get` otimizado | `pdf` original | `pdf` otimizado |
| --- | ---: | ---: | ---: | ---: |
| Consulta prévia das fontes (`source.transaction` / `pdf.source`) | 1.376,74 | — | 721,03 | 435 |
| Leitura/decodificação no reader (soma por chamada) | 388,48 | 0 | 246,08 | 139,49 |
| Hashes no processo (soma por chamada) | 470,77 | 0 | 241,58 | 188 |
| Parse completo repetido do selado | 130,08 | 0 | 53,49 | 0 |
| Metadados/digests sob trava (`get.metadata` / `pdf.metadata`) | incluído abaixo | 300 | incluído abaixo | 228 |
| Transação com trava, incluindo metadados | 274,67 | 304 | 210,28 | 232 |

As etapas de metadados estão **dentro** da transação; `pdf.read` contém o reader.
Não se somam linhas inclusivas, nem medianas independentes para reproduzir a
mediana total. O total também inclui validações, conversão textual para buscar
marcadores CMS no código antigo, alocações, agendamento e trabalho não isolado.
Os hashes textuais no PostgreSQL ainda percorrem as colunas inline. O ganho
determinístico é a eliminação das transferências, decodificações e parse
redundantes; os tempos variam com carga e cache. O estado original foi medido
primeiro, e suas amostras caíram bastante: três amostras sob contenção não
constituem benchmark isolado nem previsão de ganho em produção.

As 12 amostras comparativas, outras seis de reconferência em uma segunda fixture
e dois registros de verificação, sem documentos ou identificadores operacionais,
estão em [evidências JSONL](2026-11-04-ponte-leitura-unica-evidencias.jsonl).

### Verificação criptográfica

O arquivo baixado tem SHA-256
`9da7eac4b60e80cbfc4da5dacf40b5ece3ae0ec8cc6468a16fc72cd8b028db81`.
O `ByteRange` é `[0, 58295735, 58320313, 703]`: cobre o arquivo inteiro,
exceto o token `Contents` da assinatura. O CMS foi conferido com
`/opt/homebrew/bin/openssl` **4.0.3**. `-noverify` dispensa a política de confiança
da cadeia do certificado de ensaio; a integridade criptográfica detached é
verificada. O helper também exige que o intervalo excluído corresponda exatamente
ao `Contents`, evitando aprovar um arquivo com bytes fora da assinatura.

A principal repetiu a verificação CMS com esse executável: saída
`CMS Verification successful`, exit 0, e conferiu novamente o SHA-256. Os bytes
sintéticos, arquivos CMS e bancos descartáveis não são versionados.

### Migração legítima para S3 e falhas

Uma segunda fixture foi selada e conferida com OpenSSL: original de
57.728.495 bytes; selado de 58.100.544 bytes, SHA-256
`210377fba96065734a3364b7a621c21f46e80252d2a62bf4e5336fd13723cc63`.
O ensaio aplicou os pares SQL de armazenamento no banco descartável e chamou a
função real `semog_bridge.migrate_document_data_to_s3`, preservando o recibo novo.
O armazenamento de objetos foi uma implementação em memória, sem acesso R2.

Depois da migração: estado disponível com **zero** leituras de objeto; download
com **uma** leitura, retornando exatamente os bytes selados e o mesmo CMS. O
gatilho recusou um `UPDATE` direto do documento selado; substituir o objeto no
armazenamento fez o download recusar os bytes adulterados. Ambas as instâncias
PostgreSQL dos ensaios grandes foram encerradas e seus diretórios removidos.

### Ambiente e comandos

Ambiente: macOS ARM64, Node 24.21.0, PostgreSQL 17.11 do Homebrew. O worktree
inicial estava sem dependências: foi necessário `npm ci --no-audit --no-fund`
e gerar Prisma com URLs de fixture locais, sem conexão de banco. Não houve
alteração de lockfile. Havia compiladores e testes de outros worktrees rodando
na mesma máquina; nenhum processo alheio foi encerrado.

```sh
node node_modules/@biomejs/biome/bin/biome check \
  packages/lib/server-only/semog-signing \
  apps/remix/server/semog-signing-host.ts apps/remix/server/semog-signing-routes.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.semog-signing.json
node node_modules/vitest/vitest.mjs run --config packages/lib/vitest.config.ts \
  --maxWorkers=2 packages/lib/server-only/semog-signing
node --test apps/remix/app/utils/semog-recipient.test.mjs \
  apps/remix/app/utils/recipient-remark.test.mjs \
  apps/remix/app/utils/remark-page.test.mjs \
  packages/lib/client-only/hooks/load-signature-font.test.mjs
SEMOG_PG_BIN=/opt/homebrew/bin node node_modules/vite-node/vite-node.mjs \
  --config packages/lib/vitest.config.ts scripts/semog-signing-rounds-local.ts
SEMOG_PG_BIN=/opt/homebrew/bin SEMOG_OPENSSL_BIN=/opt/homebrew/bin/openssl \
  node node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts \
  scripts/semog-signing-large-comparison-local.ts
```

O runner comparativo extrai e instrumenta o commit base, cria arquivos temporários
com nomes únicos e os remove no `finally`. `--prepare-only` confere os marcadores
da instrumentação sem iniciar Postgres. Para executar só o ensaio grande atual,
usar `SEMOG_LARGE_PDF_ONLY=true` no script de rodadas; para acrescentá-lo às
rodadas completas, usar `SEMOG_LARGE_PDF=true`. O preparo atualizado usa quatro
assinaturas nativas equivalentes e a última pela ponte; na captura acima, as
cinco assinaturas passaram pela ponte. Isso só muda o preparo anterior à medição.

A suíte completa da ponte passou: 32 arquivos, 308/308 testes. O TypeScript do
`tsconfig.semog-signing.json` passou sem erros. A revisão independente executou
os testes de execução do documento e selagem: 27/27 aprovados. Os patches
nativos do comando Node acima tiveram 33/33 testes aprovados. Não foi executado
build.

Biome no escopo exato da CI passou sem erros. Os três scripts de ensaio também
passaram; o lint reporta seis avisos sobre variáveis de ambiente de scripts
diretos não declaradas no cache do Turbo, incluindo as variáveis locais antigas
do Postgres. Não foi necessário alterar o cache ou o pipeline de produção.

O ensaio completo de rodadas terminou com sucesso contra PostgreSQL descartável:
selos parciais, concorrência, prorrogação, contato, cancelamento, operações
pendentes/vencidas e mutantes dos gatilhos. O banco e diretório temporários foram
encerrados/removidos pelo `finally` do script.

## Publicação

PR destinado a `leandrosemog/documenso-2.18`, sem merge. A troca de digest em
produção cabe ao Claude, mediante autorização do Leandro. Este trabalho não
executa deploy nem migrações no banco operacional.
