// Regimes tributários, grupos de obrigações e obrigações alocadas nas
// empresas — a parte de "cadastro" do Acessórias que decide quais entregas
// cada cliente gera por competência.
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { gerarJanela, removerFuturasIntocadas } from "../obrigacoes/gerar-entregas.js";
import { prisma } from "../prisma.js";

export const cadastroObrigacoesRouter = Router();

cadastroObrigacoesRouter.use(autenticar);

const conjuntoSchema = z.object({
  nome: z.string().min(1),
  tipoIds: z.array(z.string().uuid()),
});

// --- Regimes tributários ---

const regimeInclude = { obrigacoes: { select: { tipoId: true } } } as const;

cadastroObrigacoesRouter.get("/regimes", asyncHandler(async (_req, res) => {
  const regimes = await prisma.regimeTributario.findMany({ orderBy: { nome: "asc" }, include: regimeInclude });
  res.json(regimes.map(({ obrigacoes, ...r }) => ({ ...r, tipoIds: obrigacoes.map((o) => o.tipoId) })));
}));

cadastroObrigacoesRouter.post("/regimes", asyncHandler(async (req, res) => {
  const parsed = conjuntoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  if (await prisma.regimeTributario.findUnique({ where: { nome: parsed.data.nome } })) {
    res.status(409).json({ erro: "Já existe um regime com este nome" });
    return;
  }
  const regime = await prisma.regimeTributario.create({
    data: { nome: parsed.data.nome, obrigacoes: { create: parsed.data.tipoIds.map((tipoId) => ({ tipoId })) } },
  });
  res.status(201).json({ ...regime, tipoIds: parsed.data.tipoIds });
}));

cadastroObrigacoesRouter.put("/regimes/:id", asyncHandler(async (req, res) => {
  const parsed = conjuntoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const existente = await prisma.regimeTributario.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Regime não encontrado" });
    return;
  }
  const outroComNome = await prisma.regimeTributario.findUnique({ where: { nome: parsed.data.nome } });
  if (outroComNome && outroComNome.id !== existente.id) {
    res.status(409).json({ erro: "Já existe um regime com este nome" });
    return;
  }
  const regime = await prisma.$transaction(async (tx) => {
    await tx.regimeObrigacao.deleteMany({ where: { regimeId: existente.id } });
    // Renomear o regime mantém os clientes que já estavam nele.
    if (existente.nome !== parsed.data.nome) {
      await tx.cliente.updateMany({ where: { regimeTributario: existente.nome }, data: { regimeTributario: parsed.data.nome } });
    }
    return tx.regimeTributario.update({
      where: { id: existente.id },
      data: { nome: parsed.data.nome, obrigacoes: { create: parsed.data.tipoIds.map((tipoId) => ({ tipoId })) } },
    });
  });
  res.json({ ...regime, tipoIds: parsed.data.tipoIds });
}));

cadastroObrigacoesRouter.delete("/regimes/:id", asyncHandler(async (req, res) => {
  const existente = await prisma.regimeTributario.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Regime não encontrado" });
    return;
  }
  await prisma.regimeTributario.delete({ where: { id: existente.id } });
  res.status(204).send();
}));

// --- Grupos de obrigações ---

cadastroObrigacoesRouter.get("/grupos-obrigacao", asyncHandler(async (_req, res) => {
  const grupos = await prisma.grupoObrigacao.findMany({
    orderBy: { nome: "asc" },
    include: { obrigacoes: { select: { tipoId: true } } },
  });
  res.json(grupos.map(({ obrigacoes, ...g }) => ({ ...g, tipoIds: obrigacoes.map((o) => o.tipoId) })));
}));

cadastroObrigacoesRouter.post("/grupos-obrigacao", asyncHandler(async (req, res) => {
  const parsed = conjuntoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  if (await prisma.grupoObrigacao.findUnique({ where: { nome: parsed.data.nome } })) {
    res.status(409).json({ erro: "Já existe um grupo com este nome" });
    return;
  }
  const grupo = await prisma.grupoObrigacao.create({
    data: { nome: parsed.data.nome, obrigacoes: { create: parsed.data.tipoIds.map((tipoId) => ({ tipoId })) } },
  });
  res.status(201).json({ ...grupo, tipoIds: parsed.data.tipoIds });
}));

