// Agenda de atendimento dos leads: horários livres (grade semanal − feriados
// − bloqueios − agendamentos ativos), pré-reserva pelo assistente,
// confirmação/cancelamento pela equipe e expiração das pré-reservas.
import { Prisma } from "@prisma/client";
import type { Agendamento } from "@prisma/client";
import { escritorio } from "../escritorio.js";
import { emitirEvento } from "../eventos.js";
import { garantirFeriados } from "../obrigacoes/feriados.js";
import { ehDiaUtil } from "../obrigacoes/prazos.js";
import { prisma } from "../prisma.js";
import { registrarSistema } from "../atendimento/conversas.js";
import { configLeads } from "./config.js";
import { ENCERRADOS, RegraLead, avisarEquipe, statusConversando } from "./leads.js";
import { DIA_MS, HORA_MS, MIN_MS, dataPorExtenso, diaLocal, instanteLocal, minutosLocais, paraMinutos, rotuloHorario, somarDiasLocal } from "./tempo.js";

export const ATIVOS = ["PRE_RESERVADO", "CONFIRMADO"] as const;

export class ConflitoAgenda extends Error {}

export interface Horario {
  inicio: Date;
  fim: Date;
}

// Feriado nacional ou cadastrado (no domingo o motor de prazos não distingue;
// grade de domingo é rara e fica liberada).
function feriadoEm(dia: string, dow: number): boolean {
  if (dow === 0) return false;
  const [ano, mes, d] = dia.split("-").map(Number) as [number, number, number];
  return !ehDiaUtil({ ano, mes, dia: d }, true, escritorio());
}

/** Pré-reservas cujo prazo passou contam como livres mesmo antes da rotina rodar. */
const ocupando = (agora: Date): Prisma.AgendamentoWhereInput => ({
  OR: [{ status: "CONFIRMADO" }, { status: "PRE_RESERVADO", OR: [{ expiraEm: null }, { expiraEm: { gt: agora } }] }],
});

const sobrepoe = (a: Horario, b: Horario) => a.inicio < b.fim && a.fim > b.inicio;

interface OpcoesLivres {
  aPartirDe?: Date;
  ate?: Date;
  periodo?: "manha" | "tarde" | "noite" | null;
  /** Ignora o agendamento deste lead (para remarcar). */
  leadId?: string | null;
  agora?: Date;
  /** A equipe marcando à mão (combinou por telefone): vale até daqui a pouco. */
  semAntecedencia?: boolean;
}

/** Todos os horários livres da janela, em ordem. */
export async function horariosLivres(opcoes: OpcoesLivres = {}): Promise<Horario[]> {
  await garantirFeriados();
  const config = await configLeads();
  const agora = opcoes.agora ?? new Date();
  const antecedencia = opcoes.semAntecedencia ? 0 : config.antecedenciaMinHoras * HORA_MS;
  const minimo = new Date(Math.max(agora.getTime() + antecedencia, opcoes.aPartirDe?.getTime() ?? 0));
  const limite = opcoes.ate ?? new Date(agora.getTime() + config.diasAgendaAberta * DIA_MS);
  if (minimo >= limite) return [];

  const grade = await prisma.disponibilidadeAgenda.findMany({ where: { ativo: true } });
  if (!grade.length) return [];
  const [bloqueios, ocupados] = await Promise.all([
    prisma.bloqueioAgenda.findMany({ where: { fim: { gt: minimo }, inicio: { lt: limite } } }),
    prisma.agendamento.findMany({
      where: { AND: [ocupando(agora), { fim: { gt: minimo }, inicio: { lt: limite } }], ...(opcoes.leadId ? { leadId: { not: opcoes.leadId } } : {}) },
      select: { inicio: true, fim: true },
    }),
  ]);

  const livres: Horario[] = [];
  const vistos = new Set<number>();
  for (let dia = diaLocal(minimo); instanteLocal(dia, "00:00") < limite; dia = somarDiasLocal(dia, 1)) {
    const dow = new Date(Date.parse(`${dia}T12:00:00Z`)).getUTCDay();
    const doDia = grade.filter((g) => g.diaSemana === dow);
    if (!doDia.length || feriadoEm(dia, dow)) continue;
    for (const g of doDia) {
      const duracao = Math.max(10, g.duracaoMin);
      for (let m = paraMinutos(g.inicio); m + duracao <= paraMinutos(g.fim); m += duracao) {
        const inicio = new Date(instanteLocal(dia, "00:00").getTime() + m * MIN_MS);
        const h = { inicio, fim: new Date(inicio.getTime() + duracao * MIN_MS) };
        if (inicio < minimo || h.fim > limite || vistos.has(inicio.getTime())) continue;
        if (opcoes.periodo && periodoDe(inicio) !== opcoes.periodo) continue;
        if (bloqueios.some((b) => sobrepoe(h, b)) || ocupados.some((o) => sobrepoe(h, o))) continue;
        vistos.add(inicio.getTime());
        livres.push(h);
      }
    }
  }
  return livres.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
}

export function periodoDe(d: Date): "manha" | "tarde" | "noite" {
  const m = minutosLocais(d);
  return m < 12 * 60 ? "manha" : m < 18 * 60 ? "tarde" : "noite";
}

/**
 * Opções para oferecer ao lead: espalhadas em dias diferentes (no máximo 2
 * por dia) para dar escolha de verdade.
 */
