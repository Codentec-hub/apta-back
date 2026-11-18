// Fila de disparo (anti-banimento no WhatsApp não oficial): um envio por vez,
// intervalo aleatório entre envios, teto diário e só no horário comercial.
// Lembretes (um só, para quem não respondeu) passam pela mesma fila. A cada
// minuto também expira pré-reservas vencidas e marca quem não respondeu.
import type { ConfiguracaoLeads } from "@prisma/client";
import { motorAgenteConfigurado } from "../atendimento/agente.js";
import { registrarSistema } from "../atendimento/conversas.js";
import { emitirEvento } from "../eventos.js";
import { prisma } from "../prisma.js";
import { expirarPreReservas } from "./agenda.js";
import { configLeads } from "./config.js";
import { enviarLembrete, enviarPrimeiraMensagem } from "./leads.js";
import { HORA_MS, MIN_MS, diaLocal, diaSemanaLocal, instanteLocal, minutosLocais, paraMinutos } from "./tempo.js";

export function dentroDoHorario(config: ConfiguracaoLeads, agora = new Date()): boolean {
  if (!config.diasSemana.includes(diaSemanaLocal(agora))) return false;
  const m = minutosLocais(agora);
  return m >= paraMinutos(config.horaInicio) && m < paraMinutos(config.horaFim);
}

export async function enviadosHoje(agora = new Date()): Promise<number> {
  const inicio = instanteLocal(diaLocal(agora), "00:00");
  const [primeiras, lembretes] = await Promise.all([
    prisma.lead.count({ where: { primeiraMensagemEm: { gte: inicio } } }),
    prisma.lead.count({ where: { lembreteEnviadoEm: { gte: inicio } } }),
  ]);
  return primeiras + lembretes;
}

/** Quem está esperando o lembrete (não respondeu à primeira mensagem). */
const precisaLembrete = (config: ConfiguracaoLeads, agora: Date) => ({
  status: "EM_CONVERSA" as const,
  ultimaRespostaEm: null,
  lembreteEnviadoEm: null,
  primeiraMensagemEm: { lte: new Date(agora.getTime() - config.lembreteHoras * HORA_MS) },
  // Se a equipe assumiu a conversa, o lembrete automático não entra no meio.
  conversa: { is: { modo: "AGENTE" as const } },
});

export async function situacaoDaFila(agora = new Date()) {
  const config = await configLeads();
  const [naFila, lembretes, hoje, iaPronta] = await Promise.all([
    prisma.lead.count({ where: { status: "NA_FILA" } }),
    prisma.lead.count({ where: precisaLembrete(config, agora) }),
    enviadosHoje(agora),
    motorAgenteConfigurado(),
  ]);
  let pausa: string | null = null;
  if (!config.disparoAtivo) pausa = "Disparo pausado nas configurações";
  else if (!iaPronta) pausa = "A IA (Gemini) não está configurada";
  else if (hoje >= config.tetoDiario) pausa = `Teto diário atingido (${config.tetoDiario})`;
  else if (!dentroDoHorario(config, agora)) pausa = `Fora do horário de envio (${config.horaInicio}–${config.horaFim})`;
  return {
    naFila,
    lembretesPendentes: lembretes,
    enviadosHoje: hoje,
    tetoDiario: config.tetoDiario,
    proximoEnvioEm: pausa ? null : config.proximoDisparoEm && config.proximoDisparoEm > agora ? config.proximoDisparoEm : agora,
    pausa,
  };
}

async function marcarSemResposta(config: ConfiguracaoLeads, agora: Date) {
  const limite = new Date(agora.getTime() - config.lembreteHoras * HORA_MS);
  const calados = await prisma.lead.findMany({
    where: { status: "EM_CONVERSA", ultimaRespostaEm: null, lembreteEnviadoEm: { lte: limite } },
  });
  for (const lead of calados) {
    // Continua com o assistente: se ele responder depois, a conversa segue.
    await prisma.lead.update({ where: { id: lead.id }, data: { status: "SEM_RESPOSTA" } });
    if (lead.conversaId) await registrarSistema(lead.conversaId, "Lead sem resposta depois do lembrete; nenhuma nova mensagem será enviada.");
  }
  if (calados.length) emitirEvento({ tipo: "leads" });
}

const aleatorio = (min: number, max: number) => min + Math.random() * Math.max(0, max - min);

/** Um envio, se tudo permitir. Devolve o que fez (para testes e logs). */
export async function rodarDisparo(agora = new Date()): Promise<"enviado" | "lembrete" | "nada"> {
  const config = await configLeads();
  await expirarPreReservas(agora);
  await marcarSemResposta(config, agora);

  if (!config.disparoAtivo || !dentroDoHorario(config, agora)) return "nada";
  if (config.proximoDisparoEm && config.proximoDisparoEm > agora) return "nada";
  if ((await enviadosHoje(agora)) >= config.tetoDiario) return "nada";
  if (!(await motorAgenteConfigurado())) return "nada";

  const lembrete = await prisma.lead.findFirst({ where: precisaLembrete(config, agora), orderBy: { primeiraMensagemEm: "asc" } });
  const proximo = lembrete ? null : await prisma.lead.findFirst({ where: { status: "NA_FILA" }, orderBy: { naFilaEm: "asc" } });
  if (!lembrete && !proximo) return "nada";

  const intervalo = aleatorio(Math.max(1, config.intervaloMinMin), Math.max(config.intervaloMinMin, config.intervaloMaxMin));
  await prisma.configuracaoLeads.update({ where: { id: 1 }, data: { proximoDisparoEm: new Date(agora.getTime() + intervalo * MIN_MS) } });

  if (lembrete) {
    await enviarLembrete(lembrete);
    return "lembrete";
  }
  await enviarPrimeiraMensagem(proximo!);
  return "enviado";
}

let rodando = false;

export function agendarDisparoLeads(): void {
  const rodar = async () => {
    if (rodando) return;
    rodando = true;
    try {
      await rodarDisparo();
    } catch (error) {
      console.error("[leads] disparo falhou", error);
    } finally {
      rodando = false;
    }
  };
  setTimeout(() => void rodar(), 30_000).unref();
  setInterval(() => void rodar(), 60_000).unref();
}
