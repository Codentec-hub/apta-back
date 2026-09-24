// Popula o banco com uma base de demonstração consistente e realista:
// usuários, tipos de obrigação, clientes de Fortaleza, obrigações (com
// atrasos), demandas, atendimentos e lançamentos financeiros. Feito para
// testar paginação, busca e filtros com volume de dado real — não é
// necessário (nem recomendado) rodar em produção.
//
// Uso: cd backend && npx tsx prisma/seed-demo.ts
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { configurarObrigacoes } from "./seed-obrigacoes.js";

const prisma = new PrismaClient();

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomItem<T>(arr: readonly T[]): T {
  return arr[randomInt(0, arr.length - 1)];
}

function randomItems<T>(arr: readonly T[], n: number): T[] {
  const copia = [...arr];
  const resultado: T[] = [];
  for (let i = 0; i < n && copia.length > 0; i++) {
    const indice = randomInt(0, copia.length - 1);
    resultado.push(copia.splice(indice, 1)[0]);
  }
  return resultado;
}

function addDays(base: Date, dias: number): Date {
  const data = new Date(base);
  data.setDate(data.getDate() + dias);
  return data;
}

function chance(porcentagem: number): boolean {
  return Math.random() * 100 < porcentagem;
}

// --- Usuários fictícios (nomes genéricos, não pessoas reais) ---
const USUARIOS_DEMO = [
  { nome: "Ricardo Almeida", email: "ricardo.almeida@apta.com.br", perfil: "GESTOR", setor: "Fiscal" },
  { nome: "Camila Rocha", email: "camila.rocha@apta.com.br", perfil: "OPERACIONAL", setor: "Fiscal" },
  { nome: "Bruno Teixeira", email: "bruno.teixeira@apta.com.br", perfil: "GESTOR", setor: "Pessoal/Folha" },
  { nome: "Larissa Nunes", email: "larissa.nunes@apta.com.br", perfil: "OPERACIONAL", setor: "Pessoal/Folha" },
  { nome: "Felipe Cardoso", email: "felipe.cardoso@apta.com.br", perfil: "GESTOR", setor: "Contábil" },
  { nome: "Juliana Farias", email: "juliana.farias@apta.com.br", perfil: "OPERACIONAL", setor: "Contábil" },
  { nome: "Marcos Vinícius", email: "marcos.vinicius@apta.com.br", perfil: "GESTOR", setor: "Financeiro" },
  { nome: "Patrícia Lima", email: "patricia.lima@apta.com.br", perfil: "OPERACIONAL", setor: "Atendimento" },
] as const;

// --- Catálogo de tipos de obrigação por setor ---
const TIPOS_OBRIGACAO_DEMO = [
  { nome: "DARF - COFINS", setor: "Fiscal", tempoPrevistoMinutos: 20 },
  { nome: "DARF - PIS", setor: "Fiscal", tempoPrevistoMinutos: 15 },
  { nome: "DARF - IRPJ Trimestral", setor: "Fiscal", tempoPrevistoMinutos: 25 },
  { nome: "DAS - Simples Nacional", setor: "Fiscal", tempoPrevistoMinutos: 15 },
  { nome: "EFD - Escrituração Fiscal Digital", setor: "Fiscal", tempoPrevistoMinutos: 40 },
  { nome: "Folha de Pagamento Mensal", setor: "Pessoal/Folha", tempoPrevistoMinutos: 60 },
  { nome: "FGTS Digital", setor: "Pessoal/Folha", tempoPrevistoMinutos: 20 },
  { nome: "eSocial - Envio Mensal", setor: "Pessoal/Folha", tempoPrevistoMinutos: 30 },
  { nome: "13º Salário", setor: "Pessoal/Folha", tempoPrevistoMinutos: 45 },
  { nome: "Férias", setor: "Pessoal/Folha", tempoPrevistoMinutos: 30 },
  { nome: "Balancete Mensal", setor: "Contábil", tempoPrevistoMinutos: 50 },
  { nome: "Balanço Patrimonial", setor: "Contábil", tempoPrevistoMinutos: 90 },
  { nome: "ECD - Escrituração Contábil Digital", setor: "Contábil", tempoPrevistoMinutos: 60 },
  { nome: "Conciliação Bancária", setor: "Financeiro", tempoPrevistoMinutos: 30 },
  { nome: "DRE Mensal", setor: "Financeiro", tempoPrevistoMinutos: 40 },
] as const;

