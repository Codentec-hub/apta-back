# SIEG — Fase A: Fundação de Autenticação (JWT do sistema) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dado o `client_id`/`secret_key` emitidos pelo SIEG, o apta-back consegue obter, cachear e renovar automaticamente o JWT do sistema — pré-requisito de qualquer chamada à API do SIEG nas fases seguintes (OAuth por cliente, sincronização de XMLs).

**Architecture:** Segue o padrão já usado em `ConfiguracaoGemini`/`ConfiguracaoEvolution`: credenciais ficam numa tabela própria (editável pela tela, sem redeploy), com fallback pras variáveis de ambiente. A lógica de autenticação SIEG fica isolada em `src/sieg/` (fora de `routes/`), com o JWT cacheado em memória do processo (não precisa de tabela — vive só 24h e há um único processo Node por ambiente). Uma rota nova expõe configuração + diagnóstico, reaproveitando a máscara de segredo já usada pros outros provedores.

**Tech Stack:** Node/TypeScript, Express, Prisma, Zod — sem dependências novas (usa `fetch` nativo do Node).

**Spec:** Pesquisa técnica da API oficial SIEG feita nesta conversa (docs oficiais em `integracoes.sieg.com/sistema-externo/docs/*`) + doc "Integração Fiscal Apta — Levantamento de Requisitos" (Claude Docs, projeto `6ba299ef-0564-4c3a-846b-47181c76d7d7`).

## Global Constraints

- Sem framework de testes automatizados no projeto (nenhum `*.test.ts`, nenhum `vitest`/`jest` no `package.json`) — este plano usa **passos de verificação manual** (rota de diagnóstico + chamada real) em vez de testes unitários, pra não introduzir infraestrutura de teste nova sem o aval do Marcus.
- Endpoint de autenticação: `POST https://api.sieg.com/api/v1/create-jwt`, headers `X-Client-Id` / `X-Secret-Key`, resposta `{"Token": "..."}`.
- Validade do JWT: 24h — reutilizar até expirar, não gerar um novo a cada chamada (a cota de rate limit é apertada: 2 req/min **por API Key, somando todos os clientes**).
- Uso subsequente: header `Authorization: Bearer {JWT}`.
- A chave hoje em `.env` (`SIEG_API_KEY`) é do formato antigo, descontinuado (prazo final 30/09/2026, já passado) — não é reaproveitável. As credenciais novas são as que o Marcus já tem (`client_id`/`secret_key` do app "APTA_INTEGRATION" no painel do SIEG) — ver conversa, não repetidas aqui pra não ficarem em texto puro no histórico do git.
- Seguir o estilo do projeto: nomes em português, comentários só pra "porquê" não-óbvio, scheduler via `setInterval(...).unref()` (não trazer `node-cron`/`bullmq`).

## Review Focus

- Credenciais ausentes (nem banco, nem env) → erro claro ("SIEG não configurado"), não exceção genérica de `fetch`/`undefined`.
- Duas chamadas simultâneas pedindo token ao mesmo tempo, sem token em cache ainda → não disparar dois `create-jwt` em paralelo (desperdiça cota de um rate limit já apertado); a segunda chamada deve esperar a primeira.
- Token expirando no meio de uma rajada de uso → renovar com margem de segurança (ex.: 1h antes de vencer), não exatamente no segundo do vencimento.
- SIEG fora do ar ou devolvendo 401/429/503 no `create-jwt` → logar e devolver erro tratável, não derrubar o processo nem travar em loop de retry.
- Segredo (`secretKey`) nunca deve aparecer em log, resposta de API ou nas rotas GET (mesma máscara usada em Gemini/Evolution).

---

## File Structure

- `prisma/schema.prisma` — novo modelo `ConfiguracaoSieg` (credenciais do sistema).
- `src/sieg/auth.ts` — **novo**: lógica de obtenção/cache/renovação do JWT (`obterTokenSistema`).
- `src/routes/configuracoes-sieg.ts` — **novo**: GET/PUT da configuração (mesma UX de Gemini/Evolution) + GET de diagnóstico (`/configuracoes/sieg/status`).
- `src/server.ts` — registra o novo router.
- `.env` — troca `SIEG_API_KEY` por `SIEG_CLIENT_ID`/`SIEG_SECRET_KEY` (passo manual de deploy, arquivo não versionado).

