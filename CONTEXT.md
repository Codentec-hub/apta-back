# Contexto do projeto — Sistema Apta

> Documento de retomada rápida. Leia isto antes de continuar o desenvolvimento numa nova sessão.
> Última atualização: 2026-09-19.

## O que é

Plataforma própria para a **Apta Contabilidade** (contato: Sr. Emanuell), substituindo a operação hoje fragmentada em Acessorias, Suri, SIEG, DominioWeb, Conta Azul e Trello por um sistema único, com banco de dados próprio do escritório. Proposta completa em `Proposta - Sistema Apta.pdf`; as anotações brutas (mais valiosas para entender a dor real do cliente) estão em `SISTEMAS APTA.docx`.

Stack: `backend/` Node.js + Express + TypeScript + Prisma (PostgreSQL). `frontend/` Next.js 15 (App Router) + MUI (baseado no template "Material Kit React" da Devias, migração completa — o frontend antigo em Vite ficou guardado em `frontend-vite-backup/`, pode ser apagado quando o novo estiver validado em uso real).

## Regra de ouro do cliente (não esquecer)

A frase mais importante do Emanuell, nas palavras dele: hoje, quando algo atrasa, ninguém confirma depois se o plano prometido foi realmente cumprido —
**"na verdade nunca acompanhamos se realmente foi terminado e se realmente cumpriu esse prazo que ele mesmo informou ao cliente."**
Esse loop (atraso → justificativa → causa raiz → plano de ação com prazo → confirmação de cumprimento) é o recurso com maior impacto emocional para ele. Já está implementado (Fase 3.3) e é o "carro-chefe" para demonstrações.

Outros desejos dele, em ordem de menção: painel por cliente com responsável por setor (feito), obrigações + tempo médio de execução por tipo (feito), relatórios de performance por setor/atendente (feito), kanban de demandas não recorrentes (feito), painel de atendimento com fila/triagem e auto-direcionamento (feito, core interno), automação do SIEG para parcelamento em lote (~60 de 400 clientes ativos, maior ganho de produtividade identificado — **não construído, depende de integração externa**), e ele próprio citou querer automação "com o CLAUDE" ao estilo de uma consultoria que acompanha — sinal de que já está receptivo a IA sobre os dados estruturados (Fase 3.10, ainda não iniciada).

## Status por fase (ver detalhe completo no README)

| Fase | O que é | Status |
|---|---|---|
| 3.1 Fundação técnica | Servidor, domínio, modelagem inicial | Parcial — falta provisionar EasyPanel e auditar API dos sistemas atuais |
| 3.2 Núcleo | Auth, usuários, clientes, setores, responsável por setor/cliente | **Completo**, com UI real |
| 3.3 Obrigações | Obrigações, tipos, atraso→justificativa→causa raiz→plano de ação, produtividade | **Completo**, exceto envio automatizado (e-mail/WhatsApp) |
| 3.4 Demandas | Kanban por setor (drag-and-drop nativo) | **Completo** |
| 3.5 Atendimento | Fila (aguardando/em atendimento/finalizado), auto-direcionamento, tempos médios | Core interno **completo**; falta mensagens automáticas recorrentes (WhatsApp/Suri) |
| 3.6 Fiscal (SIEG/DominioWeb) | Captura de XML, parcelamento em lote, escrituração automática | **Não iniciado** — bloqueado em integração externa |
| 3.7 Folha de pagamento | Cálculo de folha, eSocial/DCTFWeb/FGTS Digital | **Não iniciado** — bloqueado em integração externa |
| 3.8 Financeiro | Contas a pagar/receber, DRE simplificado, saldo do mês | Core interno **completo**; falta integração com Conta Azul (importação automática) |
| 3.9 Contábil avançado | Open Finance, conferência automática | **Não iniciado** — bloqueado em integração externa |
| 3.10 IA/automação avançada | Triagem de atendimento, sinais preditivos | **Não iniciado** — depende dos dados estruturados pelas fases 3.3–3.9 |
| Ficha do cliente | Página única por cliente reunindo tudo | **Completo** (`/dashboard/clientes/[id]`) |

