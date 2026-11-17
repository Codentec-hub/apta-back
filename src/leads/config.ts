// Configuração do assistente de leads (linha única) e o agente "Assistente
// de Leads", criado na primeira vez com instruções-modelo — a equipe ajusta
// o texto na tela Agentes de IA depois de validar com o cliente.
import type { ConfiguracaoLeads } from "@prisma/client";
import { escritorio } from "../escritorio.js";
import { prisma } from "../prisma.js";

export const NOME_AGENTE_LEADS = "Assistente de Leads";

export const MENSAGENS_INICIAIS_PADRAO = [
  "Oi, {primeiroNome}! Tudo bem? Aqui é o assistente da {escritorio}. O {indicador} me passou seu contato e pediu para eu te ajudar a marcar uma conversa com a nossa equipe. Pode falar agora?",
  "Olá, {primeiroNome}, tudo certo? Sou o assistente da {escritorio}. O {indicador} comentou comigo sobre o seu interesse, e eu cuido de agendar o seu atendimento. Posso te fazer duas perguntas rápidas?",
  "Oi, {primeiroNome}! Aqui é da {escritorio}, sou o assistente que organiza a agenda da equipe. O {indicador} me falou de você. Quer que eu veja um horário para vocês conversarem?",
  "{primeiroNome}, tudo bem? Aqui é o assistente da {escritorio}. Vim pelo {indicador}, que me pediu para te chamar e encontrar um bom horário para uma conversa com o nosso time. Pode ser?",
];

export const LEMBRETE_PADRAO =
  "Oi, {primeiroNome}! Passando só para saber se ainda faz sentido marcarmos aquela conversa. Se não for o momento, sem problema, é só me dizer.";

export const CONFIRMACAO_PADRAO =
  "Oi, {primeiroNome}! Seu atendimento com a {escritorio} está confirmado para {data}, {formato}. Se precisar remarcar, é só responder esta mensagem. Até lá!";

export const INSTRUCOES_PADRAO = `Você é o assistente comercial da Apta Contabilidade no WhatsApp. Conversa com pessoas que demonstraram interesse em serviços de contabilidade (abrir empresa, trocar de contador, organizar impostos).

Objetivo: entender rapidamente se a pessoa é o público da Apta e, se for, marcar uma conversa com a equipe.

Tom: cordial, próximo e direto. Mensagens curtas (1 a 3 frases), uma pergunta por vez, linguagem simples, sem jargão contábil. Use o primeiro nome da pessoa. No máximo um emoji por mensagem, e só às vezes.

Público da Apta: quem já tem empresa (CNPJ) ou vai abrir uma, com interesse real em contratar contabilidade.
Fora do perfil (encerre com educação): quem procura emprego/estágio, quer só tirar uma dúvida pontual sem contratar, pessoa física sem intenção de abrir empresa, ou oferece serviços para a Apta.

Valores: não informe preços. Diga que a equipe apresenta a proposta na conversa, depois de entender o caso.`;

export async function configLeads(): Promise<ConfiguracaoLeads> {
  const atual = await prisma.configuracaoLeads.findUnique({ where: { id: 1 } });
  if (atual) return atual;
  return prisma.configuracaoLeads.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
}

/** Agente usado nas conversas de lead; cria o padrão se ainda não existir. */
export async function agenteDosLeads(): Promise<{ id: string; nome: string; ativo: boolean }> {
  const config = await configLeads();
  if (config.agenteId) {
    const agente = await prisma.agenteIA.findUnique({ where: { id: config.agenteId } });
    if (agente) return agente;
  }
  const agente =
    (await prisma.agenteIA.findUnique({ where: { nome: NOME_AGENTE_LEADS } })) ??
    (await prisma.agenteIA.create({
      data: {
        nome: NOME_AGENTE_LEADS,
        descricao: "Chama os leads passados pelo comercial, confere o perfil e agenda a conversa com a equipe.",
        instrucoes: INSTRUCOES_PADRAO,
      },
    }));
  await prisma.configuracaoLeads.update({ where: { id: 1 }, data: { agenteId: agente.id } });
  return agente;
}

/** Troca {primeiroNome}, {nome}, {indicador}, {escritorio}, {data}, {formato}. */
export function preencher(texto: string, valores: Record<string, string>): string {
  const base = { escritorio: escritorio().nome, ...valores };
  return texto.replace(/\{(\w+)\}/g, (inteiro, chave: string) => (chave in base ? base[chave as keyof typeof base]! : inteiro));
}

export function mensagensIniciais(config: ConfiguracaoLeads): string[] {
  const proprias = config.mensagensIniciais.map((m) => m.trim()).filter(Boolean);
  return proprias.length ? proprias : MENSAGENS_INICIAIS_PADRAO;
}

export const sortear = <T>(lista: T[]): T => lista[Math.floor(Math.random() * lista.length)]!;
