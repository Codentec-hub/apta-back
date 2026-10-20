// Cadastro dos agentes de IA ("Agente Apta": contador, financeiro...).
import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prisma } from "../prisma.js";

export const agentesRouter = Router();

agentesRouter.use(autenticar);

function podeGerenciar(req: Request): boolean {
  return req.usuario?.perfil === "ADMIN" || req.usuario?.perfil === "GESTOR";
}

const agenteInclude = { setor: { select: { id: true, nome: true } } } as const;

agentesRouter.get("/agentes", asyncHandler(async (_req, res) => {
  res.json(await prisma.agenteIA.findMany({ orderBy: { nome: "asc" }, include: agenteInclude }));
}));

const agenteSchema = z.object({
  nome: z.string().trim().min(1),
  descricao: z.string().trim().optional().nullable(),
  instrucoes: z.string().optional(),
  setorId: z.string().uuid().optional().nullable(),
  ativo: z.boolean().optional(),
});

agentesRouter.post("/agentes", asyncHandler(async (req, res) => {
  if (!podeGerenciar(req)) {
    res.status(403).json({ erro: "Apenas administradores e gestores podem cadastrar agentes" });
    return;
  }
  const parsed = agenteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  if (await prisma.agenteIA.findUnique({ where: { nome: parsed.data.nome } })) {
    res.status(409).json({ erro: "Já existe um agente com esse nome" });
    return;
  }
  res.status(201).json(await prisma.agenteIA.create({ data: parsed.data, include: agenteInclude }));
}));

agentesRouter.put("/agentes/:id", asyncHandler(async (req, res) => {
  if (!podeGerenciar(req)) {
    res.status(403).json({ erro: "Apenas administradores e gestores podem alterar agentes" });
    return;
  }
  const parsed = agenteSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  if (!(await prisma.agenteIA.findUnique({ where: { id: req.params.id } }))) {
    res.status(404).json({ erro: "Agente não encontrado" });
    return;
  }
  if (parsed.data.nome) {
    const outro = await prisma.agenteIA.findUnique({ where: { nome: parsed.data.nome } });
    if (outro && outro.id !== req.params.id) {
      res.status(409).json({ erro: "Já existe um agente com esse nome" });
      return;
    }
  }
  res.json(await prisma.agenteIA.update({ where: { id: req.params.id }, data: parsed.data, include: agenteInclude }));
}));
