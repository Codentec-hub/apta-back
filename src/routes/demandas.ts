import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prisma } from "../prisma.js";

export const demandasRouter = Router();

demandasRouter.use(autenticar);

const demandaInclude = {
  setor: true,
  cliente: { select: { id: true, razaoSocial: true, cnpj: true } },
  responsavel: { select: { id: true, nome: true } },
} as const;

demandasRouter.get("/demandas", asyncHandler(async (req, res) => {
  const { setorId, clienteId } = req.query;

  const demandas = await prisma.demanda.findMany({
    where: {
      ...(typeof setorId === "string" ? { setorId } : {}),
      ...(typeof clienteId === "string" ? { clienteId } : {}),
    },
    orderBy: { createdAt: "asc" },
    include: demandaInclude,
  });
  res.json(demandas);
}));

const statusEnum = z.enum(["A_FAZER", "EM_ANDAMENTO", "CONCLUIDA"]);

const criarDemandaSchema = z.object({
  titulo: z.string().min(1),
  descricao: z.string().optional().nullable(),
  setorId: z.string().uuid(),
  clienteId: z.string().uuid().optional().nullable(),
  responsavelId: z.string().uuid().optional().nullable(),
  status: statusEnum.optional(),
});

demandasRouter.post("/demandas", asyncHandler(async (req, res) => {
  const parsed = criarDemandaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }

  const demanda = await prisma.demanda.create({
    data: parsed.data,
    include: demandaInclude,
  });
  res.status(201).json(demanda);
}));

const atualizarDemandaSchema = z.object({
  titulo: z.string().min(1).optional(),
  descricao: z.string().optional().nullable(),
  setorId: z.string().uuid().optional(),
  clienteId: z.string().uuid().optional().nullable(),
  responsavelId: z.string().uuid().optional().nullable(),
  status: statusEnum.optional(),
});

demandasRouter.put("/demandas/:id", asyncHandler(async (req, res) => {
  const parsed = atualizarDemandaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }

  const existente = await prisma.demanda.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Demanda não encontrada" });
    return;
  }

  const demanda = await prisma.demanda.update({
    where: { id: req.params.id },
    data: parsed.data,
    include: demandaInclude,
  });
  res.json(demanda);
}));

demandasRouter.delete("/demandas/:id", asyncHandler(async (req, res) => {
  const existente = await prisma.demanda.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Demanda não encontrada" });
    return;
  }

  await prisma.demanda.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));
