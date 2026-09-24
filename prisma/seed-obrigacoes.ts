// Configura o Cadastro de Obrigações no modelo do Acessórias sobre a base
// de demonstração: regra de prazo de cada tipo (legislação vigente), regimes
// tributários com suas obrigações, grupos de obrigações, aplica o regime de
// cada cliente e (re)gera as entregas da competência atual.
//
// Idempotente. Uso: cd backend && npm run prisma:seed-obrigacoes
// (também é chamado no final do seed-demo).
import type { AjustePrazo, PrismaClient, TipoDias } from "@prisma/client";
import { gerarJanela, removerFuturasIntocadas } from "../src/obrigacoes/gerar-entregas.js";
import { calcularEntrega, mesAtual } from "../src/obrigacoes/prazos.js";

// Mesmos campos/códigos do cadastro de obrigação do Acessórias:
// entregasPorMes (Jan–Dez): 0 não tem · 1–31 todo dia N · 51–70 Nº dia útil · 90 último dia útil.
type Regra = {
  entregasPorMes: number[];
  competenciaReferente: number;
  diasAntes: number;
  tipoDiasAntes: TipoDias;
  ajustePrazo: AjustePrazo;
  sabadoUtil: boolean;
  geraMulta: boolean;
};

const todoMes = (codigo: number) => Array.from({ length: 12 }, () => codigo);
const soNosMeses = (codigo: number, meses: number[]) =>
  Array.from({ length: 12 }, (_, i) => (meses.includes(i + 1) ? codigo : 0));

const regra = (entregasPorMes: number[], extra: Partial<Regra> = {}): Regra => ({
  entregasPorMes,
  competenciaReferente: -1, // mês anterior
  diasAntes: 3,
  tipoDiasAntes: "UTEIS",
  ajustePrazo: "ANTECIPAR",
  sabadoUtil: false,
  geraMulta: false,
  ...extra,
});

const REGRAS: Record<string, Regra> = {
  "DARF - COFINS": regra(todoMes(25), { geraMulta: true }),
  "DARF - PIS": regra(todoMes(25), { geraMulta: true }),
  // Último dia útil do mês seguinte ao fim do trimestre.
  "DARF - IRPJ Trimestral": regra(soNosMeses(90, [1, 4, 7, 10]), { geraMulta: true }),
  // Resolução CGSN 140: dia 20, prorroga para o próximo dia útil.
  "DAS - Simples Nacional": regra(todoMes(20), { ajustePrazo: "POSTERGAR", geraMulta: true }),
  "EFD - Escrituração Fiscal Digital": regra(todoMes(20), { geraMulta: true }),
  // Salário até o 5º dia útil.
  "Folha de Pagamento Mensal": regra(todoMes(55), { diasAntes: 2 }),
  "FGTS Digital": regra(todoMes(20), { geraMulta: true }),
  "eSocial - Envio Mensal": regra(todoMes(15), { geraMulta: true }),
  // 2ª parcela até 20/12, competência do próprio ano.
  "13º Salário": regra(soNosMeses(20, [12]), { competenciaReferente: 0, diasAntes: 5, geraMulta: true }),
  "Férias": regra(todoMes(0), { diasAntes: 0 }),
  "Balancete Mensal": regra(todoMes(25)),
  "Balanço Patrimonial": regra(soNosMeses(30, [4]), { competenciaReferente: -12, diasAntes: 10 }),
  // Último dia útil de junho, ano-base anterior.
  "ECD - Escrituração Contábil Digital": regra(soNosMeses(90, [6]), { competenciaReferente: -12, diasAntes: 10, geraMulta: true }),
  "Conciliação Bancária": regra(todoMes(10), { diasAntes: 2 }),
  "DRE Mensal": regra(todoMes(15), { diasAntes: 2 }),
};

const PESSOAL = ["Folha de Pagamento Mensal", "FGTS Digital", "eSocial - Envio Mensal", "13º Salário"];
const PRESUMIDO = [
  "DARF - COFINS", "DARF - PIS", "DARF - IRPJ Trimestral", "EFD - Escrituração Fiscal Digital",
  ...PESSOAL, "Balancete Mensal", "ECD - Escrituração Contábil Digital",
];

const REGIMES: Record<string, string[]> = {
  "Simples Nacional": ["DAS - Simples Nacional", ...PESSOAL, "Balancete Mensal"],
  "Lucro Presumido": PRESUMIDO,
  "Lucro Real": [...PRESUMIDO, "Balanço Patrimonial", "DRE Mensal"],
};

