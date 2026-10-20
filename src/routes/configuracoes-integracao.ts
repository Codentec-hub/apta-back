// Configuração básica das ferramentas externas usadas pelo sistema (Gemini,
// Evolution API). Guardada no banco pra poder ser trocada pela tela sem
// precisar de redeploy; tem prioridade sobre as variáveis de ambiente, que
// continuam servindo de valor padrão enquanto ninguém configurar por aqui.
import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prisma } from "../prisma.js";

export const configuracoesIntegracaoRouter = Router();

configuracoesIntegracaoRouter.use("/configuracoes/gemini", autenticar);
configuracoesIntegracaoRouter.use("/configuracoes/evolution", autenticar);

function podeAlterar(req: Request): boolean {
  return req.usuario?.perfil === "ADMIN" || req.usuario?.perfil === "GESTOR";
}

function mascarar(valor: string | null): string | null {
  if (!valor) return null;
  return valor.length <= 4 ? "••••" : `••••••••${valor.slice(-4)}`;
}

configuracoesIntegracaoRouter.get("/configuracoes/gemini", asyncHandler(async (_req, res) => {
  const config = await prisma.configuracaoGemini.findUnique({ where: { id: 1 } });
  res.json({
    modelo: config?.modelo || process.env.GEMINI_MODEL || "gemini-flash-latest",
    apiKeyConfigurada: Boolean(config?.apiKey || process.env.GEMINI_API_KEY),
    apiKeyMascarada: mascarar(config?.apiKey ?? null),
    origem: config?.apiKey ? "banco" : process.env.GEMINI_API_KEY ? "ambiente" : "nenhuma",
  });
}));

const geminiSchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
  modelo: z.string().trim().min(1).max(100).optional(),
});

configuracoesIntegracaoRouter.put("/configuracoes/gemini", asyncHandler(async (req, res) => {
  if (!podeAlterar(req)) {
    res.status(403).json({ erro: "Apenas administradores e gestores podem alterar esta configuração" });
    return;
  }
  const parsed = geminiSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  await prisma.configuracaoGemini.upsert({
    where: { id: 1 },
    create: { id: 1, ...parsed.data },
    update: parsed.data,
  });
  res.status(204).send();
}));

configuracoesIntegracaoRouter.get("/configuracoes/evolution", asyncHandler(async (_req, res) => {
  const config = await prisma.configuracaoEvolution.findUnique({ where: { id: 1 } });
  res.json({
    url: config?.url || process.env.EVOLUTION_API_URL || null,
    instancia: config?.instancia || process.env.EVOLUTION_INSTANCE || null,
    apiKeyConfigurada: Boolean(config?.apiKey || process.env.EVOLUTION_API_KEY),
    apiKeyMascarada: mascarar(config?.apiKey ?? null),
    origem: config?.apiKey ? "banco" : process.env.EVOLUTION_API_KEY ? "ambiente" : "nenhuma",
  });
}));

const evolutionSchema = z.object({
  url: z.string().trim().url().optional(),
  apiKey: z.string().trim().min(1).optional(),
  instancia: z.string().trim().min(1).max(100).optional(),
});

configuracoesIntegracaoRouter.put("/configuracoes/evolution", asyncHandler(async (req, res) => {
  if (!podeAlterar(req)) {
    res.status(403).json({ erro: "Apenas administradores e gestores podem alterar esta configuração" });
    return;
  }
  const parsed = evolutionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  await prisma.configuracaoEvolution.upsert({
    where: { id: 1 },
    create: { id: 1, ...parsed.data },
    update: parsed.data,
  });
  res.status(204).send();
}));
