import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prisma } from "../prisma.js";

export const financeiroRouter = Router();

financeiroRouter.use(autenticar);

const lancamentoInclude = {
  cliente: { select: { id: true, razaoSocial: true, cnpj: true } },
} as const;

const tipoEnum = z.enum(["PAGAR", "RECEBER"]);

financeiroRouter.get("/financeiro/lancamentos", asyncHandler(async (req, res) => {
  const { clienteId, tipo } = req.query;
  const tipoParsed = tipoEnum.safeParse(tipo);

  const lancamentos = await prisma.lancamentoFinanceiro.findMany({
    where: {
      ...(typeof clienteId === "string" ? { clienteId } : {}),
      ...(tipoParsed.success ? { tipo: tipoParsed.data } : {}),
    },
    orderBy: { vencimento: "asc" },
    include: lancamentoInclude,
  });
  res.json(lancamentos);
}));

const criarLancamentoSchema = z.object({
  tipo: tipoEnum,
  descricao: z.string().min(1),
  categoria: z.string().optional().nullable(),
  valor: z.coerce.number().positive(),
  vencimento: z.coerce.date(),
  clienteId: z.string().uuid().optional().nullable(),
});

financeiroRouter.post("/financeiro/lancamentos", asyncHandler(async (req, res) => {
  const parsed = criarLancamentoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }

  const lancamento = await prisma.lancamentoFinanceiro.create({
    data: parsed.data,
    include: lancamentoInclude,
  });
  res.status(201).json(lancamento);
}));

const atualizarLancamentoSchema = z.object({
  descricao: z.string().min(1).optional(),
  categoria: z.string().optional().nullable(),
  valor: z.coerce.number().positive().optional(),
  vencimento: z.coerce.date().optional(),
  clienteId: z.string().uuid().optional().nullable(),
});

async function buscarLancamentoOu404(id: string) {
  return prisma.lancamentoFinanceiro.findUnique({ where: { id } });
}

financeiroRouter.put("/financeiro/lancamentos/:id", asyncHandler(async (req, res) => {
  const parsed = atualizarLancamentoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }

  if (!(await buscarLancamentoOu404(req.params.id))) {
    res.status(404).json({ erro: "Lançamento não encontrado" });
    return;
  }

  const lancamento = await prisma.lancamentoFinanceiro.update({
    where: { id: req.params.id },
    data: parsed.data,
    include: lancamentoInclude,
  });
  res.json(lancamento);
}));

financeiroRouter.post("/financeiro/lancamentos/:id/liquidar", asyncHandler(async (req, res) => {
  if (!(await buscarLancamentoOu404(req.params.id))) {
    res.status(404).json({ erro: "Lançamento não encontrado" });
    return;
  }

  const lancamento = await prisma.lancamentoFinanceiro.update({
    where: { id: req.params.id },
    data: { liquidadoEm: new Date() },
    include: lancamentoInclude,
  });
  res.json(lancamento);
}));

financeiroRouter.post("/financeiro/lancamentos/:id/reabrir", asyncHandler(async (req, res) => {
  if (!(await buscarLancamentoOu404(req.params.id))) {
    res.status(404).json({ erro: "Lançamento não encontrado" });
    return;
  }

  const lancamento = await prisma.lancamentoFinanceiro.update({
    where: { id: req.params.id },
    data: { liquidadoEm: null },
    include: lancamentoInclude,
  });
  res.json(lancamento);
}));

financeiroRouter.delete("/financeiro/lancamentos/:id", asyncHandler(async (req, res) => {
  if (!(await buscarLancamentoOu404(req.params.id))) {
    res.status(404).json({ erro: "Lançamento não encontrado" });
    return;
  }

  await prisma.lancamentoFinanceiro.delete({ where: { id: req.params.id } });
  res.status(204).send();
}));