const GRUPOS: Record<string, string[]> = {
  "Departamento Pessoal — padrão": [...PESSOAL, "Férias"],
  "BPO Financeiro": ["Conciliação Bancária", "DRE Mensal"],
};

export async function configurarObrigacoes(prisma: PrismaClient): Promise<void> {
  const tipos = await prisma.tipoObrigacao.findMany();
  const idPorNome = new Map(tipos.map((t) => [t.nome, t.id]));
  const ids = (nomes: string[]) => nomes.map((n) => idPorNome.get(n)).filter((id): id is string => Boolean(id));

  console.log("Aplicando regras de prazo no Cadastro de Obrigações...");
  for (const tipo of tipos) {
    const regra = REGRAS[tipo.nome];
    if (regra) await prisma.tipoObrigacao.update({ where: { id: tipo.id }, data: regra });
  }

  console.log("Definindo o responsável padrão de cada departamento (gestor do setor)...");
  const setores = await prisma.setor.findMany({ where: { responsavelId: null } });
  for (const setor of setores) {
    const gestor = await prisma.usuario.findFirst({
      where: { setorId: setor.id, ativo: true },
      orderBy: [{ perfil: "asc" }, { nome: "asc" }],
    });
    if (gestor) await prisma.setor.update({ where: { id: setor.id }, data: { responsavelId: gestor.id } });
  }

  console.log("Montando regimes tributários e grupos de obrigações...");
  for (const [nome, nomesTipos] of Object.entries(REGIMES)) {
    const regime = await prisma.regimeTributario.upsert({ where: { nome }, update: {}, create: { nome } });
    await prisma.regimeObrigacao.deleteMany({ where: { regimeId: regime.id } });
    await prisma.regimeObrigacao.createMany({ data: ids(nomesTipos).map((tipoId) => ({ regimeId: regime.id, tipoId })) });
  }
  for (const [nome, nomesTipos] of Object.entries(GRUPOS)) {
    const grupo = await prisma.grupoObrigacao.upsert({ where: { nome }, update: {}, create: { nome } });
    await prisma.grupoObrigacaoItem.deleteMany({ where: { grupoId: grupo.id } });
    await prisma.grupoObrigacaoItem.createMany({ data: ids(nomesTipos).map((tipoId) => ({ grupoId: grupo.id, tipoId })) });
  }

  console.log("Aplicando o regime de cada cliente (substitui as obrigações da empresa)...");
  const clientes = await prisma.cliente.findMany();
  for (const cliente of clientes) {
    const nomesTipos = cliente.regimeTributario ? REGIMES[cliente.regimeTributario] : undefined;
    if (!nomesTipos) continue;
    const tipoIds = ids(nomesTipos);
    await prisma.clienteObrigacao.updateMany({
      where: { clienteId: cliente.id, tipoId: { notIn: tipoIds } },
      data: { ativa: false },
    });
    await prisma.clienteObrigacao.updateMany({ where: { clienteId: cliente.id, tipoId: { in: tipoIds } }, data: { ativa: true } });
    await prisma.clienteObrigacao.createMany({
      data: tipoIds.map((tipoId) => ({ clienteId: cliente.id, tipoId })),
      skipDuplicates: true,
    });
  }

  // Pendências futuras que ninguém tocou são refeitas com as regras novas;
  // entregas feitas, justificadas, comentadas ou alteradas ficam como estão.
  const removidas = await removerFuturasIntocadas({});
  const criadas = await gerarJanela();
  console.log(`  Pendências futuras: ${removidas} refeitas → ${criadas} geradas (mês atual + 11).`);

  // Checagem rápida da regra (útil ao rodar manualmente).
  const { ano, mes } = mesAtual();
  const folha = REGRAS["Folha de Pagamento Mensal"];
  const proxima = calcularEntrega(folha, ano, mes + 1 > 12 ? 1 : mes + 1);
  if (proxima) {
    console.log(`  Ex.: Folha (5º dia útil) do próximo mês vence ${proxima.prazo.toLocaleDateString("pt-BR", { timeZone: "America/Fortaleza" })}`);
  }
}

// Execução direta (npm run prisma:seed-obrigacoes).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  configurarObrigacoes(prisma)
    .catch((erro) => {
      console.error(erro);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
