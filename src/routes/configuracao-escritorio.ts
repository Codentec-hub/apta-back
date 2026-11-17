import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { somenteAdmin } from "../middleware/perfil.js";
import { prisma } from "../prisma.js";
import { carregarEscritorio, escritorio } from "../escritorio.js";

export const configuracaoEscritorioRouter = Router();

configuracaoEscritorioRouter.use("/configuracoes/escritorio", autenticar);

configuracaoEscritorioRouter.get("/configuracoes/escritorio", asyncHandler(async (_req, res) => {
  res.json(await carregarEscritorio().catch(() => escritorio()));
}));

const opcional = z.string().trim().max(300).optional().nullable().transform((v) => (v ? v : null));
const schema = z.object({
  nome: z.string().trim().min(1, "Informe o nome do escritório").max(120),
  razaoSocial: opcional,
  cnpj: opcional.transform((v) => (v ? v.replace(/\D/g, "") || null : null)),
  crc: opcional,
  responsavelTecnico: opcional,
  email: z.string().trim().email("E-mail inválido").optional().nullable().or(z.literal("")).transform((v) => v || null),
  telefone: opcional,
  whatsapp: opcional,
  site: opcional,
  endereco: opcional,
  cidade: z.string().trim().min(1, "Informe a cidade"),
  uf: z.string().trim().length(2, "UF com 2 letras").transform((v) => v.toUpperCase()),
  assinaturaMensagens: z.string().trim().max(500).optional().nullable().transform((v) => v || null),
});

configuracaoEscritorioRouter.put("/configuracoes/escritorio", somenteAdmin, asyncHandler(async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.issues[0]?.message ?? "Dados inválidos" });
    return;
  }
  await prisma.configuracaoEscritorio.upsert({ where: { id: 1 }, create: { id: 1, ...parsed.data }, update: parsed.data });
  res.json(await carregarEscritorio());
}));
