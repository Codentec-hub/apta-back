// Agenda de atendimento dos leads: grade semanal, bloqueios, horários livres,
// visão da semana e a fila de confirmações da equipe.
import type { Prisma, StatusAgendamento } from "@prisma/client";
import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { somenteGestao } from "../middleware/perfil.js";
import { prisma } from "../prisma.js";
import { emitirEvento } from "../eventos.js";
import { ConflitoAgenda, descreverHorario, horariosLivres, preReservar, statusSemHorario } from "../leads/agenda.js";
import { cancelarAgendamento, confirmarAgendamento } from "../leads/agendamentos.js";
import { RegraLead } from "../leads/leads.js";
import { DIA_MS, diaLocal, instanteLocal, paraMinutos } from "../leads/tempo.js";

export const agendaRouter = Router();
agendaRouter.use("/agenda", autenticar);
agendaRouter.use("/agendamentos", autenticar);

const STATUS: StatusAgendamento[] = ["PRE_RESERVADO", "CONFIRMADO", "CANCELADO", "EXPIRADO"];
const DIA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

const usuario = async (req: Request) => {
  const u = await prisma.usuario.findUnique({ where: { id: req.usuario!.usuarioId }, select: { id: true, nome: true } });
  return u ?? { id: req.usuario!.usuarioId, nome: "Equipe" };
};

function responderErro(res: Response, error: unknown): boolean {
  if (error instanceof RegraLead || error instanceof ConflitoAgenda) {
    res.status(409).json({ erro: error.message });
    return true;
  }
  return false;
}

const agendamentoInclude = {
  lead: { select: { id: true, nome: true, telefone: true, origem: true, qualificacao: true, perfil: true, observacoes: true, conversaId: true, status: true } },
  confirmadoPor: { select: { id: true, nome: true } },
} satisfies Prisma.AgendamentoInclude;

// ── Grade semanal ─────────────────────────────────────────────────────────

agendaRouter.get(
  "/agenda/disponibilidades",
  asyncHandler(async (_req, res) => {
    res.json(
      await prisma.disponibilidadeAgenda.findMany({
        orderBy: [{ diaSemana: "asc" }, { inicio: "asc" }],
        include: { responsavel: { select: { id: true, nome: true } } },
      })
    );
  })
);

const faixaSchema = z
  .object({
    diaSemana: z.number().int().min(0).max(6),
    inicio: z.string().regex(HORA, "Hora inválida"),
    fim: z.string().regex(HORA, "Hora inválida"),
    duracaoMin: z.number().int().min(10).max(240),
    ativo: z.boolean().optional(),
    responsavelId: z.string().uuid().optional().nullable(),
  })
  .refine((f) => paraMinutos(f.fim) - paraMinutos(f.inicio) >= f.duracaoMin, { message: "O fim precisa caber pelo menos uma reunião depois do início" });

// Substitui a grade inteira (a tela edita tudo de uma vez).
agendaRouter.put(
  "/agenda/disponibilidades",
  somenteGestao,
  asyncHandler(async (req, res) => {
    const parsed = z.array(faixaSchema).max(70).safeParse(req.body?.faixas);
    if (!parsed.success) {
      res.status(400).json({ erro: parsed.error.issues[0]?.message ?? "Grade inválida" });
      return;
    }
    const faixas = parsed.data;
    for (const dia of new Set(faixas.map((f) => f.diaSemana))) {
      const doDia = faixas.filter((f) => f.diaSemana === dia).sort((a, b) => paraMinutos(a.inicio) - paraMinutos(b.inicio));
      for (let i = 1; i < doDia.length; i++) {
        if (paraMinutos(doDia[i].inicio) < paraMinutos(doDia[i - 1].fim)) {
          res.status(400).json({ erro: "Há faixas sobrepostas no mesmo dia" });
          return;
        }
      }
    }
    await prisma.$transaction([
      prisma.disponibilidadeAgenda.deleteMany({}),
      prisma.disponibilidadeAgenda.createMany({ data: faixas.map((f) => ({ ...f, ativo: f.ativo ?? true })) }),
    ]);
    emitirEvento({ tipo: "leads" });
    res.status(204).send();
  })
);

