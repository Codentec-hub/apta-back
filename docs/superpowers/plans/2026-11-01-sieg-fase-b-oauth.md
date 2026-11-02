# SIEG — Fase B: Onboarding OAuth (token de conta) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O apta-back consegue completar o fluxo OAuth 2.0 do SIEG — receber o token temporário (callback), trocá-lo pelo token definitivo (30 dias) e guardá-lo — para que as fases seguintes (C: renovação, D: sincronização de XMLs) tenham um `X-OAuth-Token` válido para usar.

**Architecture:** Confirmado nesta conversa, ao vivo, na própria tela de consentimento do SIEG (`AuthorizeAccess.aspx`): a autorização é **única, por conta Apta inteira** — a tela mostra só "Empresa: APTA SERVICOS DE GESTAO E CONTABILIDADE LTDA", sem seletor de CNPJ/cliente. Isso descarta a ideia (do plano da Fase A, desatualizado nesse ponto) de uma tabela `Cliente ↔ token`: o token OAuth é um dado de conta, do mesmo tamanho que `client_id`/`secret_key` da Fase A — então ele entra como campos novos no mesmo registro `ConfiguracaoSieg` (id=1), não numa tabela nova. Um admin inicia o fluxo clicando um link no próprio painel da Apta; o SIEG redireciona pro navegador dele com o token temporário; uma rota pública de callback troca esse token pelo definitivo e salva.

**Tech Stack:** Node/TypeScript, Express, Prisma — mesmo padrão da Fase A, sem dependências novas.

