// Consulta da trilha de auditoria (Configurações → Auditoria e ficha do cliente).
import type { Prisma } from "@prisma/client";
import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { somenteGestao } from "../middleware/perfil.js";
import { prismaBase as prisma } from "../prisma.js";

export const auditoriaRouter = Router();

auditoriaRouter.use("/auditoria", autenticar, somenteGestao);

const texto = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

auditoriaRouter.get("/auditoria", asyncHandler(async (req, res) => {
  const q = req.query;
  const pagina = Math.max(1, Number(q.pagina) || 1);
  const porPagina = Math.min(200, Math.max(10, Number(q.porPagina) || 50));
  const de = texto(q.de);
  const ate = texto(q.ate);
  const busca = texto(q.busca);
  const where: Prisma.AuditoriaWhereInput = {
    usuarioId: texto(q.usuarioId),
    modulo: texto(q.modulo),
    acao: texto(q.acao),
    clienteId: texto(q.clienteId),
    entidadeId: texto(q.entidadeId),
    criadoEm: de || ate
      ? { gte: de ? new Date(`${de}T00:00:00-03:00`) : undefined, lte: ate ? new Date(`${ate}T23:59:59.999-03:00`) : undefined }
      : undefined,
    ...(busca
      ? { OR: [{ descricao: { contains: busca, mode: "insensitive" } }, { usuarioNome: { contains: busca, mode: "insensitive" } }] }
      : {}),
  };
  const [total, itens] = await Promise.all([
    prisma.auditoria.count({ where }),
    prisma.auditoria.findMany({ where, orderBy: { criadoEm: "desc" }, skip: (pagina - 1) * porPagina, take: porPagina }),
  ]);
  res.json({ total, pagina, porPagina, itens });
}));

/** Listas para os filtros: módulos e usuários que já aparecem na trilha. */
auditoriaRouter.get("/auditoria/opcoes", asyncHandler(async (_req, res) => {
  const [modulos, usuarios] = await Promise.all([
    prisma.auditoria.findMany({ distinct: ["modulo"], select: { modulo: true }, orderBy: { modulo: "asc" } }),
    prisma.auditoria.findMany({
      where: { usuarioId: { not: null } },
      distinct: ["usuarioId"],
      select: { usuarioId: true, usuarioNome: true },
      orderBy: { usuarioNome: "asc" },
    }),
  ]);
  res.json({ modulos: modulos.map((m) => m.modulo), usuarios });
}));
