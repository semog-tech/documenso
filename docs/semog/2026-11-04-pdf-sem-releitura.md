# PDF sem releitura redundante do R2

Data: 04/11/2026. Fork `semog-tech/documenso`, branch
`leandrosemog/documenso-pdf-sem-releitura`, criada da produção
`leandrosemog/documenso-2.18`, commit `4d3fc306` (PR #11).
Referências: [host](../semog-signing-host.md),
[selagem](2026-11-04-selagem-producao.md),
[rascunho](2026-11-04-recebimento-rascunho.md) e
[ponte](2026-11-04-ponte-leitura-unica.md).
Nenhum acesso à produção, PDF operacional, segredo ou banco operacional.

## Decisões e garantias

A foi implementado como cache descartável em disco, compartilhado pelos leitores
do host: inscrição, manifestação, pré-leitura da selagem, selo parcial, contato e
download final. Depois de PUT bem-sucedido ou GET remoto íntegro, os bytes podem
alimentar o cache. O nome do arquivo combina o digest de endpoint/região/bucket e
chave do objeto com o SHA-256 do conteúdo. Uma chave nunca vira caminho de disco.
Cada hit verifica SHA-256 antes de retornar; corrupção remove a entrada e busca
R2. Chamadas simultâneas para o mesmo objeto compartilham o GET em andamento e
recebem buffers independentes. O coalescing também abrange confirmações remotas;
o primeiro leitor define o prazo da transferência compartilhada, e outro leitor
não pode cancelar seus pares. Não há cache compartilhado entre processos.

A inscrição não lê o PDF para renderizar nem inserir a parte. Ela precisa do
SHA-256 dos bytes para vincular documento, consentimento e estrutura no snapshot.
Preservamos essa prova: no cache quente, lê/hash do disco; no frio, GET + hash.
Não inferimos integridade apenas do nome do objeto nem alteramos os hashes dos
recibos. A manifestação continua conferindo snapshot, valores e geometria.

B substitui a releitura de confirmação do rascunho e da selagem por
`HeadObject(ChecksumMode=ENABLED)`, comparando `ChecksumSHA256` em Base64 e
`ContentLength` com os bytes esperados. O PUT continua enviando `ChecksumSHA256`.
A nova garantia é a aceitação do checksum pelo armazenamento no PUT, seguida da
conferência dos metadados do objeto remoto no HEAD. **Não é uma releitura física
do arquivo nem uma prova independente da implementação/durabilidade do R2.**
Não usamos ETag ou metadata definida pelo cliente como substituto do checksum.
Se o HEAD omitir SHA-256, um GET remoto integral confere hash e tamanho, mesmo
com cache quente. Divergência não vira sucesso pelo cache. A confirmação
também usa GET se o serviço rejeitar explicitamente o modo checksum com 501,
`NotImplemented` ou `NotSupported`; 403, 404 e timeouts não são mascarados.
A confirmação pós-commit da selagem preserva regravação e três tentativas com os mesmos backoffs.
O HEAD de presença pós-commit do rascunho também continua existindo.

Os logs distinguem `storage.s3.confirm.head-checksum` e
`storage.s3.confirm.readback`, além das etapas `storage.s3.head/read/put`.
A reutilização de objeto existente também usa checksum/tamanho do HEAD quando
disponíveis, evitando GET em replay. Sem checksum, confere remotamente.
Os logs de cache têm apenas motivo fixo (`unavailable`, `corrupt`, `low-space`,
`invalid-content`), sem caminho, chave, hash, identificador ou conteúdo do PDF.

Cache desligado: nenhum acesso ao diretório, timer ou gravação local; leituras
voltam ao R2. As mudanças B autorizadas continuam valendo e GETs simultâneos ainda
podem coalescer. Sem S3, o armazenamento inline permanece igual. Falha local de
cache, configuração inválida ou falta de espaço não falha a operação: há aviso
e uso do R2. Um cache quente pode servir bytes íntegros durante indisponibilidade
ou alteração do R2; ele não atesta disponibilidade atual do objeto remoto.
Confirmações de persistência sempre consultam o armazenamento remoto.

Não se alteram API pública, SQL, guardas `semog_bridge`, idempotência, snapshots,
leases, retries, polling, assinatura CMS, recibos ou hashes persistidos.

## Limites e segurança do disco

1. **Teto total:** padrão 3 GB (`3000000000` bytes). Antes da escrita, remove
   entradas menos recentemente usadas até caber o novo arquivo. O cálculo inclui
   espaço para o temporário, inclusive ao substituir uma entrada existente.
   Um PDF maior que o teto não entra no cache. Ao reiniciar com teto menor, a
   varredura também aplica o teto novo.
2. **Inatividade:** padrão 72 horas desde a última leitura local ou escrita.
   Varredura na inicialização e a cada 30 minutos apaga vencidos. Um hit verifica
   a validade imediatamente, sem esperar a próxima varredura. Não há renovação
   de prazo por mera inspeção da varredura.
3. **Fim do ciclo:** depois de um download final com recibo de conclusão e bytes
   selados conferidos sob trava, remove do cache a chave do original, preservando
   o selado até expiração/LRU. A remoção ocorre ao retornar os bytes verificados
   pelo executor para a ponte; não comprova recebimento TCP nem persistência no
   semogapp. `get`/polling, selo parcial ou download recusado não removem original.
   O fluxo atual não disponibiliza PDF selado de envelope REJECTED; portanto a
   condição “selado entregue” não ocorre nele e a expiração/LRU continua limpando
   seu original. Se futuramente houver esse download, deverá usar o mesmo gancho.

Adicionalmente, antes de gravar exige **5 GB livres depois da nova escrita**
(`5000000000` bytes). Abaixo disso, deixa de gravar e registra `low-space`;
reavalia espaço na próxima tentativa. Não há reserva de filesystem/quota: outros
processos ainda podem consumir disco entre a consulta e a escrita. Falhas reais
de escrita são tratadas pelo mesmo fallback. Use volume exclusivo por contêiner;
réplicas não devem montar o mesmo diretório de cache.

Diretório `0700`, arquivos novos `0600`, nomes derivados de digests, abertura
com `O_NOFOLLOW`, temporário criado com exclusividade, `sync` e `rename` atômico.
Inicialização rejeita caminho relativo ou que atravesse symlink e remove somente
temporários órfãos com o padrão privado do cache. Falha no meio de uma escrita
não publica arquivo parcial. O diretório é privado do usuário do processo;
um invasor com acesso à própria conta do contêiner continua fora dessa fronteira.

## Configuração para o Claude

Cache é **opt-in**: sem `SEMOG_PDF_CACHE_ENABLED=true`, permanece desligado.
Não foi alterado o compose operacional nem executado deploy. No serviço do
Documenso, adicionar o mount de volume e estas envs:

```yaml
services:
  documenso:
    environment:
      SEMOG_PDF_CACHE_ENABLED: "true"
      SEMOG_PDF_CACHE_DIRECTORY: /var/cache/semog-pdf
      SEMOG_PDF_CACHE_MAX_BYTES: "3000000000"
      SEMOG_PDF_CACHE_IDLE_TTL_HOURS: "72"
      SEMOG_PDF_CACHE_MIN_FREE_BYTES: "5000000000"
      SEMOG_PDF_CACHE_SWEEP_MINUTES: "30"
    volumes:
      - semog-pdf-cache:/var/cache/semog-pdf
volumes:
  semog-pdf-cache:
```

O runner de `docker/Dockerfile` usa UID/GID **1001:1001** (`nodejs`). Antes de
habilitar a flag, o Claude deve criar/preparar a raiz desse volume como
`1001:1001`, modo `0700`, e conferir que o processo consegue escrever nela.
Um named volume vazio montado como root não concede essa escrita automaticamente.
Prover ao menos teto + reserva, cerca de **8 GB disponíveis**, com margem para
o filesystem e outros consumidores. O cache não substitui backup nem retenção R2.
Para rollback imediato do cache, definir `SEMOG_PDF_CACHE_ENABLED=false`; pode
preservar o volume para análise ou removê-lo depois de parar seu único consumidor.
Não remover volume do banco. B não exige env nova nem migração.

## Multipart e ensaio

O candidato isolado `pdf-store-multipart-candidate.ts` envia 4–6 partes em
paralelo, valida checksum SHA-256 de cada parte e checksum composto na conclusão,
e aguarda as partes em andamento antes de abortar em falha. O abort possui prazo
independente de 5 s, inclusive se o prazo do upload já acabou; falha do abort é
reportada junto da falha original. Não é importado pelo host nem pelo store ativo.

A [matriz oficial do R2](https://developers.cloudflare.com/r2/api/s3/api/)
declara SHA-256 composto para multipart; isso não é SHA-256 dos bytes integrais.
O algoritmo composto está descrito no
[tutorial oficial S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/tutorial-s3-mpu-additional-checksums.html).
Não comparamos checksum composto com o hash integral gravado nos recibos.
Para comparar garantias equivalentes, o ensaio mede PUT único + HEAD contra
multipart + GET/hash integral. A decisão de adoção e os números seguem abaixo.

**Decisão C: não adotar multipart no runtime.** Neste modelo, nem o upload
isolado ganhou; com confirmação integral ficou aproximadamente duas vezes mais
lento. Isso não demonstra que multipart nunca ganhe num R2 real com outra
limitação de transporte; qualquer adoção futura exige novo ensaio equivalente.

Ensaio integrado em macOS ARM64, Node 24.21.0, PostgreSQL 17 descartável e SDK S3
real contra HTTP em loopback. O runner extrai o transporte de `4d3fc306` por
`git show` e usa os serviços atuais sem `confirm`/cache para reproduzir a
releitura anterior. Ambos passam por rascunho binário, ativação, quatro
inscrições, quatro manifestações, worker/selagem nativa e download pela ponte.
CMS detached verificado com OpenSSL nos seis PDFs finais. Há checks explícitos
para zero GET no caminho novo quente, não apenas cronômetros.

O PDF sintético válido tem **57.728.494 bytes**, cerca de 55 MiB, com anexo
aleatório não compressível. Não reproduz complexidade visual de uma prestação
escaneada. A latência de corpo é proporcional ao tamanho, nos perfis de
1.000/2.500/4.000 ms por 55.207.556 bytes. HEAD tem atraso de 50 ms; há também
custo local de SDK, cópias, hashes, disco, banco, render e CMS. O candidato C
isolado usa exatamente **55.207.556 bytes**, banda de upload agregada
compartilhada entre partes e 50 ms de base por PUT/UploadPart/GET, além das
chamadas extras de criação/conclusão. Não multiplicamos a banda por seis.

Tempos **em segundos**, antes → depois, uma amostra por perfil:

| Caminho | Perfil 1 s | Perfil 2,5 s | Perfil 4 s |
| --- | ---: | ---: | ---: |
| Envio: draft + 4 inscrições | 7,06 → 1,73 | 16,47 → 3,30 | 26,01 → 5,18 |
| Ativação (separada do envio acima) | 1,12 → 0,05 | 2,67 → 0,06 | 4,27 → 0,10 |
| Manifestação 1 | 1,19 → 0,10 | 2,75 → 0,11 | 4,35 → 0,23 |
| Manifestação 2 | 1,19 → 0,09 | 2,75 → 0,11 | 4,33 → 0,23 |
| Manifestação 3 | 1,17 → 0,10 | 2,73 → 0,12 | 4,31 → 0,24 |
| Manifestação 4 | 1,18 → 0,09 | 2,75 → 0,10 | 4,32 → 0,24 |
| Selagem pelo worker | 3,74 → 1,59 | 8,43 → 3,19 | 13,16 → 5,30 |
| Download pela ponte | 1,16 → 0,07 | 2,74 → 0,07 | 4,33 → 0,11 |

O ciclo completo fez **13 GETs → zero GETs**, aproximadamente **751,6 MB → zero
bytes baixados do R2 sintético**, em todos os perfis. PUTs: dois em ambas as
versões; HEADs: três → cinco. O envio da tabela exclui ativação para respeitar
o recorte solicitado. Selagem inclui upload e confirmação; as etapas internas
não devem ser somadas ao total. Os dois PUTs continuam sendo custo remoto.
Zero GET depende de cache habilitado, aquecido pelos PUTs e HEAD com checksum;
com expiração, despejo, erro local ou HEAD sem checksum, haverá GET legítimo.

C, incluindo confirmação de integridade equivalente, em segundos:

| Perfil | PUT único + HEAD | 4 partes + GET | 5 partes + GET | 6 partes + GET |
| --- | ---: | ---: | ---: | ---: |
| 1 s | 1,32 | 2,46 | 2,54 | 2,47 |
| 2,5 s | 2,77 | 5,44 | 5,40 | 5,41 |
| 4 s | 4,24 | 8,49 | 8,47 | 8,38 |

No perfil 4 s, só upload: PUT único **4,123 s**, multipart 4/5/6 partes
**4,340 / 4,345 / 4,258 s**. Checksums de cada parte e composto da conclusão são
validados na fixture e o GET confere o SHA-256 integral. Isso não certifica
compatibilidade operacional com o R2 real. Teste de falha de parte exige abort
após os concorrentes terminarem e ausência de Complete.

[Evidências JSONL](2026-11-04-pdf-sem-releitura-evidencias.jsonl) contêm os
cronômetros, contagem de requisições/bytes e estágios. A comparação funcional usa
serviços reais diretamente, sem o HTTP público de entrada, rate limit,
transferência semogapp → fork, polling em tempo real ou banco remoto. O baseline
roda primeiro, aquecendo código/CPU/banco; uma amostra por perfil não estima
variância. Há outros trabalhos na máquina. Os números não preveem produção;
a eliminação de GETs é a evidência determinística.

Duas tentativas preliminares foram descartadas por falhas do harness: contador
ausente no banco descartável e caminho macOS via symlink, corretamente recusado
pelo cache. O harness foi corrigido, passou a exigir GET zero e repetiu os três
perfis completos. Os dados C usados na tabela vêm da execução isolada com
latência base igualada entre PUT único e partes.

Reprodução, sem produção nem `.env`:

```sh
SEMOG_PG_BIN=/opt/homebrew/bin SEMOG_OPENSSL_BIN=/opt/homebrew/bin/openssl node node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-pdf-storage-local.ts
node node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-pdf-multipart-local.ts --run
```

O ensaio desativa **somente na fixture** a reserva de disco (`minFreeBytes: 0`)
para não depender do espaço disponível da máquina; os testes específicos cobrem
falta de espaço e os defaults operacionais não são relaxados. Diretórios,
certificado efêmero, PDFs e bancos descartáveis são removidos no `finally`.


## Verificação e publicação

Portões finais executados com dependências do lockfile (`npm ci`, sem alterar
lockfile) e Prisma gerado usando URLs fictícias em loopback, sem migração nesse
passo. Node 24.21.0, npm 11.19.0. Nenhum build executado.

- Biome no escopo exato da CI: aprovado; os quatro scripts novos também aprovados.
- `tsconfig.semog-signing.json`: TypeScript aprovado, incluindo testes e scripts.
- Vitest da ponte: **37 arquivos, 360 testes aprovados**.
- Patches nativos Node: **33/33 aprovados**.
- Processo HTTP real em loopback: rotas, middleware, default-off e autenticação
  antes do corpo aprovados.
- Rodadas com PostgreSQL descartável: selos parciais, concorrência, prorrogação,
  contato, cancelamento, operações pendentes/vencidas e mutantes das guardas
  aprovados. Nenhum banco/processo exclusivo restou na conferência final.
- Ensaio de desempenho: seis fluxos reais completos e seis verificações CMS
  detached via OpenSSL, além do candidato multipart isolado.
- `git diff --check`: aprovado. Sem PDFs ou certificados versionados.

Os 17 testes do módulo de cache cobrem corrupção, despejo LRU, arquivo maior que
o teto, desligado sem I/O, concorrência e cópias isoladas, falha real no meio da
escrita temporária, órfãos, TTL padrão/expiração após restart, varredura periódica,
reserva mínima de disco, diretório indisponível, isolamento por bucket, traversal,
symlink e invalidação durante leitura em andamento. A configuração por env tem
casos para defaults e limites inválidos. Testes de ciclo verificam que polling
ou download indisponível não libera original e que falha da limpeza não impede
entregar PDF já conferido.

Testes S3 com HTTP real comprovam seed após PUT, ausência de seed após PUT falho,
hit sem GET, checksum ausente/HEAD501 com cache quente ainda usando GET remoto,
403 preservado, checksum/tamanho divergentes, replay por HEAD e coalescing entre
leitura de consumo e confirmação. A confirmação pós-selagem testa divergência,
regravação, nova confirmação e compatibilidade de stores sem `confirm`. O teste
multipart valida os hashes das partes e o checksum composto exato; falha numa
parte aborta somente depois dos concorrentes, sem concluir upload.

Houve revisão independente por áreas: implementador de B revisou A e a
integração; implementador de A revisou B e o ensaio/candidato C. Sem bloqueantes
restantes. A principal repetiu os portões finais, HTTP e rodadas no processo real.

```sh
node node_modules/@biomejs/biome/bin/biome check packages/lib/server-only/semog-signing apps/remix/server/semog-signing-host.ts apps/remix/server/semog-signing-routes.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.semog-signing.json
node node_modules/vitest/vitest.mjs run --config packages/lib/vitest.config.ts --maxWorkers=2 packages/lib/server-only/semog-signing
node --test apps/remix/app/utils/semog-recipient.test.mjs apps/remix/app/utils/recipient-remark.test.mjs apps/remix/app/utils/remark-page.test.mjs packages/lib/client-only/hooks/load-signature-font.test.mjs
node node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-host-local.ts
SEMOG_PG_BIN=/opt/homebrew/bin SEMOG_OPENSSL_BIN=/opt/homebrew/bin/openssl node node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-rounds-local.ts
```


**Aviso antes do merge:** o Claude valida o PR e repassa a autorização do
Leandro. Este trabalho abre PR e não faz merge. Merge/publicação de imagem,
deploy por digest e criação/permissões do volume operacional cabem ao Claude,
após autorização. Nenhum acesso a produção foi utilizado neste trabalho.
