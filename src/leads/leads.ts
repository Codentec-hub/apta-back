// Regras do lead: entrar na fila, primeira mensagem, lembrete, resposta do
// lead (inclusive quando ele chama primeiro), pedido para sair e encerramentos.
import type { Lead, StatusLead } from "@prisma/client";
import { atendimentoAberto, conversaDoTelefone, enviarMensagem, registrarSistema } from "../atendimento/conversas.js";
import { emitirEvento } from "../eventos.js";
import { idsDaGestao, notificar } from "../notificacoes/notificar.js";
import type { NovaNotificacao } from "../notificacoes/notificar.js";
import { prisma } from "../prisma.js";
import { chaveTelefone } from "../whatsapp/telefone.js";
import { primeiroNome } from "./campos.js";
import { LEMBRETE_PADRAO, agenteDosLeads, configLeads, mensagensIniciais, preencher, sortear } from "./config.js";

export const STATUS_ROTULO: Record<StatusLead, string> = {
  NOVO: "Novo",
  NA_FILA: "Na fila",
  EM_CONVERSA: "Em conversa",
  FORA_DO_PERFIL: "Fora do perfil",
  DADOS_COLETADOS: "Dados coletados",
  AGUARDANDO_CONFIRMACAO: "Aguardando confirmação",
  AGENDADO: "Agendado",
  SEM_RESPOSTA: "Sem resposta",
  DESCARTADO: "Descartado",
};

/** Status em que o assistente está (ou pode voltar a estar) conversando. */
export const EM_ANDAMENTO: StatusLead[] = ["EM_CONVERSA", "DADOS_COLETADOS", "AGUARDANDO_CONFIRMACAO", "AGENDADO", "SEM_RESPOSTA"];
export const ENCERRADOS: StatusLead[] = ["FORA_DO_PERFIL", "DESCARTADO"];

export class RegraLead extends Error {}

const hrefLead = (id: string) => `/dashboard/leads?lead=${id}`;

/** Quem recebe os avisos de leads: os escolhidos na configuração ou a gestão. */
export async function quemAcompanha(): Promise<string[]> {
  const config = await configLeads();
  return config.notificarIds.length ? config.notificarIds : idsDaGestao();
}

export async function avisarEquipe(lead: Pick<Lead, "id" | "cadastradoPorId">, n: Omit<NovaNotificacao, "href"> & { href?: string }) {
  await notificar([...(await quemAcompanha()), lead.cadastradoPorId], { href: hrefLead(lead.id), ...n });
}

export async function enfileirar(leadId: string): Promise<Lead> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new RegraLead("Lead não encontrado");
  if (lead.status !== "NOVO") throw new RegraLead("Só dá para enviar ao assistente um lead que ainda não foi contatado");
  const atualizado = await prisma.lead.update({ where: { id: leadId }, data: { status: "NA_FILA", naFilaEm: new Date() } });
  emitirEvento({ tipo: "leads" });
  return atualizado;
}

export async function tirarDaFila(leadId: string): Promise<Lead> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new RegraLead("Lead não encontrado");
  if (lead.status !== "NA_FILA") throw new RegraLead("Este lead não está na fila");
  const atualizado = await prisma.lead.update({ where: { id: leadId }, data: { status: "NOVO", naFilaEm: null } });
  emitirEvento({ tipo: "leads" });
  return atualizado;
}

/** Prepara a conversa do lead: vínculo, atendimento aberto e modo agente. */
async function conversaDoLead(lead: Lead) {
  const conversa = await conversaDoTelefone(lead.telefone, lead.nome);
  const agente = await agenteDosLeads();
  if (!(await atendimentoAberto(conversa.id))) {
    await prisma.atendimento.create({ data: { conversaId: conversa.id, clienteId: conversa.clienteId, status: "TRIAGEM" } });
  }
  await prisma.conversa.update({ where: { id: conversa.id }, data: { modo: "AGENTE", agenteId: agente.id } });
  await prisma.lead.update({ where: { id: lead.id }, data: { conversaId: conversa.id } });
  return { conversa, agente };
}

/** Primeira mensagem (chamada pela fila de disparo). */
export async function enviarPrimeiraMensagem(lead: Lead): Promise<boolean> {
  const config = await configLeads();
  const { conversa, agente } = await conversaDoLead(lead);
  await registrarSistema(conversa.id, `Lead enviado ao ${agente.nome}: primeira mensagem automática.`);
  const texto = preencher(sortear(mensagensIniciais(config)), {
    nome: lead.nome,
    primeiroNome: primeiroNome(lead.nome),
    indicador: config.nomeIndicador,
  });
  const mensagem = await enviarMensagem({ conversaId: conversa.id, texto, autor: "AUTOMACAO", agenteId: agente.id });
  if (mensagem.status === "FALHA") {
    await prisma.lead.update({ where: { id: lead.id }, data: { status: "NOVO", naFilaEm: null } });
    await prisma.conversa.update({ where: { id: conversa.id }, data: { modo: "HUMANO" } });
    await avisarEquipe(lead, {
      tipo: "lead_precisa_humano",
      titulo: `Não foi possível chamar ${lead.nome}`,
      mensagem: `A primeira mensagem falhou (${mensagem.erro ?? "erro no WhatsApp"}). O lead voltou para "Novo".`,
      severidade: "erro",
      chave: `lead-falha:${lead.id}:${mensagem.id}`,
    });
    emitirEvento({ tipo: "leads" });
    return false;
  }
  await prisma.lead.update({ where: { id: lead.id }, data: { status: "EM_CONVERSA", primeiraMensagemEm: new Date() } });
  emitirEvento({ tipo: "leads" });
  return true;
}