// ── Bloqueios ─────────────────────────────────────────────────────────────

agendaRouter.get(
  "/agenda/bloqueios",
  asyncHandler(async (req, res) => {
    const de = typeof req.query.de === "string" && DIA.test(req.query.de) ? instanteLocal(req.query.de, "00:00") : new Date();
    res.json(await prisma.bloqueioAgenda.findMany({ where: { fim: { gt: de } }, orderBy: { inicio: "asc" }, take: 200 }));
  })
);

const bloqueioSchema = z
  .object({ inicio: z.coerce.date(), fim: z.coerce.date(), motivo: z.string().trim().max(200).optional().nullable() })
  .refine((b) => b.fim > b.inicio, { message: "O fim precisa ser depois do início" });

agendaRouter.post(
  "/agenda/bloqueios",
  asyncHandler(async (req, res) => {
    const parsed = bloqueioSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ erro: parsed.error.issues[0]?.message ?? "Bloqueio inválido" });
      return;
    }
    const conflitos = await prisma.agendamento.count({
      where: { status: { in: ["PRE_RESERVADO", "CONFIRMADO"] }, inicio: { lt: parsed.data.fim }, fim: { gt: parsed.data.inicio } },
    });
    const bloqueio = await prisma.bloqueioAgenda.create({ data: parsed.data });
    emitirEvento({ tipo: "leads" });
    res.status(201).json({ ...bloqueio, conflitos });
  })
);

agendaRouter.delete(
  "/agenda/bloqueios/:id",
  asyncHandler(async (req, res) => {
    await prisma.bloqueioAgenda.deleteMany({ where: { id: req.params.id } });
    emitirEvento({ tipo: "leads" });
    res.status(204).send();
  })
);

// ── Horários e semana ─────────────────────────────────────────────────────

agendaRouter.get(
  "/agenda/horarios-livres",
  asyncHandler(async (req, res) => {
    const de = typeof req.query.de === "string" && DIA.test(req.query.de) ? instanteLocal(req.query.de, "00:00") : undefined;
    const ate = typeof req.query.ate === "string" && DIA.test(req.query.ate) ? instanteLocal(req.query.ate, "23:59") : undefined;
    const leadId = typeof req.query.leadId === "string" ? req.query.leadId : null;
    // A tela da equipe (agendar à mão) não aplica a antecedência mínima do assistente.
    const livres = await horariosLivres({ aPartirDe: de, ate, leadId, semAntecedencia: req.query.equipe === "1" });
    res.json(livres.slice(0, 300).map((h) => ({ ...descreverHorario(h), fim: h.fim.toISOString() })));
  })
);

agendaRouter.get(
  "/agenda/semana",
  asyncHandler(async (req, res) => {
    const de = typeof req.query.de === "string" && DIA.test(req.query.de) ? req.query.de : diaLocal(new Date());
    const dias = Math.min(31, Math.max(1, Number(req.query.dias) || 7));
    const inicio = instanteLocal(de, "00:00");
    const fim = new Date(inicio.getTime() + dias * DIA_MS);
    const [agendamentos, bloqueios, grade] = await Promise.all([
      prisma.agendamento.findMany({
        where: { inicio: { gte: inicio, lt: fim }, status: { in: ["PRE_RESERVADO", "CONFIRMADO"] } },
        orderBy: { inicio: "asc" },
        include: agendamentoInclude,
      }),
      prisma.bloqueioAgenda.findMany({ where: { inicio: { lt: fim }, fim: { gt: inicio } }, orderBy: { inicio: "asc" } }),
      prisma.disponibilidadeAgenda.findMany({ where: { ativo: true } }),
    ]);
    res.json({ de, dias, agendamentos, bloqueios, grade });
  })
);

