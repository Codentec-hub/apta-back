// Configuração geral do envio de e-mails ao cliente — hoje, o lembrete de
// guia não lida (dias antes do vencimento, prefixo do assunto, aviso no topo).
import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { emailConfigurado } from "../envio/email.js";
import { configuracaoEnvio } from "../obrigacoes/alerta-nao-lida.js";
import { prisma } from "../prisma.js";

export const configuracaoEnvioRouter = Router();

configuracaoEnvioRouter.use("/configuracoes/envio", autenticar);

function podeAlterar(req: Request): boolean {
  return req.usuario?.perfil === "ADMIN" || req.usuario?.perfil === "GESTOR";
}

function resposta(config: Awaited<ReturnType<typeof configuracaoEnvio>>) {
  return {
    diasAlertaNaoLida: [...config.diasAlertaNaoLida].sort((a, b) => b - a),
    prefixoAlertaNaoLida: config.prefixoAlertaNaoLida,
    avisoCabecalho: config.avisoCabecalho,
    emailConfigurado: emailConfigurado(),
  };
}

configuracaoEnvioRouter.get("/configuracoes/envio", asyncHandler(async (_req, res) => {
  res.json(resposta(await configuracaoEnvio()));
}));

const configuracaoSchema = z.object({
  diasAlertaNaoLida: z.array(z.number().int().min(0).max(60)).max(10),
  prefixoAlertaNaoLida: z.string().trim().max(60),
  avisoCabecalho: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .transform((v) => v || null),
});

configuracaoEnvioRouter.put("/configuracoes/envio", asyncHandler(async (req, res) => {
  if (!podeAlterar(req)) {
    res.status(403).json({ erro: "Apenas administradores e gestores podem alterar a configuração de envio" });
    return;
  }
  const parsed = configuracaoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "Dados inválidos: dias entre 0 e 60, prefixo até 60 caracteres, aviso até 500" });
    return;
  }
  const data = { ...parsed.data, diasAlertaNaoLida: [...new Set(parsed.data.diasAlertaNaoLida)] };
  const config = await prisma.configuracaoEnvio.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  res.json(resposta(config));
}));
