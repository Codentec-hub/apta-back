// Saúde fiscal do cliente, pendências e relatório mensal enviado ao cliente.
import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { emailConfigurado } from "../envio/email.js";
import { prisma } from "../prisma.js";
import { montarSaudeFiscal, pendenciasDoCliente } from "../saude-fiscal/dados.js";
import {
  clientesDoLote,
  enviarLote,
  enviarPendencias,
  estadoEnvioLote,
  gerarRelatorio,
  linkSaudeFiscal,
} from "../saude-fiscal/envio.js";
import { provedorWhatsApp } from "../whatsapp/provedor.js";

export const saudeFiscalRouter = Router();
export const saudeFiscalPublicoRouter = Router();

saudeFiscalRouter.use(["/clientes/:id/saude-fiscal", "/clientes/:id/pendencias", "/saude-fiscal"], autenticar);

const mesSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mês no formato AAAA-MM");
const canaisSchema = z.array(z.enum(["email", "whatsapp"])).min(1, "Escolha ao menos um canal");
const podeGerir = (req: Request) => req.usuario?.perfil === "ADMIN" || req.usuario?.perfil === "GESTOR";

async function clienteExiste(id: string) {
  return Boolean(await prisma.cliente.findUnique({ where: { id }, select: { id: true } }));
}

const canaisDisponiveis = () => ({
  email: emailConfigurado(),
  whatsapp: true,
  whatsappSimulador: provedorWhatsApp().simulador,
});

// -------------------------------------------------------- saúde do cliente

saudeFiscalRouter.get("/clientes/:id/saude-fiscal", asyncHandler(async (req, res) => {
  const id = String(req.params["id"]);
  const mes = mesSchema.safeParse(req.query["mes"]);
  if (!mes.success) {
    res.status(400).json({ erro: "Informe o mês (AAAA-MM)" });
    return;
  }
  if (!(await clienteExiste(id))) {
    res.status(404).json({ erro: "Cliente não encontrado" });
    return;
  }
  res.json({ dados: await montarSaudeFiscal(id, mes.data), canais: canaisDisponiveis() });
}));

saudeFiscalRouter.get("/clientes/:id/saude-fiscal/relatorios", asyncHandler(async (req, res) => {
  const relatorios = await prisma.relatorioSaudeFiscal.findMany({
    where: { clienteId: String(req.params["id"]) },
    select: { id: true, numero: true, token: true, mes: true, automatico: true, envios: true, lidoEm: true, acessos: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 24,
  });
  res.json(relatorios.map((r) => ({ ...r, link: linkSaudeFiscal(r.token) })));
}));

saudeFiscalRouter.post("/clientes/:id/saude-fiscal/relatorios", asyncHandler(async (req, res) => {
  const id = String(req.params["id"]);
  const parsed = z
    .object({
      mes: mesSchema,
      enviar: z.boolean().default(false),
      canais: canaisSchema.optional(),
      contatoIds: z.array(z.string().uuid()).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.issues[0]?.message ?? "Dados inválidos" });
    return;
  }
  if (!(await clienteExiste(id))) {
    res.status(404).json({ erro: "Cliente não encontrado" });
    return;
  }
  const { mes, enviar, canais, contatoIds } = parsed.data;
  const r = await gerarRelatorio({
    clienteId: id,
    mes,
    usuarioId: req.usuario?.usuarioId ?? null,
    enviar: enviar ? { canais: canais ?? ["email", "whatsapp"], contatoIds } : null,
  });
  res.status(201).json({
    id: r.relatorio.id,
    numero: r.relatorio.numero,
    link: linkSaudeFiscal(r.relatorio.token),
    contatos: r.contatos,
    resultados: r.resultados,
  });
}));

// ------------------------------------------------------------- pendências

saudeFiscalRouter.get("/clientes/:id/pendencias", asyncHandler(async (req, res) => {
  const id = String(req.params["id"]);
  if (!(await clienteExiste(id))) {
    res.status(404).json({ erro: "Cliente não encontrado" });
    return;
  }
  res.json({ pendencias: await pendenciasDoCliente(id), canais: canaisDisponiveis() });
}));

saudeFiscalRouter.post("/clientes/:id/pendencias", asyncHandler(async (req, res) => {
  const id = String(req.params["id"]);
  const parsed = z
    .object({
      descricao: z.string().trim().min(3, "Descreva a pendência").max(300),
      prazo: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.issues[0]?.message ?? "Dados inválidos" });
    return;
  }
  if (!(await clienteExiste(id))) {
    res.status(404).json({ erro: "Cliente não encontrado" });
    return;
  }
  const p = await prisma.pendenciaCliente.create({
    data: {
      clienteId: id,
      descricao: parsed.data.descricao,
      prazo: parsed.data.prazo ? new Date(`${parsed.data.prazo}T00:00:00.000Z`) : null,
      usuarioId: req.usuario?.usuarioId ?? null,
    },
  });
  res.status(201).json(p);
}));

