// Ciclo de vida de um atendimento (triagem → aguardando → em atendimento →
// finalizado). Usado pela fila manual e pela caixa de entrada do WhatsApp,
// para os tempos de espera/atendimento saírem iguais nos dois caminhos.
import type { Atendimento, StatusAtendimento } from "@prisma/client";
import { prisma } from "../prisma.js";

export class TransicaoInvalida extends Error {}

// Responsável do cliente no setor; na falta, o responsável padrão do setor
// (mesma regra das obrigações).
export async function responsavelSugerido(clienteId: string | null, setorId: string | null): Promise<string | null> {
  if (!setorId) {
    return null;
  }
  if (clienteId) {
    const vinculo = await prisma.clienteResponsavel.findUnique({
      where: { clienteId_setorId: { clienteId, setorId } },
    });
    if (vinculo) {
      return vinculo.usuarioId;
    }
  }
  const setor = await prisma.setor.findUnique({ where: { id: setorId }, select: { responsavelId: true } });
  return setor?.responsavelId ?? null;
}

const ABERTOS: StatusAtendimento[] = ["TRIAGEM", "AGUARDANDO", "EM_ATENDIMENTO"];

export function estaAberto(atendimento: Pick<Atendimento, "status">): boolean {
  return ABERTOS.includes(atendimento.status);
}

// Dados para "iniciar": só quem está na fila pode ser iniciado. Quem foi
// reaberto mantém o início original (a espera já foi medida).
export function dadosIniciar(atendimento: Atendimento, usuarioId?: string | null) {
  if (atendimento.status !== "TRIAGEM" && atendimento.status !== "AGUARDANDO") {
    throw new TransicaoInvalida("Só dá para iniciar um atendimento que está na fila");
  }
  return {
    status: "EM_ATENDIMENTO" as const,
    iniciadoEm: atendimento.iniciadoEm ?? new Date(),
    ...(usuarioId && !atendimento.responsavelId ? { responsavelId: usuarioId } : {}),
  };
}

// Finalizar sem ter iniciado deixa `iniciadoEm` vazio: não entra nas médias
// de espera nem de duração (antes virava um atendimento de 0 minuto).
export function dadosFinalizar(atendimento: Atendimento, motivoId?: string | null) {
  if (!estaAberto(atendimento)) {
    throw new TransicaoInvalida("Este atendimento já foi finalizado");
  }
  return {
    status: "FINALIZADO" as const,
    finalizadoEm: new Date(),
    ...(motivoId ? { motivoId } : {}),
  };
}

// Reabrir preserva o histórico: o início continua registrado e a sessão
// volta para a fila de quem já atendia.
export function dadosReabrir(atendimento: Atendimento) {
  if (atendimento.status !== "FINALIZADO") {
    throw new TransicaoInvalida("Só dá para reabrir um atendimento finalizado");
  }
  return { status: "AGUARDANDO" as const, finalizadoEm: null };
}
