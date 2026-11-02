// Configuração das credenciais de sistema do SIEG (client_id/secret_key do
// integrador "Apta") e diagnóstico de conexão. Separado de
// configuracoes-integracao.ts porque o SIEG vai crescer bastante nas
// próximas fases (onboarding por cliente, sincronização de XMLs).
import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prisma } from "../prisma.js";
import { credenciaisConfiguradas, invalidarCache, obterTokenSistema } from "../sieg/auth.js";

export const configuracoesSiegRouter = Router();

configuracoesSiegRouter.use("/configuracoes/sieg", autenticar);

function podeAlterar(req: Request): boolean {
  return req.usuario?.perfil === "ADMIN" || req.usuario?.perfil === "GESTOR";
}

function mascarar(valor: string | null): string | null {
  if (!valor) return null;
  return valor.length <= 4 ? "••••" : `••••••••${valor.slice(-4)}`;
}

configuracoesSiegRouter.get("/configuracoes/sieg", asyncHandler(async (_req, res) => {
  const config = await prisma.configuracaoSieg.findUnique({ where: { id: 1 } });
  const clientId = config?.clientId || process.env.SIEG_CLIENT_ID || null;
  const secretKey = config?.secretKey || process.env.SIEG_SECRET_KEY || null;
  res.json({
    clientIdConfigurado: Boolean(clientId),
    secretKeyMascarada: mascarar(secretKey),
    origem: config?.clientId ? "banco" : process.env.SIEG_CLIENT_ID ? "ambiente" : "nenhuma",
  });
}));

const siegSchema = z.object({
  clientId: z.string().trim().min(1).optional(),
  secretKey: z.string().trim().min(1).optional(),
});

configuracoesSiegRouter.put("/configuracoes/sieg", asyncHandler(async (req, res) => {
  if (!podeAlterar(req)) {
    res.status(403).json({ erro: "Apenas administradores e gestores podem alterar esta configuração" });
    return;
  }
  const parsed = siegSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  await prisma.configuracaoSieg.upsert({
    where: { id: 1 },
    create: { id: 1, ...parsed.data },
    update: parsed.data,
  });
  invalidarCache();
  res.status(204).send();
}));

// Tenta de fato autenticar no SIEG com as credenciais atuais — é o que o
// botão "Testar conexão" da tela de Integrações chama.
configuracoesSiegRouter.get("/configuracoes/sieg/status", asyncHandler(async (_req, res) => {
  if (!(await credenciaisConfiguradas())) {
    res.json({ ok: false, erro: "Credenciais não configuradas" });
    return;
  }
  try {
    await obterTokenSistema();
    res.json({ ok: true });
  } catch (error) {
    res.json({ ok: false, erro: error instanceof Error ? error.message : String(error) });
  }
}));