/** Um lembrete só, se o lead não respondeu à primeira mensagem. */
export async function enviarLembrete(lead: Lead): Promise<void> {
  if (!lead.conversaId) return;
  const config = await configLeads();
  const texto = preencher(config.mensagemLembrete?.trim() || LEMBRETE_PADRAO, {
    nome: lead.nome,
    primeiroNome: primeiroNome(lead.nome),
    indicador: config.nomeIndicador,
  });
  await prisma.lead.update({ where: { id: lead.id }, data: { lembreteEnviadoEm: new Date() } });
  await enviarMensagem({ conversaId: lead.conversaId, texto, autor: "AUTOMACAO", agenteId: config.agenteId });
  emitirEvento({ tipo: "leads" });
}

/** Encerra o lead e devolve a conversa para a equipe. */
export async function encerrarLead(lead: Lead, status: Extract<StatusLead, "FORA_DO_PERFIL" | "DESCARTADO" | "SEM_RESPOSTA">, motivo: string, quem?: string) {
  await prisma.lead.update({ where: { id: lead.id }, data: { status, motivoEncerramento: motivo, naFilaEm: null } });
  await prisma.agendamento.updateMany({
    where: { leadId: lead.id, status: "PRE_RESERVADO" },
    data: { status: "CANCELADO", canceladoEm: new Date(), motivoCancelamento: motivo },
  });
  if (lead.conversaId) {
    await prisma.conversa.update({ where: { id: lead.conversaId }, data: { modo: "HUMANO" } });
    await registrarSistema(lead.conversaId, `Lead marcado como "${STATUS_ROTULO[status]}"${quem ? ` por ${quem}` : ""}: ${motivo}`);
  }
  emitirEvento({ tipo: "leads" });
}

/** Devolve a conversa para a equipe sem encerrar o lead. */
export async function passarParaHumano(lead: Lead, motivo: string) {
  if (lead.conversaId) {
    await prisma.conversa.update({ where: { id: lead.conversaId }, data: { modo: "HUMANO" } });
    await registrarSistema(lead.conversaId, `Assistente passou a conversa para a equipe: ${motivo}`);
  }
  await avisarEquipe(lead, {
    tipo: "lead_precisa_humano",
    titulo: `${lead.nome} precisa de atendimento`,
    mensagem: motivo,
    severidade: "aviso",
    href: lead.conversaId ? `/dashboard/atendimento?conversa=${lead.conversaId}` : undefined,
    chave: `lead-humano:${lead.id}:${Date.now()}`,
  });
  emitirEvento({ tipo: "leads" });
}

const SAIR = /^(sair|parar|pare|para|stop|cancelar|remover|descadastrar|n[aã]o quero|n[aã]o tenho interesse|sem interesse|n[aã]o me (mande|mandem|envie|chame) mais( mensage(m|ns))?|n[aã]o (tenho|estou) interessad[oa])[\s.!]*$/i;

export const pediuParaSair = (texto: string) => SAIR.test(texto.trim().normalize("NFC"));

/**
 * Chamado a cada mensagem que chega. Vincula o lead que chamou primeiro,
 * marca a resposta e trata o pedido para sair. Devolve true quando o agente
 * NÃO deve responder.
 */
export async function aoReceberDoLead(conversaId: string, telefone: string | null, texto: string): Promise<boolean> {
  let lead = await prisma.lead.findUnique({ where: { conversaId } });
  if (!lead && telefone) {
    // Lead que chamou primeiro (ex.: link wa.me passado pelo comercial).
    const chave = chaveTelefone(telefone);
    const candidatos = await prisma.lead.findMany({ where: { conversaId: null, status: { in: ["NOVO", "NA_FILA"] } } });
    const achado = candidatos.find((l) => chave !== null && chaveTelefone(l.telefone) === chave);
    if (achado) {
      const { conversa, agente } = await conversaDoLead(achado);
      await registrarSistema(conversa.id, `O lead ${achado.nome} chamou primeiro; conversa passada ao ${agente.nome}.`);
      lead = await prisma.lead.update({ where: { id: achado.id }, data: { status: "EM_CONVERSA", naFilaEm: null } });
    }
  }
  if (!lead) return false;

  const agora = new Date();
  if (pediuParaSair(texto) && !ENCERRADOS.includes(lead.status) && lead.status !== "AGENDADO") {
    await prisma.lead.update({ where: { id: lead.id }, data: { ultimaRespostaEm: agora } });
    await encerrarLead(lead, "DESCARTADO", "Pediu para não receber mais mensagens");
    return true;
  }
  await prisma.lead.update({
    where: { id: lead.id },
    data: { ultimaRespostaEm: agora, ...(lead.status === "SEM_RESPOSTA" ? { status: "EM_CONVERSA" } : {}) },
  });
  emitirEvento({ tipo: "leads" });
  return false;
}
