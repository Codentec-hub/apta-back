import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prisma } from "../prisma.js";
import { dadosFinalizar, dadosIniciar, dadosReabrir, responsavelSugerido, TransicaoInvalida } from "../atendimento/sessao.js";

export const atendimentosRouter = Router();

atendimentosRouter.use(autenticar);

function podeGerenciar(req: Request): boolean {
  return req.usuario?.perfil === "ADMIN" || req.usuario?.perfil === "GESTOR";
}

const atendimentoInclude = {
  cliente: { select: { id: true, razaoSocial: true, cnpj: true } },
  setor: true,
  responsavel: { select: { id: true, nome: true } },
  motivoCategoria: { select: { id: true, nome: true } },
} as const;

const statusEnum = z.enum(["TRIAGEM", "AGUARDANDO", "EM_ATENDIMENTO", "FINALIZADO"]);

atendimentosRouter.get("/atendimentos", asyncHandler(async (req, res) => {
  const { setorId, clienteId, status } = req.query;
  const statusParsed = statusEnum.safeParse(status);

  const atendimentos = await prisma.atendimento.findMany({
    where: {
      ...(typeof setorId === "string" ? { setorId } : {}),
      ...(typeof clienteId === "string" ? { clienteId } : {}),
      ...(statusParsed.success ? { status: statusParsed.data } : {}),
    },
    orderBy: { abertoEm: "asc" },
    include: atendimentoInclude,
  });
  res.json(atendimentos);
}));

const DIAS_PADRAO_RESUMO = 30;

function media(valores: number[]): number | null {
  return valores.length === 0 ? null : valores.reduce((soma, v) => soma + v, 0) / valores.length;
}

function minutosEntre(inicio: Date, fim: Date): number {
  return (fim.getTime() - inicio.getTime()) / 60_000;
}

// Indicadores do atendimento num período (relatórios do Suri): tempos
// médios, por setor/atendente, clientes que mais demandam e motivos.
atendimentosRouter.get("/atendimentos/resumo", asyncHandler(async (req, res) => {
  const dias = Math.min(Math.max(Number(req.query.dias) || DIAS_PADRAO_RESUMO, 1), 365);
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
  const atendimentos = await prisma.atendimento.findMany({
    where: { abertoEm: { gte: desde } },
    include: {
      setor: { select: { nome: true } },
      responsavel: { select: { nome: true } },
      cliente: { select: { id: true, razaoSocial: true } },
      motivoCategoria: { select: { nome: true } },
    },
  });

  const inicioHoje = new Date();
  inicioHoje.setHours(0, 0, 0, 0);

  type Grupo = { nome: string; total: number; esperas: number[]; duracoes: number[] };
  const agrupar = (chave: (a: (typeof atendimentos)[number]) => string | null) => {
    const grupos = new Map<string, Grupo>();
    for (const a of atendimentos) {
      const nome = chave(a);
      if (!nome) continue;
      const grupo = grupos.get(nome) ?? { nome, total: 0, esperas: [], duracoes: [] };
      grupo.total += 1;
      if (a.iniciadoEm) grupo.esperas.push(minutosEntre(a.abertoEm, a.iniciadoEm));
      if (a.iniciadoEm && a.finalizadoEm) grupo.duracoes.push(minutosEntre(a.iniciadoEm, a.finalizadoEm));
      grupos.set(nome, grupo);
    }
    return [...grupos.values()]
      .sort((x, y) => y.total - x.total)
      .map((g) => ({ nome: g.nome, total: g.total, esperaMedia: media(g.esperas), duracaoMedia: media(g.duracoes) }));
  };

  res.json({
    dias,
    total: atendimentos.length,
    tempoMedioEspera: media(atendimentos.filter((a) => a.iniciadoEm).map((a) => minutosEntre(a.abertoEm, a.iniciadoEm!))),
    tempoMedioAtendimento: media(
      atendimentos.filter((a) => a.iniciadoEm && a.finalizadoEm).map((a) => minutosEntre(a.iniciadoEm!, a.finalizadoEm!))
    ),
    finalizadosHoje: await prisma.atendimento.count({ where: { finalizadoEm: { gte: inicioHoje } } }),
    porSetor: agrupar((a) => a.setor?.nome ?? null),
    porResponsavel: agrupar((a) => a.responsavel?.nome ?? null),
    porMotivo: agrupar((a) => a.motivoCategoria?.nome ?? null),
    porCliente: agrupar((a) => a.cliente?.razaoSocial ?? null).slice(0, 10),
  });
}));

const criarAtendimentoSchema = z.object({
  motivo: z.string().min(1),
  observacoes: z.string().optional().nullable(),
  clienteId: z.string().uuid(),
  setorId: z.string().uuid(),
  responsavelId: z.string().uuid().optional().nullable(),
});