saudeFiscalRouter.post("/clientes/:id/pendencias/:pendenciaId/resolver", asyncHandler(async (req, res) => {
  const r = await prisma.pendenciaCliente.updateMany({
    where: { id: String(req.params["pendenciaId"]), clienteId: String(req.params["id"]), resolvidaEm: null },
    data: { resolvidaEm: new Date() },
  });
  if (r.count === 0) {
    res.status(404).json({ erro: "Pendência não encontrada ou já resolvida" });
    return;
  }
  res.status(204).end();
}));

saudeFiscalRouter.post("/clientes/:id/pendencias/enviar", asyncHandler(async (req, res) => {
  const id = String(req.params["id"]);
  const parsed = z
    .object({ canais: canaisSchema, contatoIds: z.array(z.string().uuid()).optional() })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.issues[0]?.message ?? "Dados inválidos" });
    return;
  }
  if (!(await clienteExiste(id))) {
    res.status(404).json({ erro: "Cliente não encontrado" });
    return;
  }
  try {
    res.json(await enviarPendencias(id, parsed.data.canais, parsed.data.contatoIds));
  } catch (error) {
    if (error instanceof Error && /Não há pendências/.test(error.message)) {
      res.status(409).json({ erro: error.message });
      return;
    }
    throw error;
  }
}));

// ------------------------------------------------- envio mensal (em lote)

saudeFiscalRouter.get("/saude-fiscal/configuracao", asyncHandler(async (_req, res) => {
  const config = await prisma.configuracaoEnvio.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  res.json({
    automatico: config.saudeFiscalAutomatico,
    dia: config.saudeFiscalDia,
    canais: config.saudeFiscalCanais,
    ultimoLote: config.saudeFiscalUltimoLote,
    clientesNoLote: (await clientesDoLote()).length,
    lote: estadoEnvioLote(),
    canaisDisponiveis: canaisDisponiveis(),
  });
}));

saudeFiscalRouter.put("/saude-fiscal/configuracao", asyncHandler(async (req, res) => {
  if (!podeGerir(req)) {
    res.status(403).json({ erro: "Apenas administradores e gestores podem alterar o envio mensal" });
    return;
  }
  const parsed = z
    .object({ automatico: z.boolean(), dia: z.number().int().min(1).max(28), canais: canaisSchema })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "Dados inválidos: dia entre 1 e 28 e ao menos um canal" });
    return;
  }
  const data = {
    saudeFiscalAutomatico: parsed.data.automatico,
    saudeFiscalDia: parsed.data.dia,
    saudeFiscalCanais: parsed.data.canais,
  };
  await prisma.configuracaoEnvio.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  res.json({ ok: true });
}));

saudeFiscalRouter.post("/saude-fiscal/enviar-todos", asyncHandler(async (req, res) => {
  if (req.usuario?.perfil !== "ADMIN") {
    res.status(403).json({ erro: "Apenas administradores podem enviar para todos os clientes" });
    return;
  }
  const parsed = z.object({ mes: mesSchema, canais: canaisSchema }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.issues[0]?.message ?? "Dados inválidos" });
    return;
  }
  if (estadoEnvioLote().situacao === "andamento") {
    res.status(409).json({ erro: "Já há um envio em lote em andamento" });
    return;
  }
  void enviarLote(parsed.data.mes, parsed.data.canais, { automatico: false, usuarioId: req.usuario.usuarioId }).catch((e) =>
    console.error("[saude-fiscal] falha no envio em lote", e),
  );
  res.json(estadoEnvioLote());
}));

// --------------------------------------------- link público (sem login)

saudeFiscalPublicoRouter.get("/publico/saude-fiscal/:token", asyncHandler(async (req, res) => {
  const r = await prisma.relatorioSaudeFiscal.findUnique({ where: { token: String(req.params["token"]) } });
  if (!r) {
    res.status(404).json({ erro: "Link inválido ou expirado" });
    return;
  }
  await prisma.relatorioSaudeFiscal.update({
    where: { id: r.id },
    data: { acessos: { increment: 1 }, lidoEm: r.lidoEm ?? new Date() },
  });
  res.json({ numero: r.numero, criadoEm: r.createdAt, dados: r.dados });
}));
