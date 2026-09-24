# Sistema Apta

Plataforma própria de automação e integração de processos para a Apta Contabilidade, substituindo a operação hoje fragmentada em Acessorias, Suri, SIEG, DominioWeb, Conta Azul e Trello.

Este repositório (**apta-back**) é a API: Node.js + Express + TypeScript + Prisma (PostgreSQL).
A interface (Next.js + MUI) fica em [apta-front](https://github.com/Codentec-hub/apta-front).
Contexto do projeto, decisões e convenções: `CONTEXT.md`.

## Status

**Fase 3.1 — Fundação técnica**:

- [x] Estrutura do repositório (frontend, backend)
- [x] Modelagem inicial do banco de dados central (clientes, setores, responsáveis)
- [x] Backend básico com endpoint de saúde e cadastro de clientes
- [x] Frontend básico consumindo a API
- [x] Dockerfiles prontos para deploy no EasyPanel
- [ ] Provisionamento do servidor/domínio no EasyPanel
- [ ] Levantamento de disponibilidade de API em cada ferramenta atual (Acessorias, SIEG, DominioWeb, Suri, Conta Azul, eSocial/DCTFWeb)

**Fase 3.2 — Núcleo do sistema** (concluída):

- [x] Autenticação (login com e-mail/senha, JWT, sessão persistida no navegador)
- [x] CRUD de usuários pela interface (criar, editar, ativar/desativar, perfil ADMIN/GESTOR/OPERACIONAL, setor)
- [x] Tela de login e painel geral protegido por login, no frontend
- [x] Cadastro completo de clientes/empresas pela interface (criar, editar, ativar/desativar)
- [x] Atribuição de responsável por cliente/setor pela interface
- [x] Cadastro de setores pela interface (criar, renomear)

**Fase 3.3 — Obrigações e acompanhamento** (concluída):

- [x] Cadastro de obrigações por cliente, com prazo legal, prazo técnico interno e responsável
- [x] Catálogo de tipos de obrigação, com tempo previsto por tipo
- [x] Fluxo de atraso: justificativa, causa raiz e plano de ação com prazo prometido
- [x] Acompanhamento automático do cumprimento do plano de ação (o que hoje é feito manualmente e nunca é conferido)
- [x] Registro de tempo real gasto ao concluir, para medir produtividade
- [x] Obrigações dispensadas por cliente (não contam como pendência)
- [x] Alerta de planos de ação vencidos no painel geral
- [x] Relatório de performance por responsável (antecipadas, no prazo, atraso legal, atraso sem justificativa, dispensadas, pendentes)
- [x] Filtro por status na tela de Obrigações e busca por obrigação/cliente
- [x] Comparativo de tempo médio real x tempo previsto por tipo de obrigação (tela de Tipos de obrigação)
- [ ] Envio automatizado de declarações (e-mail/WhatsApp)

**Fase 3.4 — Quadro de demandas** (concluída):

- [x] Quadro kanban por setor (A fazer / Em andamento / Concluída), com arrastar-e-soltar
- [x] Demanda vinculada opcionalmente a um cliente e a um responsável

**Fase 3.5 — Atendimento ao cliente** (núcleo interno pronto, sem integração externa ainda):

- [x] Fila de atendimento (Aguardando / Em atendimento / Finalizado), com arrastar-e-soltar
- [x] Direcionamento automático para o responsável do cliente naquele setor (usa o cadastro da Fase 3.2)
- [x] Tempo médio de espera e de atendimento, calculados automaticamente
- [ ] Mensagens automáticas recorrentes e integração com WhatsApp/Suri

**Fase 3.8 — Financeiro** (núcleo interno pronto, sem integração externa ainda):

- [x] Contas a pagar/receber do escritório e de clientes de BPO Financeiro
- [x] DRE simplificado por categoria, no mês corrente
- [x] Saldo do mês e resumo de valores em aberto
- [ ] Integração com Conta Azul (importação automática)

**Ficha individual do cliente** (`/dashboard/clientes/[id]`): visão única reunindo cadastro, responsáveis por setor, obrigações, demandas, atendimentos e financeiro daquele cliente, com atalhos para criar cada um já vinculado a ele.

Usuário administrador padrão (criado pelo seed): `admin@apta.com.br` / `apta1234` — **trocar a senha assim que possível.**

## Como rodar localmente

### 1. Banco de dados

Com Docker:

```bash
docker compose up -d
```

Ou com um PostgreSQL instalado localmente, criando o usuário/banco usados no `.env.example`:

```bash
sudo -u postgres psql -c "CREATE USER apta WITH PASSWORD 'apta';" -c "CREATE DATABASE apta_db OWNER apta;"
```

### 2. Backend (este repositório)

```bash
cp .env.example .env
npm install
npm run prisma:migrate   # cria as tabelas
npm run prisma:seed      # cria os setores e o usuário administrador inicial
npm run prisma:seed-demo # opcional: popula com dados de demonstração (veja abaixo)
npm run dev              # API em http://localhost:3333
```

#### Base de demonstração (opcional)

`npm run prisma:seed-demo` popula o banco com uma base de dados realista para testar o sistema com volume: ~8 usuários, 15 tipos de obrigação, 30 clientes (comércios e serviços tradicionais de Fortaleza), ~150-200 obrigações espalhadas em diferentes status (pendente, atrasada, concluída, com plano de ação), 25 demandas, 40 atendimentos e lançamentos financeiros dos últimos 3 meses. Todos os usuários criados usam a senha `apta1234`. Não é destrutivo (não apaga dados existentes) e não deve ser rodado em produção — é só para desenvolvimento/demonstração local.

### 3. Frontend ([apta-front](https://github.com/Codentec-hub/apta-front))

```bash
git clone https://github.com/Codentec-hub/apta-front.git
cd apta-front
cp .env.example .env
npm install
npm run dev               # http://localhost:3000
```

## Deploy no EasyPanel

Cada repositório (apta-back, apta-front) tem seu próprio `Dockerfile` e pode ser configurada como um serviço separado no EasyPanel, além de um serviço de PostgreSQL gerenciado pelo próprio EasyPanel.

Variáveis de ambiente necessárias:

- **backend**: `DATABASE_URL`, `PORT`
- **frontend** (build arg): `NEXT_PUBLIC_API_URL` apontando para a URL pública do backend

Após o primeiro deploy do backend, rodar as migrations em produção:

```bash
npm run prisma:deploy
```