// --- Clientes: comércios e serviços tradicionais de Fortaleza (nomes reais
// de estabelecimentos conhecidos, misturados com nomes fictícios no padrão
// "ramo + bairro" — o perfil típico de cliente de um escritório de
// contabilidade de porte médio, não as grandes corporações do estado). ---
const CLIENTES_DEMO = [
  { nome: "Restaurante da Zena Ltda", regime: "Lucro Presumido" },
  { nome: "Cantinho do Frango Comércio de Alimentos Ltda", regime: "Simples Nacional" },
  { nome: "Colher de Pau Restaurante Nordestino Ltda", regime: "Simples Nacional" },
  { nome: "Mocinha do Mercado Central Ltda", regime: "Simples Nacional" },
  { nome: "Bar do Mincharia Praia de Iracema Ltda", regime: "Simples Nacional" },
  { nome: "HM Lanches e Pastelaria Parquelândia Ltda", regime: "Simples Nacional" },
  { nome: "Pizzaria Crocante Jardim Guanabara Ltda", regime: "Simples Nacional" },
  { nome: "Restaurante São Francisco Mucuripe Ltda", regime: "Lucro Presumido" },
  { nome: "Centro das Tapioqueiras Praia de Iracema Ltda", regime: "Simples Nacional" },
  { nome: "Leão do Sul Comércio de Carnes Ltda", regime: "Simples Nacional" },
  { nome: "Ponto da Muqueca Restaurante Varjota Ltda", regime: "Lucro Presumido" },
  { nome: "Padaria Dionísio Torres Ltda", regime: "Simples Nacional" },
  { nome: "Farmácia Cura Bem Aldeota Ltda", regime: "Lucro Presumido" },
  { nome: "Auto Peças Parangaba Ltda", regime: "Simples Nacional" },
  { nome: "Distribuidora Mucuripe de Bebidas Ltda", regime: "Lucro Presumido" },
  { nome: "Construtora Meireles Empreendimentos S.A.", regime: "Lucro Real" },
  { nome: "Barbearia Montese Ltda", regime: "Simples Nacional" },
  { nome: "Papelaria Benfica Ltda", regime: "Simples Nacional" },
  { nome: "Ótica Cocó Visão Ltda", regime: "Simples Nacional" },
  { nome: "Studio de Estética Varjota Ltda", regime: "Simples Nacional" },
  { nome: "Academia Fitness Papicu Ltda", regime: "Simples Nacional" },
  { nome: "Pet Shop Antônio Bezerra Ltda", regime: "Simples Nacional" },
  { nome: "Materiais de Construção Bela Vista Ltda", regime: "Lucro Presumido" },
  { nome: "Salão Fátima Hair Ltda", regime: "Simples Nacional" },
  { nome: "Iracema Fashion Comércio de Roupas Ltda", regime: "Simples Nacional" },
  { nome: "Distribuidora de Gás Barra do Ceará Ltda", regime: "Lucro Presumido" },
  { nome: "Cocó Prime Imobiliária Ltda", regime: "Lucro Presumido" },
  { nome: "Escritório de Advocacia Aldeota Associados", regime: "Lucro Presumido" },
  { nome: "Clínica Odontológica Meireles Ltda", regime: "Simples Nacional" },
  { nome: "Parangaba Log Transportadora Ltda", regime: "Lucro Real" },
] as const;

const MOTIVOS_ATRASO = [
  "Cliente atrasou o envio da documentação necessária.",
  "Sistema da Receita Federal apresentou instabilidade no dia do vencimento.",
  "Aguardando retorno do cliente sobre divergência identificada nos dados.",
  "Certificado digital do cliente estava vencido e precisou ser renovado.",
  "Alta demanda no setor no período de fechamento.",
] as const;

const CAUSAS_RAIZ = [
  "Falta de checklist de documentos pendentes por cliente.",
  "Ausência de lembrete automático próximo ao vencimento.",
  "Processo manual sem responsável reserva no setor.",
  "Cliente não tem canal direto de cobrança de documentos.",
] as const;

