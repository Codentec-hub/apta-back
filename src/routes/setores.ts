import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prisma } from "../prisma.js";

export const setoresRouter = Router();

setoresRouter.use(autenticar);

setoresRouter.get("/setores", asyncHandler(async (_req, res) => {
  const setores = await prisma.setor.findMany({
    orderBy: { nome: "asc" },
    include: { responsavel: { select: { id: true, nome: true } } },
  });
  res.json(setores);
}));

const setorSchema = z.object({
  nome: z.string().min(1),
  // Responsável padrão do departamento (usado nas entregas sem responsável
  // definido na empresa).
  responsavelId: z.string().uuid().nullable().optional(),
});

setoresRouter.post("/setores", asyncHandler(async (req, res) => {
  const parsed = setorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "nome é obrigatório" });
    return;
  }

  const jaExiste = await prisma.setor.findUnique({ where: { nome: parsed.data.nome } });
  if (jaExiste) {
    res.status(409).json({ erro: "Já existe um setor com este nome" });
    return;
  }

  const setor = await prisma.setor.create({
    data: parsed.data,
    include: { responsavel: { select: { id: true, nome: true } } },
  });
  res.status(201).json(setor);
}));

setoresRouter.put("/setores/:id", asyncHandler(async (req, res) => {
  const parsed = setorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "nome é obrigatório" });
    return;
  }

  const jaExiste = await prisma.setor.findFirst({
    where: { nome: parsed.data.nome, id: { not: req.params.id } },
  });
  if (jaExiste) {
    res.status(409).json({ erro: "Já existe um setor com este nome" });
    return;
  }

  const setorExistente = await prisma.setor.findUnique({ where: { id: req.params.id } });
  if (!setorExistente) {
    res.status(404).json({ erro: "Setor não encontrado" });
    return;
  }

  const setor = await prisma.setor.update({
    where: { id: req.params.id },
    data: parsed.data,
    include: { responsavel: { select: { id: true, nome: true } } },
  });
  res.json(setor);
}));