---

### Task 1: Modelo `ConfiguracaoSieg` no Prisma

**Files:**
- Modify: `prisma/schema.prisma` (inserir após o modelo `ConfiguracaoEvolution`, por volta da linha 528)

**Interfaces:**
- Produces: `prisma.configuracaoSieg` (Prisma Client), registro único `id = 1`, campos `clientId: string | null`, `secretKey: string | null`.

- [ ] **Step 1: Adicionar o modelo**

```prisma
// Credenciais do sistema (Apta) emitidas pelo SIEG no cadastro como
// integrador. Tem prioridade sobre SIEG_CLIENT_ID/SIEG_SECRET_KEY do
// ambiente, igual ao padrão de ConfiguracaoGemini/ConfiguracaoEvolution.
model ConfiguracaoSieg {
  id        Int      @id @default(1)
  clientId  String?  @map("client_id")
  secretKey String?  @map("secret_key")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@map("configuracao_sieg")
}
```

- [ ] **Step 2: Gerar e aplicar a migração**

Run: `npm run prisma:migrate -- --name add_configuracao_sieg`
Expected: migração criada em `prisma/migrations/` e aplicada sem erro no banco local.

- [ ] **Step 3: Regenerar o client**

Run: `npm run prisma:generate`
Expected: sem erro; `prisma.configuracaoSieg` disponível no client gerado.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(sieg): adiciona modelo de configuracao do sistema"
```

---

### Task 2: Módulo de autenticação (`src/sieg/auth.ts`)

**Files:**
- Create: `src/sieg/auth.ts`

**Interfaces:**
- Consumes: `prisma.configuracaoSieg.findUnique({ where: { id: 1 } })` (Task 1); `process.env.SIEG_CLIENT_ID`, `process.env.SIEG_SECRET_KEY` como fallback.
- Produces: `export async function obterTokenSistema(): Promise<string>` — devolve o JWT válido (busca novo se não houver cache ou estiver perto de vencer); lança erro com mensagem clara se não houver credenciais ou se o SIEG rejeitar.
- Produces: `export async function credenciaisConfiguradas(): Promise<boolean>` — usado pela rota de status/diagnóstico.

- [ ] **Step 1: Implementar cache em memória do módulo**

Variável de módulo `let cache: { token: string; expiraEm: number } | null = null` e `let emAndamento: Promise<string> | null = null` (pra evitar duas chamadas simultâneas a `create-jwt` — ver Review Focus). Margem de renovação: considerar o token vencido 1h antes do fim real das 24h.

- [ ] **Step 2: Implementar `obterTokenSistema()`**

Lógica: se `cache` válido (dentro da margem), devolve `cache.token`. Senão, se já existe `emAndamento`, aguarda essa mesma Promise (não dispara uma segunda chamada). Senão, busca `clientId`/`secretKey` (banco com fallback pro ambiente); se nenhum dos dois tiver valor, lança `Error("SIEG não configurado: defina client_id e secret_key em Configurações > Integrações ou nas variáveis SIEG_CLIENT_ID/SIEG_SECRET_KEY")`. Chama `POST https://api.sieg.com/api/v1/create-jwt` com headers `X-Client-Id`/`X-Secret-Key`; em resposta não-OK, lança erro incluindo o status HTTP; em sucesso, grava `cache` e devolve `Token`.

- [ ] **Step 3: Implementar `credenciaisConfiguradas()`**

Verifica (banco ou ambiente) se `clientId` e `secretKey` existem e não são string vazia; não faz chamada de rede.

- [ ] **Step 4: Verificação manual**

Com `SIEG_CLIENT_ID`/`SIEG_SECRET_KEY` (ou os valores salvos via Task 3) configurados, rodar `npm run dev` e, num script/REPL temporário (`node --import tsx -e "..."` ou rota de diagnóstico da Task 3), chamar `obterTokenSistema()` duas vezes em seguida.
Expected: primeira chamada bate na API do SIEG e devolve um JWT (string não vazia); segunda chamada devolve o mesmo valor sem novo log de requisição (confirma o cache).