const PLANOS_DE_ACAO = [
  "Criar checklist padrão e enviar lembrete 5 dias antes do vencimento.",
  "Configurar alerta automático de vencimento de certificado digital.",
  "Definir responsável reserva para cobertura de ausências no setor.",
  "Agendar cobrança automática de documentos com uma semana de antecedência.",
] as const;

const TITULOS_DEMANDA = [
  "Planejamento tributário 2027",
  "Estudo de viabilidade — abertura de filial",
  "Revisão de regime tributário",
  "Análise de enquadramento no Simples Nacional",
  "Levantamento para recuperação de créditos tributários",
  "Estudo de viabilidade — entrada de novo sócio",
  "Reorganização societária",
  "Planejamento sucessório",
  "Estudo de holding patrimonial",
] as const;

const MOTIVOS_ATENDIMENTO = [
  "Solicitação de extrato bancário",
  "Dúvida sobre imposto de renda",
  "Pedido de segunda via de boleto",
  "Solicitação de certidão negativa de débitos",
  "Dúvida sobre valor do pró-labore",
  "Solicitação de relatório de folha de pagamento",
  "Consulta sobre parcelamento de débito",
  "Atualização de dados cadastrais",
  "Dúvida sobre nota fiscal de serviço",
  "Solicitação de guia de recolhimento",
] as const;

const CATEGORIAS_DESPESA_ESCRITORIO = [
  "Aluguel",
  "Salários",
  "Pró-labore",
  "Energia elétrica",
  "Internet e telefone",
  "Material de escritório",
  "Software de gestão",
] as const;