// ── Agendamentos ──────────────────────────────────────────────────────────

agendaRouter.get(
  "/agendamentos",
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status.split(",").filter((s): s is StatusAgendamento => STATUS.includes(s as StatusAgendamento)) : [];
    const futuros = req.query.futuros === "1";
    res.json(
      await prisma.agendamento.findMany({
        where: { ...(status.length ? { status: { in: status } } : {}), ...(futuros ? { fim: { gt: new Date() } } : {}) },
        orderBy: status.length === 1 && status[0] === "PRE_RESERVADO" ? { expiraEm: "asc" } : { inicio: "asc" },
        include: agendamentoInclude,
        take: 300,
      })
    );
  })
);

agendaRouter.get(
  "/agendamentos/contagem",
  asyncHandler(async (_req, res) => {
    const agora = new Date();
    const [pendentes, hoje] = await Promise.all([
      prisma.agendamento.count({ where: { status: "PRE_RESERVADO", OR: [{ expiraEm: null }, { expiraEm: { gt: agora } }] } }),
      prisma.agendamento.count({
        where: { status: "CONFIRMADO", inicio: { gte: instanteLocal(diaLocal(agora), "00:00"), lt: instanteLocal(diaLocal(new Date(agora.getTime() + DIA_MS)), "00:00") } },
      }),
    ]);
    res.json({ pendentes, hoje });
  })
);

// A equipe marca direto (ex.: combinou com o lead por telefone).
agendaRouter.post(
  "/agendamentos",
  asyncHandler(async (req, res) => {
    const parsed = z.object({ leadId: z.string().uuid(), inicio: z.coerce.date(), confirmar: z.boolean().optional(), avisarLead: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ erro: "Escolha o lead e o horário" });
      return;
    }
    try {
      const pre = await preReservar(parsed.data.leadId, parsed.data.inicio, { porEquipe: true });
      let final = pre;
      if (parsed.data.confirmar) {
        try {
          final = (await confirmarAgendamento(pre.id, await usuario(req), { avisarLead: parsed.data.avisarLead ?? false })).agendamento;
        } catch (error) {
          // Não deixa uma pré-reserva "fantasma" quando a confirmação falha.
          await prisma.agendamento.updateMany({
            where: { id: pre.id, status: "PRE_RESERVADO" },
            data: { status: "CANCELADO", canceladoEm: new Date(), motivoCancelamento: "Falha ao confirmar" },
          });
          await statusSemHorario(pre.leadId);
          throw error;
        }
      }
      res.status(201).json(final);
    } catch (error) {
      if (!responderErro(res, error)) throw error;
    }
  })
);

agendaRouter.post(
  "/agendamentos/:id/confirmar",
  asyncHandler(async (req, res) => {
    const parsed = z.object({ avisarLead: z.boolean().optional(), observacoes: z.string().trim().max(1000).optional().nullable() }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ erro: "Dados inválidos" });
      return;
    }
    try {
      res.json(await confirmarAgendamento(req.params.id, await usuario(req), { avisarLead: parsed.data.avisarLead ?? true, observacoes: parsed.data.observacoes }));
    } catch (error) {
      if (!responderErro(res, error)) throw error;
    }
  })
);

agendaRouter.post(
  "/agendamentos/:id/cancelar",
  asyncHandler(async (req, res) => {
    const parsed = z.object({ motivo: z.string().trim().min(2, "Informe o motivo").max(500), mensagemLead: z.string().trim().max(2000).optional().nullable() }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ erro: parsed.error.issues[0]?.message ?? "Dados inválidos" });
      return;
    }
    try {
      res.json(await cancelarAgendamento(req.params.id, await usuario(req), parsed.data));
    } catch (error) {
      if (!responderErro(res, error)) throw error;
    }
  })
);
