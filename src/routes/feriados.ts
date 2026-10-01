// Cadastro de feriados estaduais/municipais (os nacionais são calculados em
// prazos.ts). Mudou um feriado → pendências futuras intocadas são refeitas
// para que o "Nº dia útil" reflita o calendário novo.
import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { recarregarFeriados } from "../obrigacoes/feriados.js";
import { gerarJanela, removerFuturasIntocadas } from "../obrigacoes/gerar-entregas.js";
import { prisma } from "../prisma.js";

export const feriadosRouter = Router();

feriadosRouter.use(autenticar);

function podeEditar(req: Request): boolean {
  return req.usuario?.perfil === "ADMIN" || req.usuario?.perfil === "GESTOR";
}

const feriadoSchema = z.object({
  data: z.string().date(),
  descricao: z.string().trim().min(1),
  recorrente: z.boolean().default(true),
  uf: z
    .string()
    .trim()
    .length(2)
    .transform((v) => v.toUpperCase())
    .optional()
    .nullable(),
  cidade: z.string().trim().min(1).optional().nullable(),
});

async function aplicarCalendarioNovo(): Promise<{ removidas: number; criadas: number }> {
  await recarregarFeriados();
  const removidas = await removerFuturasIntocadas({});
  const criadas = await gerarJanela();
  return { removidas, criadas };
}

feriadosRouter.get("/feriados", asyncHandler(async (_req, res) => {
  const feriados = await prisma.feriado.findMany({ orderBy: [{ uf: "asc" }, { cidade: "asc" }, { data: "asc" }] });
  res.json(feriados);
}));

feriadosRouter.post("/feriados", asyncHandler(async (req, res) => {
  if (!podeEditar(req)) {
    res.status(403).json({ erro: "Sem permissão para alterar feriados" });
    return;
  }
  const parsed = feriadoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  if (parsed.data.cidade && !parsed.data.uf) {
    res.status(400).json({ erro: "Feriado municipal precisa da UF" });
    return;
  }
  const feriado = await prisma.feriado.create({ data: { ...parsed.data, data: new Date(parsed.data.data) } });
  res.status(201).json({ feriado, recalculo: await aplicarCalendarioNovo() });
}));

feriadosRouter.put("/feriados/:id", asyncHandler(async (req, res) => {
  if (!podeEditar(req)) {
    res.status(403).json({ erro: "Sem permissão para alterar feriados" });
    return;
  }
  const parsed = feriadoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  if (parsed.data.cidade && !parsed.data.uf) {
    res.status(400).json({ erro: "Feriado municipal precisa da UF" });
    return;
  }
  const existente = await prisma.feriado.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Feriado não encontrado" });
    return;
  }
  const feriado = await prisma.feriado.update({
    where: { id: req.params.id },
    data: { ...parsed.data, data: new Date(parsed.data.data) },
  });
  res.json({ feriado, recalculo: await aplicarCalendarioNovo() });
}));

feriadosRouter.delete("/feriados/:id", asyncHandler(async (req, res) => {
  if (!podeEditar(req)) {
    res.status(403).json({ erro: "Sem permissão para alterar feriados" });
    return;
  }
  const existente = await prisma.feriado.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Feriado não encontrado" });
    return;
  }
  await prisma.feriado.delete({ where: { id: req.params.id } });
  res.json({ recalculo: await aplicarCalendarioNovo() });
}));