async function main() {
  const setores = await prisma.setor.findMany();
  const setorPorNome = new Map(setores.map((s) => [s.nome, s]));
  if (setorPorNome.size === 0) {
    throw new Error("Nenhum setor encontrado — rode `npm run prisma:seed` primeiro.");
  }

  console.log("Criando usuários...");
  const usuarios = [];
  for (const u of USUARIOS_DEMO) {
    const existente = await prisma.usuario.findUnique({ where: { email: u.email } });
    if (existente) {
      usuarios.push(existente);
      continue;
    }
    const senhaHash = await bcrypt.hash("apta1234", 10);
    const setor = setorPorNome.get(u.setor);
    const usuario = await prisma.usuario.create({
      data: { nome: u.nome, email: u.email, senhaHash, perfil: u.perfil, setorId: setor?.id },
    });
    usuarios.push(usuario);
  }

  console.log("Criando tipos de obrigação...");
  const tipos = [];
  for (const t of TIPOS_OBRIGACAO_DEMO) {
    const setor = setorPorNome.get(t.setor);
    if (!setor) continue;
    const tipo = await prisma.tipoObrigacao.upsert({
      where: { nome_setorId: { nome: t.nome, setorId: setor.id } },
      update: {},
      create: { nome: t.nome, setorId: setor.id, tempoPrevistoMinutos: t.tempoPrevistoMinutos },
    });
    tipos.push(tipo);
  }

  console.log("Criando clientes...");
  const clientes = [];
  for (let i = 0; i < CLIENTES_DEMO.length; i++) {
    const c = CLIENTES_DEMO[i];
    const cnpj = `${String(10 + i).padStart(2, "0")}.${String(randomInt(100, 999))}.${String(
      randomInt(100, 999)
    )}/0001-${String(randomInt(10, 99))}`;

    const existente = await prisma.cliente.findUnique({ where: { cnpj } });
    if (existente) {
      clientes.push(existente);
      continue;
    }

    const cliente = await prisma.cliente.create({
      data: {
        razaoSocial: c.nome,
        cnpj,
        regimeTributario: c.regime,
        ativo: !chance(8), // ~8% inativos, pra ter variedade no filtro
      },
    });
    clientes.push(cliente);
  }

  console.log("Atribuindo responsáveis por setor...");
  for (const cliente of clientes) {
    const setoresEscolhidos = randomItems(setores, randomInt(2, setores.length));
    for (const setor of setoresEscolhidos) {
      const usuariosDoSetor = usuarios.filter((u) => u.setorId === setor.id);
      const responsavel = usuariosDoSetor.length > 0 ? randomItem(usuariosDoSetor) : randomItem(usuarios);
      await prisma.clienteResponsavel
        .upsert({
          where: { clienteId_setorId: { clienteId: cliente.id, setorId: setor.id } },
          update: {},
          create: { clienteId: cliente.id, setorId: setor.id, usuarioId: responsavel.id },
        })
        .catch(() => null);
    }
  }

  console.log("Criando obrigações (isso pode levar um instante)...");
  const hoje = new Date();
  let totalObrigacoes = 0;
  let totalAtrasos = 0;
  // cliente+tipo+competência já usados (a Lista de Entregas não aceita repetido)
  const entregasUsadas = new Set<string>();

  for (const cliente of clientes) {
    const responsaveis = await prisma.clienteResponsavel.findMany({ where: { clienteId: cliente.id } });
    if (responsaveis.length === 0) continue;

    const quantidadeObrigacoes = randomInt(4, 10);
    for (let i = 0; i < quantidadeObrigacoes; i++) {
      const responsavel = randomItem(responsaveis);
      const tiposDoSetor = tipos.filter((t) => t.setorId === responsavel.setorId);
      if (tiposDoSetor.length === 0) continue;
      const tipo = randomItem(tiposDoSetor);

      const deltaDias = randomInt(-75, 25);
      const prazo = addDays(hoje, deltaDias);
      const prazoTecnico = chance(60) ? addDays(prazo, -randomInt(2, 5)) : null;
      const dispensada = chance(4);

      let concluidaEm: Date | null = null;
      let tempoRealMinutos: number | null = null;
      let atraso: { justificativa: string; causaRaiz: string; planoDeAcao: string; prazoPrometido: Date; cumprido: boolean; cumpridoEm: Date | null } | null = null;

      if (!dispensada && deltaDias < 0) {
        if (chance(70)) {
          // concluída — a maioria no prazo/antecipada, uma fração com atraso
          const atrasada = chance(20);
          concluidaEm = atrasada ? addDays(prazo, randomInt(1, 8)) : addDays(prazo, -randomInt(0, 4));
          tempoRealMinutos = Math.max(5, (tipo.tempoPrevistoMinutos ?? 30) + randomInt(-10, 15));
        } else if (chance(50)) {
          // em aberto, com atraso registrado (plano de ação)
          const prazoPrometido = addDays(hoje, randomInt(-5, 10));
          const cumprido = prazoPrometido < hoje && chance(60);
          atraso = {
            justificativa: randomItem(MOTIVOS_ATRASO),
            causaRaiz: randomItem(CAUSAS_RAIZ),
            planoDeAcao: randomItem(PLANOS_DE_ACAO),
            prazoPrometido,
            cumprido,
            cumpridoEm: cumprido ? addDays(prazoPrometido, -randomInt(0, 2)) : null,
          };
        }
        // restante: em aberto, sem atraso registrado (aparece como "Atrasada — sem justificativa")
      }

      // competência = mês anterior ao prazo legal ("vence no mês seguinte")
      const competenciaData = new Date(Date.UTC(prazo.getFullYear(), prazo.getMonth() - 1, 1));
      const chaveEntrega = `${cliente.id}|${tipo.id}|${competenciaData.toISOString()}`;
      const competencia = entregasUsadas.has(chaveEntrega) ? null : competenciaData;
      entregasUsadas.add(chaveEntrega);

      const obrigacao = await prisma.obrigacao.create({
        data: {
          nome: tipo.nome,
          competencia,
          prazo,
          prazoTecnico,
          dispensada,
          concluidaEm,
          tempoRealMinutos,
          clienteId: cliente.id,
          setorId: responsavel.setorId,
          tipoId: tipo.id,
          responsavelId: responsavel.usuarioId,
          entreguePorId: concluidaEm ? responsavel.usuarioId : null,
        },
      });
      totalObrigacoes++;

      if (atraso) {
        await prisma.atraso.create({
          data: { obrigacaoId: obrigacao.id, ...atraso },
        });
        totalAtrasos++;
      }
    }
  }
  console.log(`  ${totalObrigacoes} obrigações criadas (${totalAtrasos} com plano de ação).`);

  console.log("Criando demandas...");
  const statusDemanda = ["A_FAZER", "A_FAZER", "EM_ANDAMENTO", "EM_ANDAMENTO", "CONCLUIDA"] as const;
  for (let i = 0; i < 25; i++) {
    const cliente = chance(70) ? randomItem(clientes) : null;
    const setor = randomItem(setores);
    const usuariosDoSetor = usuarios.filter((u) => u.setorId === setor.id);
    const responsavel = chance(70) ? (usuariosDoSetor.length > 0 ? randomItem(usuariosDoSetor) : randomItem(usuarios)) : null;
    await prisma.demanda.create({
      data: {
        titulo: `${randomItem(TITULOS_DEMANDA)} — ${cliente ? cliente.razaoSocial.split(" ").slice(0, 2).join(" ") : "Interno"}`,
        setorId: setor.id,
        clienteId: cliente?.id ?? null,
        responsavelId: responsavel?.id ?? null,
        status: randomItem(statusDemanda),
      },
    });
  }

  console.log("Criando atendimentos...");
  for (let i = 0; i < 40; i++) {
    const cliente = randomItem(clientes);
    const responsaveis = await prisma.clienteResponsavel.findMany({ where: { clienteId: cliente.id } });
    const vinculo = responsaveis.length > 0 ? randomItem(responsaveis) : null;
    const setor = vinculo ? setores.find((s) => s.id === vinculo.setorId)! : randomItem(setores);

    const situacao = chance(70) ? "FINALIZADO" : chance(50) ? "EM_ATENDIMENTO" : "AGUARDANDO";
    const abertoEm = addDays(hoje, -randomInt(0, 30));
    let iniciadoEm: Date | null = null;
    let finalizadoEm: Date | null = null;
    if (situacao !== "AGUARDANDO") {
      iniciadoEm = new Date(abertoEm.getTime() + randomInt(2, 120) * 60_000);
    }
    if (situacao === "FINALIZADO") {
      finalizadoEm = new Date((iniciadoEm ?? abertoEm).getTime() + randomInt(3, 90) * 60_000);
    }

    await prisma.atendimento.create({
      data: {
        clienteId: cliente.id,
        setorId: setor.id,
        motivo: randomItem(MOTIVOS_ATENDIMENTO),
        responsavelId: vinculo?.usuarioId ?? null,
        status: situacao,
        abertoEm,
        iniciadoEm,
        finalizadoEm,
      },
    });
  }

  console.log("Criando lançamentos financeiros...");
  // Despesas do próprio escritório, nos últimos 3 meses (a maioria liquidada)
  for (let mes = 2; mes >= 0; mes--) {
    for (const categoria of CATEGORIAS_DESPESA_ESCRITORIO) {
      const vencimento = addDays(hoje, -mes * 30 - randomInt(0, 5));
      const liquidado = mes > 0 || chance(60);
      await prisma.lancamentoFinanceiro.create({
        data: {
          tipo: "PAGAR",
          descricao: `${categoria} — competência ${vencimento.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}`,
          categoria,
          valor: randomInt(300, 4500),
          vencimento,
          liquidadoEm: liquidado ? addDays(vencimento, randomInt(-2, 3)) : null,
        },
      });
    }
  }
  // Honorários a receber dos clientes, nos últimos 3 meses + próximo mês
  for (const cliente of clientes) {
    if (!cliente.ativo) continue;
    for (let mes = 2; mes >= -1; mes--) {
      const vencimento = addDays(hoje, -mes * 30 + randomInt(-3, 3));
      const liquidado = mes > 0 || (mes === 0 && chance(50));
      await prisma.lancamentoFinanceiro.create({
        data: {
          tipo: "RECEBER",
          descricao: `Honorários contábeis — competência ${vencimento.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}`,
          categoria: "Honorários",
          valor: randomInt(250, 1200),
          vencimento,
          liquidadoEm: liquidado ? addDays(vencimento, randomInt(-2, 5)) : null,
          clienteId: cliente.id,
        },
      });
    }
  }

  await configurarObrigacoes(prisma);

  console.log("\nBase de demonstração criada com sucesso:");
  console.log(`  ${usuarios.length} usuários (senha padrão: apta1234)`);
  console.log(`  ${tipos.length} tipos de obrigação`);
  console.log(`  ${clientes.length} clientes`);
  console.log(`  ${totalObrigacoes} obrigações`);
  console.log(`  25 demandas`);
  console.log(`  40 atendimentos`);
  console.log(`  lançamentos financeiros dos últimos 3 meses`);
}

main()
  .catch((erro) => {
    console.error(erro);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