- [ ] **Step 5: Commit**

```bash
git add src/sieg/auth.ts
git commit -m "feat(sieg): modulo de obtencao e cache do JWT do sistema"
```

---

### Task 3: Rotas de configuração e diagnóstico

**Files:**
- Create: `src/routes/configuracoes-sieg.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `obterTokenSistema`, `credenciaisConfiguradas` (Task 2); `podeAlterar`/`mascarar` (mesmo padrão de `configuracoes-integracao.ts:17-24` — duplicar as duas funções de ~8 linhas aqui, igual o arquivo de Gemini/Evolution já faz por domínio, em vez de criar um módulo compartilhado só pra isso).
- Produces: router `configuracoesSiegRouter` com `GET /configuracoes/sieg`, `PUT /configuracoes/sieg`, `GET /configuracoes/sieg/status`, protegidas por `autenticar`.

- [ ] **Step 1: `GET /configuracoes/sieg`**

Mesmo formato de `configuracoes-integracao.ts:26-34`: devolve `{ clientIdConfigurado: boolean, secretKeyMascarada: string | null, origem: "banco" | "ambiente" | "nenhuma" }` — nunca o valor em texto puro do `secretKey`, e o `clientId` pode ir em texto puro (não é segredo, é identificador).

- [ ] **Step 2: `PUT /configuracoes/sieg`**

Schema Zod `{ clientId: z.string().trim().min(1).optional(), secretKey: z.string().trim().min(1).optional() }`; só ADMIN/GESTOR (`podeAlterar`); `upsert` em `configuracaoSieg` (`id: 1`); responde `204`. Igual ao `PUT /configuracoes/gemini` (`configuracoes-integracao.ts:41-57`).

- [ ] **Step 3: `GET /configuracoes/sieg/status`**

Chama `credenciaisConfiguradas()`; se falso, devolve `{ ok: false, erro: "Credenciais não configuradas" }`. Se verdadeiro, tenta `obterTokenSistema()` dentro de um `try/catch`; sucesso devolve `{ ok: true }`, falha devolve `{ ok: false, erro: <mensagem> }` (nunca o token). Esta é a rota que o botão "Configurar"/"Testar conexão" da tela de Integrações vai chamar na Fase E.

- [ ] **Step 4: Registrar o router**

Em `src/server.ts`, importar e usar `configuracoesSiegRouter` ao lado de `configuracoesIntegracaoRouter` (mesmo bloco de imports/uso, por volta da linha 21/41 do arquivo atual).

- [ ] **Step 5: Verificação manual**

Com o servidor rodando e autenticado (token de usuário Apta): `PUT /configuracoes/sieg` com o `client_id`/`secret_key` novos → `204`. `GET /configuracoes/sieg` → `clientIdConfigurado: true`, `secretKeyMascarada` no formato `••••••••<4 últimos chars>`. `GET /configuracoes/sieg/status` → `{ ok: true }`.
Expected: os três resultados acima, confirmando que a credencial nova funciona de ponta a ponta contra a API real do SIEG.

- [ ] **Step 6: Commit**

```bash
git add src/routes/configuracoes-sieg.ts src/server.ts
git commit -m "feat(sieg): rotas de configuracao e diagnostico do sistema"
```

---

### Task 4: Atualizar o `.env` e aposentar a chave antiga

**Files:**
- Modify: `.env` (local e nas variáveis do EasyPanel em produção — fora do controle de versão)

**Interfaces:**
- Consumes: nada de código novo — é o fallback de ambiente lido pela Task 2.

- [ ] **Step 1: Trocar a variável**

Remover `SIEG_API_KEY` e adicionar `SIEG_CLIENT_ID`/`SIEG_SECRET_KEY` com os valores do app "APTA_INTEGRATION" (já compartilhados na conversa — não repetidos aqui em texto puro) (mesmo comentário de contexto que já existe acima da linha, mantido).

- [ ] **Step 2: Repetir no EasyPanel**

Atualizar as mesmas duas variáveis no ambiente do apta-back em produção e redeployar.

- [ ] **Step 3: Verificação manual**

Repetir o `GET /configuracoes/sieg/status` da Task 3, Step 5, agora em produção (sem precisar do `PUT`, já que veio do ambiente).
Expected: `{ ok: true }`.

- [ ] **Step 4: Commit**

Nenhum commit — `.env` não é versionado. Se quiser documentar a troca, atualizar o comentário correspondente em `CONTEXT.md` (fica pra quando a Fase A estiver fechada, junto com o resto da integração).

---

## Self-Review

1. **Cobertura do objetivo da Fase A**: obter token ✅ (Task 2), cachear/evitar chamada duplicada ✅ (Task 2, Step 1-2), configurar credencial sem redeploy ✅ (Task 3), substituir a chave antiga quebrada ✅ (Task 4). Tudo que a Fase A promete está coberto.
2. **Steps**: cada step tem uma única coisa ambígua resolvida (assinatura, arquivo, valor exato) — nenhum "tratar erros apropriadamente" solto; os poucos corpos de função descritos (Task 2, Step 2) são porque a lógica de cache/espera não é determinada só pela assinatura.
3. **Consistência de tipos**: `obterTokenSistema(): Promise<string>` é o único nome usado nas Tasks 2 e 3 — confirmado igual nas duas.
4. **Review Focus**: as 5 situações listadas (credencial ausente, chamada duplicada, expiração na borda, SIEG fora do ar, segredo exposto) têm step de implementação ou verificação dedicado (Task 2 Steps 1-2, Task 3 Step 1/3).
5. **Proporção**: plano do tamanho da pesquisa que o originou (4 tasks pequenas pra um módulo de ~60-80 linhas de código) — não virou transcrição de código; os corpos ficaram em prosa, não em blocos prontos, exceto o schema Prisma (que é puramente declarativo).

---

## O que vem depois da Fase A (mapeamento das próximas fases — ainda não planejadas em detalhe)

- **Fase B — Onboarding OAuth**: gerar o link `AuthorizeAccess.aspx`, rota de callback, troca token temporário → definitivo. **Correção (01/11, validado ao vivo na tela de consentimento do SIEG): é uma autorização única por conta Apta, não por cliente/CNPJ** — sem seletor de empresa na tela, só "Empresa: APTA SERVICOS DE GESTAO E CONTABILIDADE LTDA". O token guardado é um campo a mais em `ConfiguracaoSieg` (não uma tabela `Cliente ↔ token`). Detalhado em `docs/superpowers/plans/2026-11-01-sieg-fase-b-oauth.md`. Depende da Fase A.
- **Fase C — Renovação automática**: job `setInterval` (mesmo padrão de `alerta-nao-lida.ts`/`gerar-entregas.ts`) que roda ~1x/dia e renova, via endpoint `refresh`, os tokens de cliente perto de vencer (30 dias). Falta confirmar o formato exato da chamada de `refresh` antes de detalhar esta fase.
- **Fase D — Sincronização de XMLs**: fila única e sequencial (por causa do rate limit de 2 req/min **global**, não por cliente) que percorre os clientes autorizados chamando `Baixar XMLs`, grava as notas no banco. Dimensionamento depende de confirmar se são ~400 clientes (CONTEXT.md) ou ~3 mil (número citado na conversa) — isso muda o tempo de uma volta completa na fila.
- **Fase E — Painel**: trocar o card mockado do SIEG em `integracoes-grid.tsx` por status real (usa o `GET /configuracoes/sieg/status` da Fase A) + tela por cliente mostrando se está autorizado/expirando.
- **Fase F — Casos de uso**: a automação de parcelamento em lote do SIEG (citada no CONTEXT.md como o ganho de produtividade já identificado, hoje feito manualmente em ~60 dos clientes ativos) é o consumidor natural dos dados da Fase D.

---

**Nota sobre a regra do CONTEXT.md:** o arquivo documenta "só construir o que não depende de integração externa (SIEG...) — fica para quando o usuário quiser destravar." Como foi você mesmo que pediu pra destravar a parte fiscal e pesquisou a API a fundo nesta conversa, estou assumindo que essa decisão já foi tomada do lado do cliente. Só confirme se não for o caso antes de eu avançar pra Fase B.