cadastroObrigacoesRouter.put("/grupos-obrigacao/:id", asyncHandler(async (req, res) => {
  const parsed = conjuntoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const existente = await prisma.grupoObrigacao.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Grupo não encontrado" });
    return;
  }
  const outroComNome = await prisma.grupoObrigacao.findUnique({ where: { nome: parsed.data.nome } });
  if (outroComNome && outroComNome.id !== existente.id) {
    res.status(409).json({ erro: "Já existe um grupo com este nome" });
    return;
  }
  const grupo = await prisma.$transaction(async (tx) => {
    await tx.grupoObrigacaoItem.deleteMany({ where: { grupoId: existente.id } });
    return tx.grupoObrigacao.update({
      where: { id: existente.id },
      data: { nome: parsed.data.nome, obrigacoes: { create: parsed.data.tipoIds.map((tipoId) => ({ tipoId })) } },
    });
  });
  res.json({ ...grupo, tipoIds: parsed.data.tipoIds });
}));

cadastroObrigacoesRouter.delete("/grupos-obrigacao/:id", asyncHandler(async (req, res) => {
  const existente = await prisma.grupoObrigacao.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Grupo não encontrado" });
    return;
  }
  await prisma.grupoObrigacao.delete({ where: { id: existente.id } });
  res.status(204).send();
}));

// --- Obrigações da empresa ---

const clienteObrigacaoInclude = {
  tipo: { include: { setor: true } },
  responsavel: { select: { id: true, nome: true } },
} as const;

type Contadores = { entregues: number; atrasoTecnico: number; proximos30: number; futuras: number };

// Contadores do cadastro da empresa no Acessórias, por obrigação:
// Entregues/Resolvidas · Atraso téc. · Próx. 30 dias · Futuras 30d+.
async function contadoresDaEmpresa(clienteId: string): Promise<Map<string, Contadores>> {
  const entregas = await prisma.obrigacao.findMany({
    where: { clienteId, tipoId: { not: null } },
    select: { tipoId: true, concluidaEm: true, dispensada: true, prazo: true, prazoTecnico: true },
  });
  const agora = Date.now();
  const em30 = agora + 30 * 24 * 3600 * 1000;
  const mapa = new Map<string, Contadores>();
  for (const e of entregas) {
    const c = mapa.get(e.tipoId!) ?? { entregues: 0, atrasoTecnico: 0, proximos30: 0, futuras: 0 };
    const referencia = (e.prazoTecnico ?? e.prazo).getTime();
    if (e.concluidaEm || e.dispensada) c.entregues += 1;
    else if (referencia < agora) c.atrasoTecnico += 1;
    else if (referencia <= em30) c.proximos30 += 1;
    else c.futuras += 1;
    mapa.set(e.tipoId!, c);
  }
  return mapa;
}

async function listarDaEmpresa(clienteId: string) {
  const [itens, contadores] = await Promise.all([
    prisma.clienteObrigacao.findMany({
      where: { clienteId },
      include: clienteObrigacaoInclude,
      orderBy: [{ tipo: { setor: { nome: "asc" } } }, { tipo: { nome: "asc" } }],
    }),
    contadoresDaEmpresa(clienteId),
  ]);
  return itens.map((item) => ({
    ...item,
    contadores: contadores.get(item.tipoId) ?? { entregues: 0, atrasoTecnico: 0, proximos30: 0, futuras: 0 },
  }));
}

cadastroObrigacoesRouter.get("/clientes/:id/obrigacoes", asyncHandler(async (req, res) => {
  res.json(await listarDaEmpresa(req.params.id));
}));