**Regra explícita do usuário em vigor:** só construir o que **não depende de integração externa** (SIEG, Suri, DominioWeb, Conta Azul, WhatsApp/e-mail ficam para depois). É por isso que 3.6/3.7/3.9 seguem como placeholders no menu ("Fase X.Y · em construção") e por que 3.5/3.8 têm o "core interno" pronto mas sem a ponta de integração.

## O que foi feito na sessão de 2026-09-24 — Obrigações idênticas ao Acessórias

Referência: o próprio Acessórias da Apta, visto (só leitura) em `app.acessorias.com` — telas Relação das Obrigações (m=20), Cadastro de obrigação (m=21), Lista de Entregas (m=3) e Cadastro da empresa (m=105). Detalhes campo a campo na memória do projeto (`acessorias_modelo_real.md`). Central de ajuda pública: `app.acessorias.com/sysajuda.php?p=<n>`.

- **Cadastro de obrigação** (`TipoObrigacao`), mesmos campos do Acessórias: nome, mininome, departamento (com responsável padrão — `Setor.responsavelId`), tempo previsto; **um código por mês de entrega** em `entregasPorMes` (0 não tem · 1–31 todo dia N · 51–70 Nº dia útil · 90 último dia útil — mesmos valores do select deles); competências referentes a (mês anterior, 2/3 meses antes, ano anterior/atual, mês atual/seguinte); lembrar X dias antes + úteis/corridos (= prazo técnico); prazos fixos em dia não útil (antecipar/postergar/manter); sábado é útil; passível de multa; ativa; comentário padrão. Botões **Retro** (pendências retroativas), **Avulsa** (demandas avulsas), **Replicar**, lista de empresas + "Adicionar empresa a essa obrigação". Motor em `backend/src/obrigacoes/prazos.ts` (feriados nacionais calculados).
- **Geração** (`gerar-entregas.ts`): por mês de entrega; mantém pendências do mês atual até +11 meses (roda na subida da API e a cada 6h). Mudou a regra / inativou / trocou responsável → pendências futuras *intocadas* (sem entrega, dispensa, justificativa, comentário ou log) são refeitas ou removidas.
- **Lista de Entregas**: status combináveis (Pendentes/Justificadas/Entregues/Dispensadas, com contagem), filtros por intervalo (competência, prazo técnico, prazo legal, data da entrega), empresa, departamento (Operacional abre filtrado no próprio), obrigação, responsável. Colunas como no Acessórias; ações Alterar prazo técnico (relógio), Dispensar, Entrega Rápida, Justificar/Plano, Entregar com data/tempo/comentário, Editar, Histórico; **comentários** por entrega (`ComentarioEntrega`); alteração de prazos em massa. Alterar prazo só ADMIN/GESTOR, tudo com log.
- **Empresa**: obrigações por departamento com contadores Entregues/Resolvidas · Atraso téc. · Próx. 30 dias · Futuras 30d+, **tempo previsto por empresa**, Ativa? Sim/Não, responsável; regimes (substituem) e grupos (adicionam).
- Painel Geral e ficha do cliente olham só até 30 dias à frente (as futuras inflariam "Pendentes").
- `npm run prisma:seed-obrigacoes` aplica as regras reais no catálogo demo (ex.: Folha no 5º dia útil, IRPJ trimestral no último dia útil, ECD último dia útil de junho) e refaz as pendências futuras.
- Fora do escopo (dependem de integração/arquivos): Exigir Robô, Alerta de guia não lida, envio ao cliente com protocolo (app/Área VIP/e-mail/WhatsApp); feriados estaduais/municipais (use alteração em massa).

## O que foi feito na sessão de 2026-09-19

