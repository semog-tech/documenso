# Agent Guidelines for Documenso

## Build/Test/Lint Commands

- `npm run build` - Build all packages
- `npm run lint` - Lint all packages
- `npm run lint:fix` - Auto-fix linting issues
- `npm run test:e2e` - Run E2E tests with Playwright
- `npm run test:dev -w @documenso/app-tests` - Run single E2E test in dev mode
- `npm run test-ui:dev -w @documenso/app-tests` - Run E2E tests with UI
- `npm run format` - Format code with Biome
- `npm run dev` - Start development server for Remix app

**Important:** Do not run `npm run build` to verify changes unless explicitly asked. Builds take a long time (~2 minutes). Use `npx tsc --noEmit` for type checking specific packages if needed.

## Code Style Guidelines

- Use TypeScript for all code; prefer `type` over `interface`
- Use functional components with `const Component = () => {}`
- Never use classes; prefer functional/declarative patterns
- Use descriptive variable names with auxiliary verbs (isLoading, hasError)
- Directory names: lowercase with dashes (auth-wizard)
- Use named exports for components
- Never use 'use client' directive
- Never use 1-line if statements
- Structure files: exported component, subcomponents, helpers, static content, types

## Error Handling & Validation

- Use custom AppError class when throwing errors
- When catching errors on the frontend use `const error = AppError.parse(error)` to get the error code
- Use early returns and guard clauses
- Use Zod for form validation and react-hook-form for forms
- Use error boundaries for unexpected errors

## UI & Styling

- Use Shadcn UI, Radix, and Tailwind CSS with mobile-first approach
- Use `<Form>` `<FormItem>` elements with fieldset having `:disabled` attribute when loading
- Use Lucide icons with longhand names (HomeIcon vs Home)

## TRPC Routes

- Each route in own file: `routers/teams/create-team.ts`
- Associated types file: `routers/teams/create-team.types.ts`
- Request/response schemas: `Z[RouteName]RequestSchema`, `Z[RouteName]ResponseSchema`
- Only use GET and POST methods in OpenAPI meta
- Deconstruct input argument on its own line
- Prefer route names such as get/getMany/find/create/update/delete
- "create" routes request schema should have the ID and data in the top level
- "update" routes request schema should have the ID in the top level and the data in a nested "data" object

## Translations & Remix

- Use `<Trans>string</Trans>` for JSX translations from `@lingui/react/macro`
- Use `t\`string\`` macro for TypeScript translations
- Use `(params: Route.Params)` and `(loaderData: Route.LoaderData)` for routes
- Directly return data from loaders, don't use `json()`
- Use `superLoaderJson` when sending complex data through loaders such as dates or prisma decimals

## Fork Semog

Este repositório é o fork da Semog (`sign.semog.com.br`), motor das assinaturas do semogapp.
Tudo acima desta seção, `.agents/skills/` e `.cursorrules` vêm do upstream: não reescreva, para
não criar conflito a cada sincronização. Instruções da Semog ficam só nesta seção.

**Branches.** Produção é `leandrosemog/documenso-2.18` (tag upstream `v2.18.0` + commits
Semog). `main` é espelho antigo do upstream e não recebe trabalho Semog. Abra PR sempre contra
`leandrosemog/documenso-2.18`: PR contra `main` dispara a CI pesada do upstream. O título
segue Conventional Commits (`Validate PR Name`), com escopo `semog`: `fix(semog): ...`.

**O que a Semog mudou.**

- A ponte `/api/semog/v1/*` (rascunho, ativação, inscrições, manifestações, selo parcial,
  prorrogação, contato, cancelamento): `packages/lib/server-only/semog-signing/`, montada por
  `apps/remix/server/semog-signing-host.ts` e `semog-signing-routes.ts`. Desligada sem
  `SEMOG_SIGNING_ENABLED` e `SEMOG_SIGNING_WORKER_ENABLED`.
