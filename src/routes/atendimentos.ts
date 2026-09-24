import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prisma } from "../prisma.js";

export const atendimentosRouter = Router();

atendimentosRouter.use(autenticar);

const atendimentoInclude = {
  cliente: { select: { id: true, razaoSocial: true, cnpj: true } },
  setor: true,
  responsavel: { select: { id: true, nome: true } },
} as const;

const statusEnum = z.enum(["AGUARDANDO", "EM_ATENDIMENTO", "FINALIZADO"]);

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

const criarAtendimentoSchema = z.object({
  motivo: z.string().min(1),
  observacoes: z.string().optional().nullable(),
  clienteId: z.string().uuid(),
  setorId: z.string().uuid(),
  responsavelId: z.string().uuid().optional().nullable(),
});

// Se nenhum responsável for informado, sugere automaticamente quem é o
// responsável desse cliente nesse setor (ClienteResponsavel) — é o
// "direcionamento automático" que o Emanuell descreveu.
atendimentosRouter.post("/atendimentos", asyncHandler(async (req, res) => {
  const parsed = criarAtendimentoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }

  let { responsavelId } = parsed.data;

  if (!responsavelId) {
    const responsavel = await prisma.clienteResponsavel.findUnique({
      where: { clienteId_setorId: { clienteId: parsed.data.clienteId, setorId: parsed.data.setorId } },
    });
    responsavelId = responsavel?.usuarioId ?? null;
  }

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

async function buscarAtendimentoOu404(id: string) {
  return prisma.atendimento.findUnique({ where: { id } });
}

atendimentosRouter.put("/atendimentos/:id", asyncHandler(async (req, res) => {
  const parsed = atualizarAtendimentoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }

  if (!(await buscarAtendimentoOu404(req.params.id))) {
    res.status(404).json({ erro: "Atendimento não encontrado" });
    return;
  }

  const atendimento = await prisma.atendimento.update({
    where: { id: req.params.id },
    data: parsed.data,
    include: atendimentoInclude,
  });
  res.json(atendimento);
}));

atendimentosRouter.post("/atendimentos/:id/iniciar", asyncHandler(async (req, res) => {
  if (!(await buscarAtendimentoOu404(req.params.id))) {
    res.status(404).json({ erro: "Atendimento não encontrado" });
    return;
  }

  const atendimento = await prisma.atendimento.update({
    where: { id: req.params.id },
    data: { status: "EM_ATENDIMENTO", iniciadoEm: new Date() },
    include: atendimentoInclude,
  });
  res.json(atendimento);
}));

atendimentosRouter.post("/atendimentos/:id/finalizar", asyncHandler(async (req, res) => {
  const existente = await buscarAtendimentoOu404(req.params.id);
  if (!existente) {
    res.status(404).json({ erro: "Atendimento não encontrado" });
    return;
  }

  const atendimento = await prisma.atendimento.update({
    where: { id: req.params.id },
    data: {
      status: "FINALIZADO",
      finalizadoEm: new Date(),
      iniciadoEm: existente.iniciadoEm ?? new Date(),
    },
    include: atendimentoInclude,
  });
  res.json(atendimento);
}));

atendimentosRouter.post("/atendimentos/:id/reabrir", asyncHandler(async (req, res) => {
  if (!(await buscarAtendimentoOu404(req.params.id))) {
    res.status(404).json({ erro: "Atendimento não encontrado" });
    return;
  }

  const atendimento = await prisma.atendimento.update({
    where: { id: req.params.id },
    data: { status: "AGUARDANDO", iniciadoEm: null, finalizadoEm: null },
    include: atendimentoInclude,
  });
  res.json(atendimento);
}));

atendimentosRouter.delete("/atendimentos/:id", asyncHandler(async (req, res) => {
  if (!(await buscarAtendimentoOu404(req.params.id))) {
    res.status(404).json({ erro: "Atendimento não encontrado" });
    return;
  }

  await prisma.atendimento.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));