export function espalhar(livres: Horario[], quantidade: number): Horario[] {
  const porDia = new Map<string, number>();
  const escolhidos: Horario[] = [];
  for (const limitePorDia of [1, 2]) {
    for (const h of livres) {
      if (escolhidos.length >= quantidade) break;
      const dia = diaLocal(h.inicio);
      if ((porDia.get(dia) ?? 0) >= limitePorDia || escolhidos.includes(h)) continue;
      porDia.set(dia, (porDia.get(dia) ?? 0) + 1);
      escolhidos.push(h);
    }
  }
  return escolhidos.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
}

export const descreverHorario = (h: Horario) => ({ inicio: h.inicio.toISOString(), rotulo: rotuloHorario(h.inicio) });

/**
 * Pré-reserva para o lead. O horário precisa ser um dos livres; uma
 * pré-reserva anterior do mesmo lead é cancelada (remarcação). Dois pedidos
 * ao mesmo tempo: o índice único parcial deixa só um passar.
 */
export async function preReservar(
  leadId: string,
  inicio: Date,
  opcoes: { agora?: Date; porEquipe?: boolean } = {}
): Promise<Agendamento> {
  const agora = opcoes.agora ?? new Date();
  const config = await configLeads();
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { status: true } });
  if (!lead) throw new RegraLead("Lead não encontrado");
  if (ENCERRADOS.includes(lead.status)) throw new RegraLead("Este lead está encerrado; reabra antes de agendar");
  // Pré-reservas vencidas liberam o horário já (a rotina só passa depois).
  await expirarPreReservas(agora);
  const livres = await horariosLivres({
    aPartirDe: new Date(inicio.getTime() - MIN_MS),
    ate: new Date(inicio.getTime() + DIA_MS),
    leadId,
    agora,
    semAntecedencia: opcoes.porEquipe,
  });
  const horario = livres.find((h) => h.inicio.getTime() === inicio.getTime());
  if (!horario) throw new ConflitoAgenda("Esse horário não está mais disponível.");

  try {
    const agendamento = await prisma.$transaction(
      async (tx) => {
        const conflito = await tx.agendamento.findFirst({
          where: { status: { in: [...ATIVOS] }, leadId: { not: leadId }, inicio: { lt: horario.fim }, fim: { gt: horario.inicio } },
        });
        if (conflito) throw new ConflitoAgenda("Esse horário acabou de ser reservado por outra pessoa.");
        const confirmado = await tx.agendamento.findFirst({ where: { leadId, status: "CONFIRMADO", inicio: { gt: agora } } });
        if (confirmado) throw new ConflitoAgenda("Este lead já tem um horário confirmado; para remarcar, fale com a equipe.");
        await tx.agendamento.updateMany({
          where: { leadId, status: "PRE_RESERVADO" },
          data: { status: "CANCELADO", canceladoEm: agora, motivoCancelamento: opcoes.porEquipe ? "Remarcado pela equipe" : "Remarcado pelo lead" },
        });
        const novo = await tx.agendamento.create({
          data: { leadId, inicio: horario.inicio, fim: horario.fim, expiraEm: new Date(agora.getTime() + config.prazoPreReservaHoras * HORA_MS) },
        });
        await tx.lead.update({ where: { id: leadId }, data: { status: "AGUARDANDO_CONFIRMACAO" } });
        return novo;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    emitirEvento({ tipo: "leads" });
    return agendamento;
  } catch (error) {
    if (error instanceof ConflitoAgenda) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034")) {
      throw new ConflitoAgenda("Esse horário acabou de ser reservado por outra pessoa.");
    }
    throw error;
  }
}

/** Lead sem horário ativo volta a "dados coletados" ou "em conversa". */
export async function statusSemHorario(leadId: string): Promise<void> {
  const ativo = await prisma.agendamento.findFirst({ where: { leadId, status: { in: [...ATIVOS] } } });
  if (ativo) return;
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead || !["AGUARDANDO_CONFIRMACAO", "AGENDADO"].includes(lead.status)) return;
  // Agendado à mão sem nunca ter falado com o assistente: volta para "Novo".
  await prisma.lead.update({ where: { id: leadId }, data: { status: lead.conversaId ? statusConversando(lead) : "NOVO" } });
}

/**
 * Expira pré-reservas vencidas, registra na conversa e avisa a equipe. Roda
 * pela rotina e antes de cada reserva; cada uma é tratada uma vez só (quem
 * muda o status primeiro é quem avisa).
 */
export async function expirarPreReservas(agora = new Date()) {
  const vencidas = await prisma.agendamento.findMany({
    where: { status: "PRE_RESERVADO", expiraEm: { lte: agora } },
    include: { lead: true },
  });
  const tratadas: typeof vencidas = [];
  for (const a of vencidas) {
    const { count } = await prisma.agendamento.updateMany({ where: { id: a.id, status: "PRE_RESERVADO" }, data: { status: "EXPIRADO" } });
    if (!count) continue;
    tratadas.push(a);
    await statusSemHorario(a.leadId);
    if (a.lead.conversaId) {
      await registrarSistema(a.lead.conversaId, `Pré-reserva de ${dataPorExtenso(a.inicio)} expirou sem confirmação; o horário foi liberado.`);
    }
    await avisarEquipe(a.lead, {
      tipo: "lead_pre_reserva_expirada",
      titulo: `Pré-reserva expirada: ${a.lead.nome}`,
      mensagem: `O horário de ${dataPorExtenso(a.inicio)} não foi confirmado no prazo e voltou a ficar livre. Fale com o lead para remarcar.`,
      severidade: "aviso",
      chave: `pre-reserva-expirada:${a.id}`,
    });
  }
  if (tratadas.length) emitirEvento({ tipo: "leads" });
  return tratadas;
}