- A guarda `semog_bridge.guard_native_mutation()` e o schema `semog_bridge`, em `db/*.sql`
  (cada um com `.down.sql`), aplicados à mão no banco do Documenso, fora do Prisma. A guarda
  recusa mutação nativa (editar, cancelar, assinar pela rota nativa) em envelope com inscrição
  ativa e se desarma quando todas as inscrições são revogadas.
- Jobs nativos (lembrete, expiração, varredura de selagem) pulam envelopes da ponte
  (`activation-ownership.ts`); certificado e auditoria em pt-BR (`semog-pdf-ptbr.ts`);
  idioma do documento, fonte Saira e tema claro na página do destinatário.

O cliente da ponte no semogapp é `server/documenso/` (`ponteAssinatura.ts`,
`envelopeRascunho.ts`, `envelopeAtivacao.ts`), com contrato em
`docs/documenso/ponte-assinatura-semog.md` daquele repositório. Mudou contrato aqui, mude lá.

**Verificação** (o mesmo que `.github/workflows/semog-check.yml` roda; Node 24, npm, sem pnpm):

```bash
npm ci && npm run prisma:generate --workspace @documenso/prisma
node node_modules/@biomejs/biome/bin/biome check packages/lib/server-only/semog-signing apps/remix/server/semog-signing-host.ts apps/remix/server/semog-signing-routes.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.semog-signing.json
node node_modules/vitest/vitest.mjs run --config packages/lib/vitest.config.ts packages/lib/server-only/semog-signing
node --test apps/remix/app/utils/semog-recipient.test.mjs apps/remix/app/utils/recipient-remark.test.mjs apps/remix/app/utils/remark-page.test.mjs packages/lib/client-only/hooks/load-signature-font.test.mjs
# contra PostgreSQL real, fora da CI (os testes acima são mocks):
SEMOG_PG_BIN=/opt/homebrew/bin node node_modules/vite-node/vite-node.mjs --config packages/lib/vitest.config.ts scripts/semog-signing-rounds-local.ts
```

**Guarda.** Operação nova que muda envelope inscrito segue o padrão durável: recibo com
`transacao xid8`, `set_config('semog_bridge.<x>_key')` e um ramo estreito na guarda (como
`contact_allows`, `extension_allows`, `cancel_allows`). Toda migração nova recria a guarda
inteira, então o ensaio dos ramos antigos precisa da guarda da migração mais recente. A
ordem de aplicação e os pré-requisitos estão em `docs/semog-signing-host.md`.

**Deploy.** O merge em `leandrosemog/documenso-2.18` roda os checks e publica
`ghcr.io/semog-tech/documenso:sha-<commit>`, mesmo para mudança só de docs; não faz deploy.
No droplet (`ssh semog`), `/opt/documenso/docker-compose.yml` fixa a imagem por digest:
antes de trocar, faça backup do banco (`documenso-documenso-db-1`, em
`/opt/documenso/backups/`) e confira `select estado, count(*) from semog_bridge.outbox
group by 1` sem pendentes; depois troque o digest e rode `docker compose up -d documenso`. A
imagem roda `prisma migrate deploy` ao subir. O contêiner não publica porta: a saúde se
confere com `curlimages/curl` na rede `shared-network` contra
`http://documenso-documenso-1:3000/api/health`.

**Sincronizar com o upstream.** Crie uma branch a partir da tag oficial nova, faça
`git merge --no-ff` da branch de produção (merge, não rebase, para preservar o histórico dos
patches) e resolva conflitos mantendo as novidades do upstream. Antes da troca, restaure um
dump do banco num Postgres descartável e ensaie as migrações Prisma novas junto da guarda:
migração upstream que mexe nas tabelas vigiadas por ela (`Envelope`, `EnvelopeItem`,
`Recipient`, `Field`, `Signature`, `DocumentData`, `DocumentMeta`, `EnvelopeAttachment`) pode
colidir com a guarda. Rode a verificação acima e o ensaio contra Postgres. O registro da atualização para a
2.18 está em `docs/superpowers/plans/2026-09-09-documenso-2.18.md`.
