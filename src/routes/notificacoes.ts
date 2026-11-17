// Central de notificações do usuário logado.
import type { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { emailConfigurado } from "../envio/email.js";
import { emitirEvento } from "../eventos.js";
import { prismaBase as prisma } from "../prisma.js";
import { TIPOS_NOTIFICACAO, ehTipo } from "../notificacoes/tipos.js";

export const notificacoesRouter = Router();

notificacoesRouter.use("/notificacoes", autenticar);

const avisar = (usuarioId: string) => emitirEvento({ tipo: "notificacao", usuarioId });

notificacoesRouter.get("/notificacoes", asyncHandler(async (req, res) => {
  const usuarioId = req.usuario!.usuarioId;
  const filtro = typeof req.query.filtro === "string" ? req.query.filtro : "todas";
  const categoria = typeof req.query.categoria === "string" && req.query.categoria ? req.query.categoria : undefined;
  const pagina = Math.max(1, Number(req.query.pagina) || 1);
  const porPagina = Math.min(100, Math.max(5, Number(req.query.porPagina) || 20));
  const where: Prisma.NotificacaoWhereInput = {
    usuarioId,
    categoria,
    ...(filtro === "arquivadas" ? { arquivadaEm: { not: null } } : { arquivadaEm: null }),
    ...(filtro === "nao_lidas" ? { lidaEm: null } : {}),
  };
  const [total, itens, naoLidas] = await Promise.all([
    prisma.notificacao.count({ where }),
    prisma.notificacao.findMany({ where, orderBy: { criadoEm: "desc" }, skip: (pagina - 1) * porPagina, take: porPagina }),
    prisma.notificacao.count({ where: { usuarioId, lidaEm: null, arquivadaEm: null } }),
  ]);
  res.json({ total, pagina, porPagina, naoLidas, itens });
}));

notificacoesRouter.get("/notificacoes/contagem", asyncHandler(async (req, res) => {
  const naoLidas = await prisma.notificacao.count({ where: { usuarioId: req.usuario!.usuarioId, lidaEm: null, arquivadaEm: null } });
  res.json({ naoLidas });
}));

const idsSchema = z.object({ ids: z.array(z.string().uuid()).max(500).optional() });

/** Marca como lidas: as informadas, ou todas sem `ids`. */
notificacoesRouter.post("/notificacoes/lidas", asyncHandler(async (req, res) => {
  const parsed = idsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ erro: "Lista de notificações inválida" });
    return;
  }
  const usuarioId = req.usuario!.usuarioId;
  const r = await prisma.notificacao.updateMany({
    where: { usuarioId, lidaEm: null, ...(parsed.data.ids ? { id: { in: parsed.data.ids } } : {}) },
    data: { lidaEm: new Date() },
  });
  avisar(usuarioId);
  res.json({ atualizadas: r.count });
}));

notificacoesRouter.post("/notificacoes/nao-lidas", asyncHandler(async (req, res) => {
  const parsed = idsSchema.safeParse(req.body ?? {});
  if (!parsed.success || !parsed.data.ids?.length) {
    res.status(400).json({ erro: "Informe as notificações" });
    return;
  }
  const usuarioId = req.usuario!.usuarioId;
  const r = await prisma.notificacao.updateMany({ where: { usuarioId, id: { in: parsed.data.ids } }, data: { lidaEm: null } });
  avisar(usuarioId);
  res.json({ atualizadas: r.count });
}));

/** Arquiva (também marca como lida) ou desarquiva. */
notificacoesRouter.post("/notificacoes/arquivar", asyncHandler(async (req, res) => {
  const parsed = idsSchema.extend({ desfazer: z.boolean().optional(), todasLidas: z.boolean().optional() }).safeParse(req.body ?? {});
  if (!parsed.success || (!parsed.data.ids?.length && !parsed.data.todasLidas)) {
    res.status(400).json({ erro: "Informe as notificações" });
    return;
  }
  const usuarioId = req.usuario!.usuarioId;
  const agora = new Date();
  const where: Prisma.NotificacaoWhereInput = parsed.data.todasLidas
    ? { usuarioId, arquivadaEm: null, lidaEm: { not: null } }
    : { usuarioId, id: { in: parsed.data.ids } };
  const r = await prisma.notificacao.updateMany({
    where,
    data: parsed.data.desfazer ? { arquivadaEm: null } : { arquivadaEm: agora },
  });
  if (!parsed.data.desfazer) {
    await prisma.notificacao.updateMany({ where: { ...where, lidaEm: null }, data: { lidaEm: agora } });
  }
  avisar(usuarioId);
  res.json({ atualizadas: r.count });
}));

// ------------------------------------------------------------ preferências

notificacoesRouter.get("/notificacoes/preferencias", asyncHandler(async (req, res) => {
  const usuario = req.usuario!;
  const gestao = usuario.perfil === "ADMIN" || usuario.perfil === "GESTOR";
  const salvas = await prisma.preferenciaNotificacao.findMany({ where: { usuarioId: usuario.usuarioId } });
  const porTipo = new Map(salvas.map((p) => [p.tipo, p]));
  const tipos = Object.entries(TIPOS_NOTIFICACAO)
    .filter(([, t]) => gestao || !("gestao" in t && t.gestao))
    .map(([tipo, t]) => ({
      tipo,
      rotulo: t.rotulo,
      descricao: t.descricao,
      categoria: t.categoria,
      app: porTipo.get(tipo)?.app ?? t.padrao.app,
      email: porTipo.get(tipo)?.email ?? t.padrao.email,
    }));
  res.json({ emailDisponivel: emailConfigurado(), tipos });
}));

const preferenciasSchema = z.object({
  preferencias: z.array(z.object({ tipo: z.string(), app: z.boolean(), email: z.boolean() })).max(100),
});

notificacoesRouter.put("/notificacoes/preferencias", asyncHandler(async (req, res) => {
  const parsed = preferenciasSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "Preferências inválidas" });
    return;
  }
  const usuarioId = req.usuario!.usuarioId;
  const validas = parsed.data.preferencias.filter((p) => ehTipo(p.tipo));
  await prisma.$transaction(
    validas.map((p) =>
      prisma.preferenciaNotificacao.upsert({
        where: { usuarioId_tipo: { usuarioId, tipo: p.tipo } },
        create: { usuarioId, tipo: p.tipo, app: p.app, email: p.email },
        update: { app: p.app, email: p.email },
      }),
    ),
  );
  res.json({ salvas: validas.length });
}));