- Base de demonstração populada via `npm run prisma:seed-demo` (30 clientes reais/fictícios de Fortaleza, ~164 obrigações, 21 atrasos, 25 demandas, 40 atendimentos, ~129 lançamentos financeiros). **Esses dados devem permanecer** — não são dado de teste para apagar.
- Paginação (`usePaginacao`, client-side) adicionada em Clientes, Obrigações e Financeiro por causa do volume do seed.
- Filtro por Status + busca por texto (obrigação/cliente) na tela de Obrigações.
- Fechado o loop de produtividade: coluna "Tempo médio real" na tela de Tipos de Obrigação, comparando com o tempo previsto (chip verde/vermelho), calculado a partir das obrigações concluídas.

## O que falta / próximos passos sugeridos

1. **Ficha do cliente**: ainda não mostra o comparativo tempo real x previsto por obrigação daquele cliente especificamente (só existe de forma global e por responsável).
2. **Drag-and-drop dentro de uma mesma coluna** do kanban (Demandas/Atendimento) — hoje só move entre colunas.
3. **Decisão de integração externa** (quando o usuário quiser destravar): SIEG/DominioWeb (Fase 3.6), eSocial/FGTS Digital (Fase 3.7), Conta Azul (Fase 3.8), Open Finance (3.9), envio de WhatsApp/e-mail (3.3/3.5). Nenhuma dessas foi sequer levantada tecnicamente ainda (disponibilidade de API não auditada).
4. Fase 3.1 pendente: provisionamento real do servidor/domínio no EasyPanel.
5. Fase 3.10 (IA) só faz sentido depois que uma das integrações de dados (3.6/3.7/3.9) avançar.

## Convenções importantes (não quebrar)

- **Todo handler de rota assíncrona no backend precisa estar dentro de `asyncHandler`** (`backend/src/middleware/asyncHandler.ts`). Express 4 não captura rejeições de promises sozinho — um handler "nu" já derrubou o processo inteiro em produção local por causa de um erro do Prisma não tratado. Sempre checar existência do registro antes de update/delete por id (404 em vez de deixar o Prisma estourar).
- **Duas funções de status separadas** em `frontend/src/lib/obrigacao-status.ts`: `statusDaObrigacao` (o que precisa de ação agora — alimenta alertas e botões) e `pontualidadeDaObrigacao` (categoria só para relatório, espelha as colunas do Acessorias). Não fundir as duas sem checar Painel Geral e a tabela de Obrigações.
- **Nunca rodar `npm run build` com o `next dev` ativo** — corrompe o `.next/`. Sempre `pkill -f "next dev"` + `rm -rf .next` antes de buildar, depois reiniciar o dev.
- Sequência de verificação antes de considerar algo pronto: `npm run typecheck` → `npm run build` (pega erros de `unicorn/*` do ESLint que o `tsc` sozinho não pega) → testar no navegador contra o Postgres real.
- Tema é **light-mode fixo** (sem dark mode automático) — pedido explícito anterior do usuário.
- Novo módulo no frontend segue o padrão: rota em `frontend/src/app/dashboard/<modulo>/page.tsx`, view em `frontend/src/components/dashboard/<modulo>/`, tipos em `frontend/src/types/domain.ts`, nav em `frontend/src/components/dashboard/layout/config.ts`.

## Como rodar

Ver `README.md` (seção "Como rodar localmente") — resumo: `docker compose up -d` para o Postgres, depois `backend/`: `npm install && npm run prisma:migrate && npm run prisma:seed && npm run dev`. `frontend/`: `npm install && npm run dev`. Login padrão: `admin@apta.com.br` / `apta1234`. Se popular com dado de demonstração: `npm run prisma:seed-demo` (dentro de `backend/`) — usuários demo usam senha `apta1234`.

## Memória persistente do Claude sobre este projeto

Além deste arquivo (que fica no repo, visível em qualquer editor), há memórias mais detalhadas indexadas em `~/.claude/projects/-home-lucas-Projetos-Apta/memory/MEMORY.md`, usadas automaticamente pelo Claude Code em sessões futuras neste diretório. Este `CONTEXT.md` é o resumo "para humano"; aquelas memórias têm mais detalhe técnico linha-a-linha se precisar consultar.