// Registro manual (telefone, presencial). Se nenhum responsável for
// informado, sugere quem é o responsável desse cliente nesse setor — é o
// "direcionamento automático" que o Emanuell descreveu.
atendimentosRouter.post("/atendimentos", asyncHandler(async (req, res) => {
  const parsed = criarAtendimentoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }

  const responsavelId =
    parsed.data.responsavelId ?? (await responsavelSugerido(parsed.data.clienteId, parsed.data.setorId));

  const atendimento = await prisma.atendimento.create({
    data: { ...parsed.data, responsavelId },
    include: atendimentoInclude,
  });
  res.status(201).json(atendimento);
}));

const atualizarAtendimentoSchema = z.object({
  motivo: z.string().min(1).optional(),
  observacoes: z.string().optional().nullable(),
  setorId: z.string().uuid().optional(),
  responsavelId: z.string().uuid().optional().nullable(),
});

async function buscarAtendimentoOu404(req: Request, res: Response) {
  const atendimento = await prisma.atendimento.findUnique({ where: { id: req.params.id } });
  if (!atendimento) {
    res.status(404).json({ erro: "Atendimento não encontrado" });
  }
  return atendimento;
}

atendimentosRouter.put("/atendimentos/:id", asyncHandler(async (req, res) => {
  const parsed = atualizarAtendimentoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }

  if (!(await buscarAtendimentoOu404(req, res))) return;

  const atendimento = await prisma.atendimento.update({
    where: { id: req.params.id },
    data: parsed.data,
    include: atendimentoInclude,
  });
  res.json(atendimento);
}));

const finalizarSchema = z.object({ motivoId: z.string().uuid().optional().nullable() });

// Transições validadas: não dá para "iniciar" duas vezes nem finalizar de
// novo um finalizado (antes as datas eram sobrescritas e as médias mentiam).
const transicoes = {
  iniciar: (a: Parameters<typeof dadosIniciar>[0], req: Request) => dadosIniciar(a, req.usuario?.usuarioId),
  finalizar: (a: Parameters<typeof dadosFinalizar>[0], req: Request) =>
    dadosFinalizar(a, finalizarSchema.safeParse(req.body ?? {}).data?.motivoId),
  reabrir: (a: Parameters<typeof dadosReabrir>[0]) => dadosReabrir(a),
};

for (const [acao, calcular] of Object.entries(transicoes)) {
  atendimentosRouter.post(`/atendimentos/:id/${acao}`, asyncHandler(async (req, res) => {
    const existente = await buscarAtendimentoOu404(req, res);
    if (!existente) return;
    let data;
    try {
      data = calcular(existente, req);
    } catch (error) {
      if (error instanceof TransicaoInvalida) {
        res.status(409).json({ erro: error.message });
        return;
      }
      throw error;
    }
    res.json(await prisma.atendimento.update({ where: { id: existente.id }, data, include: atendimentoInclude }));
  }));
}

// Excluir apaga também os tempos dos relatórios, então fica restrito.
atendimentosRouter.delete("/atendimentos/:id", asyncHandler(async (req, res) => {
  if (!podeGerenciar(req)) {
    res.status(403).json({ erro: "Apenas administradores e gestores podem excluir atendimentos" });
    return;
  }
  if (!(await buscarAtendimentoOu404(req, res))) return;

  await prisma.atendimento.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));

// Motivos categorizados ("principais motivos" nos relatórios).
atendimentosRouter.get("/motivos-atendimento", asyncHandler(async (_req, res) => {
  res.json(await prisma.motivoAtendimento.findMany({ orderBy: { nome: "asc" } }));
}));

const motivoSchema = z.object({ nome: z.string().trim().min(1), ativo: z.boolean().optional() });

atendimentosRouter.post("/motivos-atendimento", asyncHandler(async (req, res) => {
  if (!podeGerenciar(req)) {
    res.status(403).json({ erro: "Apenas administradores e gestores podem cadastrar motivos" });
    return;
  }
  const parsed = motivoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  if (await prisma.motivoAtendimento.findUnique({ where: { nome: parsed.data.nome } })) {
    res.status(409).json({ erro: "Já existe um motivo com esse nome" });
    return;
  }
  res.status(201).json(await prisma.motivoAtendimento.create({ data: parsed.data }));
}));

atendimentosRouter.put("/motivos-atendimento/:id", asyncHandler(async (req, res) => {
  if (!podeGerenciar(req)) {
    res.status(403).json({ erro: "Apenas administradores e gestores podem alterar motivos" });
    return;
  }
  const parsed = motivoSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  if (!(await prisma.motivoAtendimento.findUnique({ where: { id: req.params.id } }))) {
    res.status(404).json({ erro: "Motivo não encontrado" });
    return;
  }
  res.json(await prisma.motivoAtendimento.update({ where: { id: req.params.id }, data: parsed.data }));
}));
