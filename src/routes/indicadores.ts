// "Painel de Indicadores" do Acessórias (tela inicial): Entregas, A realizar
// e Docs, na semana ou no mês atual.
import type { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prisma } from "../prisma.js";

export const indicadoresRouter = Router();

indicadoresRouter.use(autenticar);

const OFFSET_FORTALEZA_MS = 3 * 3600 * 1000;

// Início/fim da semana (segunda a domingo) ou do mês corrente em Fortaleza.
function periodoAtual(periodo: "semana" | "mes", agora = new Date()): { inicio: Date; fim: Date } {
  const local = new Date(agora.getTime() - OFFSET_FORTALEZA_MS);
  const ano = local.getUTCFullYear();
  const mes = local.getUTCMonth();
  const dia = local.getUTCDate();
  let inicioLocal: number;
  let fimLocal: number;
  if (periodo === "mes") {
    inicioLocal = Date.UTC(ano, mes, 1);
    fimLocal = Date.UTC(ano, mes + 1, 1);
  } else {
    const diasDesdeSegunda = (local.getUTCDay() + 6) % 7;
    inicioLocal = Date.UTC(ano, mes, dia - diasDesdeSegunda);
    fimLocal = inicioLocal + 7 * 24 * 3600 * 1000;
  }
  return { inicio: new Date(inicioLocal + OFFSET_FORTALEZA_MS), fim: new Date(fimLocal + OFFSET_FORTALEZA_MS - 1) };
}

const filtroSchema = z.object({
  periodo: z.enum(["semana", "mes"]).default("semana"),
  setorId: z.string().uuid().optional(),
  responsavelId: z.string().uuid().optional(),
});

indicadoresRouter.get("/indicadores", asyncHandler(async (req, res) => {
  const parsed = filtroSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const { periodo, setorId, responsavelId } = parsed.data;
  const { inicio, fim } = periodoAtual(periodo);
  const agora = new Date();
  const escopo: Prisma.ObrigacaoWhereInput = { setorId, responsavelId, dispensada: false };

  const [entregues, aRealizar, protocolos] = await Promise.all([
    // Entregas feitas no período.
    prisma.obrigacao.findMany({
      where: { ...escopo, concluidaEm: { gte: inicio, lte: fim } },
      select: { concluidaEm: true, prazo: true, prazoTecnico: true, atraso: { select: { id: true } }, tipo: { select: { geraMulta: true } } },
    }),
    // Pendências que vencem até o fim do período (inclui as já atrasadas).
    prisma.obrigacao.findMany({
      where: { ...escopo, concluidaEm: null, prazo: { lte: fim } },
      select: { prazo: true, prazoTecnico: true, atraso: { select: { id: true } }, tipo: { select: { geraMulta: true } } },
    }),
    // Documentos enviados no período.
    prisma.protocoloEntrega.findMany({
      where: { createdAt: { gte: inicio, lte: fim }, obrigacao: escopo },
      select: { status: true, lidoEm: true },
    }),
  ]);

  // Categorias exclusivas, na ordem das linhas do painel do Acessórias.
  const entregas = { total: entregues.length, antecipadas: 0, prazoTecnico: 0, atrasadas: 0, atrasadasComMulta: 0, atrasoJustificado: 0 };
  for (const o of entregues) {
    const concluida = o.concluidaEm!;
    if (concluida > o.prazo) {
      if (o.atraso) entregas.atrasoJustificado += 1;
      else entregas.atrasadas += 1;
      if (o.tipo?.geraMulta) entregas.atrasadasComMulta += 1;
    } else if (o.prazoTecnico && concluida <= o.prazoTecnico) {
      entregas.antecipadas += 1;
    } else {
      entregas.prazoTecnico += 1;
    }
  }

  const realizar = { total: aRealizar.length, prazoAntecipado: 0, prazoTecnico: 0, atrasoLegal: 0, atrasoLegalComMulta: 0, atrasoJustificado: 0 };
  for (const o of aRealizar) {
    if (o.prazo < agora) {
      if (o.atraso) realizar.atrasoJustificado += 1;
      else realizar.atrasoLegal += 1;
      if (o.tipo?.geraMulta) realizar.atrasoLegalComMulta += 1;
    } else if (o.prazoTecnico && o.prazoTecnico < agora) {
      realizar.prazoTecnico += 1; // passou do técnico, ainda dentro do legal
    } else {
      realizar.prazoAntecipado += 1;
    }
  }

  const docs = {
    total: protocolos.length,
    lidos: protocolos.filter((p) => p.lidoEm).length,
    naoLidos: protocolos.filter((p) => !p.lidoEm).length,
    aguardandoEnvio: protocolos.filter((p) => p.status === "AGUARDANDO_ENVIO").length,
    falhaNoEnvio: protocolos.filter((p) => p.status === "FALHA").length,
  };

  res.json({ periodo, inicio, fim, entregas, aRealizar: realizar, docs });
}));