// Aloca obrigações avulsas na empresa (reativa se já existiam inativas).
cadastroObrigacoesRouter.post("/clientes/:id/obrigacoes", asyncHandler(async (req, res) => {
  const parsed = z.object({ tipoIds: z.array(z.string().uuid()).min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const cliente = await prisma.cliente.findUnique({ where: { id: req.params.id } });
  if (!cliente) {
    res.status(404).json({ erro: "Cliente não encontrado" });
    return;
  }
  await alocar(cliente.id, parsed.data.tipoIds);
  res.json(await listarDaEmpresa(cliente.id));
}));

async function alocar(clienteId: string, tipoIds: string[]): Promise<void> {
  await prisma.$transaction([
    prisma.clienteObrigacao.updateMany({ where: { clienteId, tipoId: { in: tipoIds } }, data: { ativa: true } }),
    prisma.clienteObrigacao.createMany({
      data: tipoIds.map((tipoId) => ({ clienteId, tipoId })),
      skipDuplicates: true,
    }),
  ]);
  await gerarJanela({ clienteId });
}

// Aplicar regime: SUBSTITUI as obrigações da empresa pelas do regime — as
// que não estão no regime ficam inativas (o histórico de entregas fica).
cadastroObrigacoesRouter.post("/clientes/:id/aplicar-regime", asyncHandler(async (req, res) => {
  const parsed = z.object({ regimeId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const cliente = await prisma.cliente.findUnique({ where: { id: req.params.id } });
  const regime = await prisma.regimeTributario.findUnique({
    where: { id: parsed.data.regimeId },
    include: { obrigacoes: true },
  });
  if (!cliente || !regime) {
    res.status(404).json({ erro: "Cliente ou regime não encontrado" });
    return;
  }
  const tipoIds = regime.obrigacoes.map((o) => o.tipoId);
  const saindo = await prisma.clienteObrigacao.findMany({
    where: { clienteId: cliente.id, ativa: true, tipoId: { notIn: tipoIds } },
    select: { tipoId: true },
  });
  if (saindo.length > 0) {
    await removerFuturasIntocadas({ clienteId: cliente.id, tipoId: { in: saindo.map((s) => s.tipoId) } });
  }
  await prisma.$transaction([
    prisma.clienteObrigacao.updateMany({
      where: { clienteId: cliente.id, tipoId: { notIn: tipoIds } },
      data: { ativa: false },
    }),
    prisma.cliente.update({ where: { id: cliente.id }, data: { regimeTributario: regime.nome } }),
  ]);
  if (tipoIds.length > 0) await alocar(cliente.id, tipoIds);
  res.json(await listarDaEmpresa(cliente.id));
}));

// Grupo: ADICIONA sem mexer no que já existe.
cadastroObrigacoesRouter.post("/clientes/:id/aplicar-grupo", asyncHandler(async (req, res) => {
  const parsed = z.object({ grupoId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const cliente = await prisma.cliente.findUnique({ where: { id: req.params.id } });
  const grupo = await prisma.grupoObrigacao.findUnique({
    where: { id: parsed.data.grupoId },
    include: { obrigacoes: true },
  });
  if (!cliente || !grupo) {
    res.status(404).json({ erro: "Cliente ou grupo não encontrado" });
    return;
  }
  const tipoIds = grupo.obrigacoes.map((o) => o.tipoId);
  if (tipoIds.length > 0) await alocar(cliente.id, tipoIds);
  res.json(await listarDaEmpresa(cliente.id));
}));

cadastroObrigacoesRouter.put("/cliente-obrigacoes/:id", asyncHandler(async (req, res) => {
  const parsed = z
    .object({
      ativa: z.boolean().optional(),
      responsavelId: z.string().uuid().nullable().optional(),
      tempoPrevistoMinutos: z.coerce.number().int().min(0).nullable().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const existente = await prisma.clienteObrigacao.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Obrigação da empresa não encontrada" });
    return;
  }
  await prisma.clienteObrigacao.update({ where: { id: existente.id }, data: parsed.data });

  // Inativar tira as pendências futuras intocadas; ativar gera as que faltam.
  // Trocar o responsável vale para as pendências futuras ainda sem dono
  // definido manualmente (as intocadas são refeitas).
  const filtro = { clienteId: existente.clienteId, tipoId: existente.tipoId };
  if (parsed.data.ativa === false && existente.ativa) {
    await removerFuturasIntocadas(filtro);
  } else if (parsed.data.ativa === true && !existente.ativa) {
    await gerarJanela(filtro);
  } else if (parsed.data.responsavelId !== undefined && parsed.data.responsavelId !== existente.responsavelId) {
    await removerFuturasIntocadas(filtro);
    await gerarJanela(filtro);
  }

  const lista = await listarDaEmpresa(existente.clienteId);
  res.json(lista.find((i) => i.id === existente.id));
}));
