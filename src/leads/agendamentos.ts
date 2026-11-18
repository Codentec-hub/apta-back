// Ações da equipe sobre os agendamentos: confirmar (avisa o lead com a
// mensagem de confirmação), cancelar (libera o horário) e agendar direto.
import type { Agendamento } from "@prisma/client";
import { enviarMensagem, registrarSistema } from "../atendimento/conversas.js";
import { emitirEvento } from "../eventos.js";
import { prisma } from "../prisma.js";
import { primeiroNome } from "./campos.js";
import { CONFIRMACAO_PADRAO, configLeads, preencher } from "./config.js";
import { statusSemHorario } from "./agenda.js";
import { ENCERRADOS, RegraLead } from "./leads.js";
import { dataPorExtenso } from "./tempo.js";

export async function confirmarAgendamento(
  id: string,
  usuario: { id: string; nome: string },
  opcoes: { avisarLead: boolean; observacoes?: string | null }
): Promise<{ agendamento: Agendamento; mensagemEnviada: boolean; erroEnvio: string | null }> {
  const atual = await prisma.agendamento.findUnique({ where: { id }, include: { lead: true } });
  if (!atual) throw new RegraLead("Agendamento não encontrado");
  if (atual.status !== "PRE_RESERVADO") throw new RegraLead("Só dá para confirmar uma pré-reserva");
  if (ENCERRADOS.includes(atual.lead.status)) throw new RegraLead("Este lead está encerrado; reabra antes de confirmar");
  const agora = new Date();
  if (atual.inicio <= agora) throw new RegraLead("Esse horário já passou; cancele e marque outro");

  // Duas pessoas confirmando ao mesmo tempo: só a primeira passa (e só ela
  // manda a mensagem ao lead).
  const { count } = await prisma.agendamento.updateMany({
    where: { id, status: "PRE_RESERVADO" },
    data: { status: "CONFIRMADO", confirmadoEm: agora, confirmadoPorId: usuario.id, expiraEm: null, observacoes: opcoes.observacoes ?? atual.observacoes },
  });
  if (!count) throw new RegraLead("Essa pré-reserva acabou de ser confirmada ou cancelada por outra pessoa");
  const agendamento = (await prisma.agendamento.findUnique({ where: { id } }))!;
  await prisma.lead.update({ where: { id: atual.leadId }, data: { status: "AGENDADO" } });

  let mensagemEnviada = false;
  let erroEnvio: string | null = null;
  const conversaId = atual.lead.conversaId;
  if (conversaId) {
    await registrarSistema(conversaId, `Agendamento de ${dataPorExtenso(atual.inicio)} confirmado por ${usuario.nome}.`);
    if (opcoes.avisarLead) {
      const config = await configLeads();
      const texto = preencher(config.mensagemConfirmacao?.trim() || CONFIRMACAO_PADRAO, {
        nome: atual.lead.nome,
        primeiroNome: primeiroNome(atual.lead.nome),
        indicador: config.nomeIndicador,
        data: dataPorExtenso(atual.inicio),
        formato: config.formatoAtendimento,
      });
      const msg = await enviarMensagem({ conversaId, texto, autor: "ATENDENTE", usuarioId: usuario.id });
      mensagemEnviada = msg.status !== "FALHA";
      erroEnvio = msg.status === "FALHA" ? (msg.erro ?? "Falha no envio") : null;
    }
  }
  emitirEvento({ tipo: "leads" });
  return { agendamento, mensagemEnviada, erroEnvio };
}

export async function cancelarAgendamento(
  id: string,
  usuario: { id: string; nome: string },
  opcoes: { motivo: string; mensagemLead?: string | null }
): Promise<Agendamento> {
  const atual = await prisma.agendamento.findUnique({ where: { id }, include: { lead: true } });
  if (!atual) throw new RegraLead("Agendamento não encontrado");
  if (atual.status !== "PRE_RESERVADO" && atual.status !== "CONFIRMADO") throw new RegraLead("Este agendamento já não está ativo");
  const { count } = await prisma.agendamento.updateMany({
    where: { id, status: { in: ["PRE_RESERVADO", "CONFIRMADO"] } },
    data: { status: "CANCELADO", canceladoEm: new Date(), motivoCancelamento: opcoes.motivo },
  });
  if (!count) throw new RegraLead("Esse agendamento acabou de ser cancelado ou expirou");
  const agendamento = (await prisma.agendamento.findUnique({ where: { id } }))!;
  await statusSemHorario(atual.leadId);
  const conversaId = atual.lead.conversaId;
  if (conversaId) {
    await registrarSistema(conversaId, `Agendamento de ${dataPorExtenso(atual.inicio)} cancelado por ${usuario.nome}: ${opcoes.motivo}`);
    if (opcoes.mensagemLead?.trim()) {
      await enviarMensagem({ conversaId, texto: opcoes.mensagemLead.trim(), autor: "ATENDENTE", usuarioId: usuario.id });
    }
  }
  emitirEvento({ tipo: "leads" });
  return agendamento;
}