**Spec:** Pesquisa técnica da API oficial SIEG (`integracoes.sieg.com/sistema-externo/docs/o-auth`) + validação ao vivo da tela de consentimento nesta conversa + `docs/superpowers/plans/2026-10-31-sieg-fase-a-autenticacao.md` (Fase A, já implementada, PR #1 aberto).

## Global Constraints

- URL de autorização: `https://app.sieg.com/AuthorizeAccess.aspx?clientId={clientId}&state={state}&accessLevel={read|write|fullAccess}`.
- `accessLevel` inicial: **`read`** (é tudo que a Fase D precisa; reautorizar com `write`/`fullAccess` só quando a Fase F exigir — princípio do menor privilégio, decidido com o Marcus).
- Token temporário: validade 10 minutos, chega na URL de callback.
- Token definitivo: validade 30 dias, trocado via endpoint `generate-token`; deve ser renovado via `refresh` (**isso é a Fase C, não esta**) ou revogado via `revoke`.
- **Sem framework de testes automatizados no projeto** (mesma constraint da Fase A) — verificação por chamada manual/rota de diagnóstico.
- **Quem clica "Autorizar Acesso" na interface do SIEG é o Marcus, nunca a IA** — a Task 4 é um roteiro guiado pra ele, não uma automação de clique.
- Nunca logar o token OAuth (nem parcial) em console/erro — mesma regra de segredo da Fase A (`secretKey`).
- Dev local precisa do Docker Desktop + Postgres (`docker compose up -d postgres`) rodando antes de migrar — estavam desligados no fim da sessão anterior.
- Segue o estilo do projeto: nomes em português, rotas públicas registradas como `entregaPublicaRouter`/`whatsappWebhookRouter` (antes dos routers autenticados, `server.ts`), já que o callback do SIEG chega sem o `Authorization` da nossa própria API.

## Review Focus

- `state` ausente ou incompatível no callback → rejeitar (proteção contra CSRF/token de outra sessão), nunca trocar um token temporário sem validar a origem.
- Callback chamado sem `client_id`/`secret_key` do sistema configurados (Fase A não concluída/配置 perdida) → erro claro, não exceção genérica.
- `generate-token` falhando (SIEG fora do ar, token temporário já expirado pelos 10 minutos) → página de callback mostra erro legível pro admin, não trava nem expõe stack trace.
- Callback chamado duas vezes com o mesmo `state` (usuário atualiza a página) → segunda chamada não deve tentar trocar um token temporário já consumido como se fosse novo; tratar como "já autorizado" sem crashar.
- Alguém tentando acessar `/sieg/oauth/callback` diretamente, sem nunca ter passado por `/sieg/oauth/autorizar` (sem `state` conhecido) → rejeitar com mensagem clara, não processar.

---

## File Structure

- `prisma/schema.prisma` — adiciona `oauthToken`/`oauthExpiraEm` ao modelo `ConfiguracaoSieg` (existente, da Fase A).
- `src/sieg/oauth.ts` — **novo**: geração/validação de `state`, montagem da URL de autorização, troca do token temporário pelo definitivo (`generate-token`), getter `obterTokenOAuth()`.
- `src/routes/sieg-oauth.ts` — **novo**: `GET /sieg/oauth/autorizar` (autenticado, redireciona pro SIEG) e `GET /sieg/oauth/callback` (público, troca e salva).
- `src/server.ts` — registra o novo router (o `callback` na seção pública, junto de `entregaPublicaRouter`).

---

### Task 1: Confirmar os dois pontos em aberto antes de codar

Isso não é código — é verificação ao vivo (leitura), necessária pra Task 2/3 não serem feitas no escuro. Pode ser feita por mim (leitura da documentação/painel) sem precisar do Marcus, exceto onde indicado.

- [ ] **Step 1: Confirmar a URL de callback já registrada pro `client_id` da Apta**

Reler a página `https://integracoes.sieg.com/sistema-externo/docs/cadastro` (sub-página "Formulário" ou "Aprovação", ainda não lidas) e/ou a tela de "Configurações > Integrações" da conta SIEG (`app.sieg.com/configuracoes/integracoes`) procurando onde a URL de callback foi informada no cadastro do sistema externo "Apta Sistema de Gestão e Contabilidade".
Expected: uma URL de callback exata (ex.: algo em `api.contabilidadeapta.com.br/...`) ou a confirmação de que ainda não foi cadastrada (nesse caso, Step 2 muda: primeiro cadastrar `https://api.contabilidadeapta.com.br/sieg/oauth/callback` no painel do SIEG, com o Marcus).

- [ ] **Step 2: Confirmar o formato exato do endpoint `generate-token`**

Ler a documentação oficial do endpoint `generate-token` (procurar em `integracoes.sieg.com/sistema-externo/docs/o-auth` — a "Demonstração" listada no menu lateral, não aberta ainda — ou o endpoint correspondente em "Endpoints disponíveis"). Registrar: método HTTP, URL exata, nome do parâmetro que carrega o token temporário (query, header ou corpo), se precisa do JWT do sistema (`Authorization: Bearer`) junto, e o formato da resposta (token definitivo + validade).
Expected: specificação completa o bastante pra escrever `trocarTokenTemporario()` na Task 2 sem adivinhar.

- [x] **Step 3: Anotar os dois achados nesta seção do plano**

**Achado 1 (URL de callback)**: não está visível em nenhuma tela do painel self-service (conferido em "Configurações > Integrações", inclusive o painel "Editar" de cada chave). Mensagem enviada ao chat de suporte do SIEG perguntando qual URL está cadastrada e sugerindo `https://api.contabilidadeapta.com.br/sieg/oauth/callback` — sem resposta ainda. Achado posterior, na página "Demonstração" do `generate-token` (abaixo): o corpo da chamada tem um campo `RedirectUri`, ou seja, a URL é enviada pela Apta em cada troca, não é só uma checagem contra um valor fixo cadastrado — então a Task 4 testa isso diretamente com a URL de produção, sem precisar esperar o suporte confirmar antes.

**Achado 2 (formato do `generate-token`)**: encontrado em `integracoes.sieg.com/sistema-externo/docs/oauth-v-engine` (página "Demonstração" sob Autenticação > OAuth 2.0 > Demonstração — um Swagger/OpenAPI interativo, igual ao que a Fase A já tinha usado pro `create-jwt`). Três endpoints confirmados:
- `POST https://api.sieg.com/api/v1/oauth/generate-token` — headers `X-Client-Id`/`X-Secret-Key` (não o JWT do sistema), corpo `{ "AccessToken": string, "State": string, "RedirectUri": string }`, resposta `{ IsSuccess, ErrorMessage, StatusCode, Data, IsFailure }` (o token definitivo fica dentro de `Data`, cujo schema exato a doc não detalha — assumido como `Data.Token`/`Data.AccessToken` até a Task 4 confirmar).
- `POST https://api.sieg.com/api/v1/oauth/refresh` — mesmos headers, corpo `{ "Token": string }` (útil pra Fase C).
- `POST https://api.sieg.com/api/v1/oauth/revoke` — mesmos headers, corpo `{ "Token": string }`.

Isso corrige a suposição original da Task 2 (que tinha usado `Authorization: Bearer` com o JWT do sistema, por convenção com o `create-jwt` — errado). Código já corrigido em `src/sieg/oauth.ts` e `src/sieg/auth.ts` (exportado `obterCredenciais`).

---

### Task 2: Campos no Prisma + módulo `src/sieg/oauth.ts`

**Files:**
- Modify: `prisma/schema.prisma` (modelo `ConfiguracaoSieg`, adicionado na Fase A)
- Create: `src/sieg/oauth.ts`

**Interfaces:**
- Consumes: `obterTokenSistema()` de `src/sieg/auth.ts` (Fase A) — o `generate-token` provavelmente exige o JWT do sistema também (confirmar na Task 1).
- Produces: `export function montarUrlAutorizacao(state: string, accessLevel: "read" | "write" | "fullAccess"): string`; `export function gerarState(): string`; `export async function trocarTokenTemporario(tokenTemporario: string): Promise<void>` (troca e já salva no banco); `export async function obterTokenOAuth(): Promise<string>` (lê do banco, lança erro claro se ausente/expirado pedindo reautorização — **sem** auto-renovar, isso é Fase C).

- [ ] **Step 1: Adicionar os campos no modelo `ConfiguracaoSieg`**

```prisma
model ConfiguracaoSieg {
  id            Int       @id @default(1)
  clientId      String?   @map("client_id")
  secretKey     String?   @map("secret_key")
  oauthToken    String?   @map("oauth_token")
  oauthExpiraEm DateTime? @map("oauth_expira_em")
  updatedAt     DateTime  @updatedAt @map("updated_at")

  @@map("configuracao_sieg")
}
```

- [ ] **Step 2: Migração**

Run: `npm run prisma:migrate -- --name add_sieg_oauth_token` (com Docker/Postgres local rodando — `docker compose up -d postgres` antes, se não estiver).
Expected: migração criada e aplicada sem erro.

- [ ] **Step 3: Implementar `gerarState()` e `montarUrlAutorizacao()`**

`gerarState()`: usa `crypto.randomUUID()`, guarda o valor gerado numa variável de módulo (`let stateEmAndamento: string | null`) pra validar no callback — um único fluxo de autorização por vez é suficiente aqui (ação manual, rara). `montarUrlAutorizacao(state, accessLevel)`: monta a URL com `clientId` (mesma fonte de credenciais da Fase A — banco com fallback pro ambiente) via `URLSearchParams`.

- [ ] **Step 4: Implementar `trocarTokenTemporario(tokenTemporario)`**

Usa os achados da Task 1, Step 2. Em caso de falha (HTTP não-OK, corpo sem o token), lança `Error` com mensagem legível — fica pro chamador (rota de callback) decidir como mostrar. Em sucesso, grava `oauthToken`/`oauthExpiraEm` em `ConfiguracaoSieg` (id=1) via `upsert`.

- [ ] **Step 5: Implementar `obterTokenOAuth()`**

Lê `ConfiguracaoSieg`; se `oauthToken` ausente ou `oauthExpiraEm` no passado, lança `Error("Token OAuth do SIEG ausente ou expirado — autorize novamente em /sieg/oauth/autorizar")`. Senão devolve `oauthToken`.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/sieg/oauth.ts
git commit -m "feat(sieg): campos e modulo para o token OAuth de conta"
```

---

### Task 3: Rotas de autorização e callback

**Files:**
- Create: `src/routes/sieg-oauth.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `gerarState`, `montarUrlAutorizacao`, `trocarTokenTemporario` (Task 2); `credenciaisConfiguradas` (Fase A, `src/sieg/auth.ts`) pra checar pré-requisito.
- Produces: router `siegOauthRouter` com `GET /sieg/oauth/autorizar` (autenticado, ADMIN/GESTOR) e `GET /sieg/oauth/callback` (público).

- [ ] **Step 1: `GET /sieg/oauth/autorizar`**

Exige `autenticar` + perfil ADMIN/GESTOR (mesmo `podeAlterar` da Fase A). Se `!(await credenciaisConfiguradas())`, `400` com erro pedindo configurar a Fase A primeiro. Senão: `gerarState()`, `res.redirect(montarUrlAutorizacao(state, "read"))`.

- [ ] **Step 2: `GET /sieg/oauth/callback`**

**Sem** `autenticar` (registrar na seção pública do `server.ts`, como `whatsappWebhookRouter`). Lê `req.query.state` e o parâmetro do token temporário (nome exato da Task 1). Valida o `state` contra o que `gerarState()` guardou — se não bater (ou não houver um state em andamento), responde com uma página HTML simples de erro, `400`. Se bater, chama `trocarTokenTemporario`; em sucesso, limpa o `state` em andamento e responde com uma página HTML simples de sucesso ("Autorização concluída, pode fechar esta aba"); em erro (try/catch ao redor de `trocarTokenTemporario`), página de erro com a mensagem, `502`. Cobre o Review Focus de callback chamado duas vezes: se o `state` já foi limpo (fluxo já concluído), responder "já autorizado" em vez de tentar de novo.

- [ ] **Step 3: Registrar o router**

Em `src/server.ts`, `app.use(siegOauthRouter)` na seção de rotas públicas (perto de `entregaPublicaRouter`/`whatsappWebhookRouter`), não na seção autenticada.

- [ ] **Step 4: Verificação manual — fluxo até o callback, sem autorizar de verdade**

Com o servidor local rodando e autenticado: `GET /sieg/oauth/autorizar` → confere que devolve um redirect (302) pra uma URL `app.sieg.com/AuthorizeAccess.aspx?...` com um `state` novo a cada chamada.
`GET /sieg/oauth/callback?state=valor-errado&...` (sem nunca ter passado pelo autorizar, ou com state propositalmente errado) → confere que devolve erro, não tenta trocar nada.
Expected: os dois comportamentos acima. **Não** cobre o `trocarTokenTemporario` de verdade — isso só acontece na Task 4, com o Marcus clicando de verdade.

- [ ] **Step 5: Commit**

```bash
git add src/routes/sieg-oauth.ts src/server.ts
git commit -m "feat(sieg): rotas de autorizacao e callback OAuth"
```

---

### Task 4: Autorização real, guiada

Esta task não é código — é o roteiro pra fazer com o Marcus, depois que a Task 3 estiver implantada em produção (precisa de URL pública acessível pro SIEG redirecionar).

- [ ] **Step 1:** Confirmar que o PR da Fase B foi mergeado e implantado (EasyPanel) — o callback só funciona com URL pública real.
- [ ] **Step 2:** Eu passo o link de `GET /sieg/oauth/autorizar` (ou o Marcus clica num botão na tela de Integrações, se a Fase E já existir até lá); ele mesmo autentica no painel da Apta e visita o link.
- [ ] **Step 3:** O redirect leva pro SIEG; o Marcus confere a tela de consentimento (empresa, permissões) e clica "Autorizar Acesso" — **ele, não eu**.
- [ ] **Step 4:** O SIEG redireciona pro callback; a página de resultado (sucesso/erro da Task 3) confirma o que aconteceu.
- [ ] **Step 5:** Eu confirmo pelo banco/rota de diagnóstico que `oauthToken`/`oauthExpiraEm` foram salvos (sem nunca expor o valor do token em texto).

---

## Self-Review

1. **Cobertura do objetivo da Fase B**: receber callback ✅ (Task 3), trocar token ✅ (Task 2/3), guardar ✅ (Task 2), getter pras fases seguintes usarem ✅ (`obterTokenOAuth`, Task 2). Tudo que o objetivo promete está coberto.
2. **Steps**: a Task 1 é verificação, não código — deliberado, porque os dois valores que ela produz (URL de callback registrada, formato do `generate-token`) são inputs que as Tasks 2/3 não podem adivinhar; isso não é um "TBD" disfarçado, é uma dependência real de informação externa que só existe fora do código.
3. **Consistência de tipos**: `obterTokenOAuth(): Promise<string>` e `trocarTokenTemporario(tokenTemporario: string): Promise<void>` usados do mesmo jeito nas Tasks 2 e 3.
4. **Review Focus**: as 5 situações (state ausente/errado, credenciais da Fase A faltando, generate-token falhando, callback duplicado, callback acessado sem state) têm tratamento explícito na Task 3, Step 2, e verificação na Task 3, Step 4 (as duas primeiras) — as outras três (generate-token falhando, callback duplicado) só são verificáveis de verdade na Task 4 (fluxo real), marcadas ali.
5. **Proporção**: 4 tasks pra um fluxo de ~5 arquivos pequenos — do tamanho do que a Fase A já estabeleceu como escala razoável pra uma fase deste projeto.

---

**Nota sobre a Fase A desatualizada:** o plano da Fase A (`2026-10-31-sieg-fase-a-autenticacao.md`) ainda descreve a Fase B como "autorização por cliente, com tabela `Cliente ↔ token`". Isso ficou errado depois da validação ao vivo nesta conversa — vou corrigir essa seção lá quando este plano for aprovado, pra não deixar os dois documentos se contradizendo.
