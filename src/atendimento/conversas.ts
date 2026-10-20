// Núcleo da caixa de entrada do WhatsApp: mensagens que chegam (do provedor
// ou do simulador), mensagens que saem e os registros do sistema na conversa.
import type { AutorMensagem, Prisma, StatusMensagem } from "@prisma/client";
import { emitirEvento } from "../eventos.js";
import { prisma } from "../prisma.js";
import { provedorWhatsApp } from "../whatsapp/provedor.js";
import { chaveTelefone, normalizarTelefone } from "../whatsapp/telefone.js";
import { acionarAgente } from "./agente.js";
import { estaAberto, responsavelSugerido } from "./sessao.js";

const RESUMO_MAX = 140;

// Procura o número entre os contatos ativos; empresas ativas têm
// preferência, mas ex-clientes também são reconhecidos.
export async function identificarContato(telefone: string) {
  const chave = chaveTelefone(telefone);
  if (!chave) {
    return null;
  }
  const contatos = await prisma.contatoCliente.findMany({
    where: { ativo: true, celular: { not: null } },
    include: { cliente: { select: { ativo: true } } },
  });
  const encontrados = contatos.filter((c) => chaveTelefone(c.celular!) === chave);
  return encontrados.find((c) => c.cliente.ativo) ?? encontrados[0] ?? null;
}

export async function atendimentoAberto(conversaId: string) {
  const ultimo = await prisma.atendimento.findFirst({ where: { conversaId }, orderBy: { abertoEm: "desc" } });
  return ultimo && estaAberto(ultimo) ? ultimo : null;
}

interface NovaMensagem {
  conversaId: string;
  autor: AutorMensagem;
  texto: string;
  status: StatusMensagem;
  interna?: boolean;
  usuarioId?: string | null;
  agenteId?: string | null;
  protocoloId?: string | null;
  idExterno?: string | null;
}

export const CANAL_WHATSAPP = "whatsapp";

async function registrarMensagem(dados: NovaMensagem) {
  const mensagem = await prisma.mensagem.create({ data: dados });
  const { canal } = await prisma.conversa.findUniqueOrThrow({ where: { id: dados.conversaId }, select: { canal: true } });
  // Nota interna e registro do sistema não mexem no resumo da lista — exceto
  // no atendimento registrado à mão, em que tudo é registro da equipe.
  if ((!dados.interna || canal !== CANAL_WHATSAPP) && dados.autor !== "SISTEMA") {
    const doCliente = dados.autor === "CLIENTE";
    await prisma.conversa.update({
      where: { id: dados.conversaId },
      data: {
        ultimaMensagemEm: mensagem.createdAt,
        ultimaMensagemTexto: dados.texto.slice(0, RESUMO_MAX),
        ...(doCliente ? { ultimaEntradaEm: mensagem.createdAt, naoLidas: { increment: 1 } } : {}),
      },
    });
  }
  emitirEvento({ tipo: "conversa", conversaId: dados.conversaId });
  return mensagem;
}

export function registrarSistema(conversaId: string, texto: string) {
  return registrarMensagem({ conversaId, autor: "SISTEMA", texto, status: "ENVIADA" });
}

export function registrarNotaInterna(conversaId: string, texto: string, usuarioId: string) {
  return registrarMensagem({ conversaId, autor: "ATENDENTE", texto, status: "ENVIADA", interna: true, usuarioId });
}

// Nova sessão para uma mensagem que chegou sem atendimento aberto. Se o
// contato só recebe de um departamento, já entra na fila desse setor com o
// responsável sugerido; senão, vai para a triagem.
async function abrirAtendimentoDeEntrada(conversa: { id: string; clienteId: string | null; contatoId: string | null }) {
  let setorId: string | null = null;
  if (conversa.contatoId) {
    const contato = await prisma.contatoCliente.findUnique({
      where: { id: conversa.contatoId },
      include: { setores: { select: { id: true } } },
    });
    if (contato && !contato.recebeTodos && contato.setores.length === 1) {
      setorId = contato.setores[0].id;
    }
  }
  return prisma.atendimento.create({
    data: {
      conversaId: conversa.id,
      clienteId: conversa.clienteId,
      setorId,
      status: setorId && conversa.clienteId ? "AGUARDANDO" : "TRIAGEM",
      responsavelId: setorId ? await responsavelSugerido(conversa.clienteId, setorId) : null,
    },
  });
}

export async function conversaDoTelefone(telefoneBruto: string, nomeExibicao?: string | null) {
  const telefone = normalizarTelefone(telefoneBruto);
  const existente = await prisma.conversa.findUnique({ where: { telefone } });
  if (existente) {
    if (nomeExibicao && !existente.nomeExibicao) {
      return prisma.conversa.update({ where: { id: existente.id }, data: { nomeExibicao } });
    }
    return existente;
  }
  const contato = await identificarContato(telefone);
  return prisma.conversa.create({
    data: {
      telefone,
      nomeExibicao: nomeExibicao ?? null,
      clienteId: contato?.clienteId ?? null,
      contatoId: contato?.id ?? null,
    },
  });
}

export interface MensagemRecebida {
  telefone: string;
  nomeExibicao?: string | null;
  texto: string;
  idExterno?: string | null;
}

// Entrada única para mensagens de clientes (webhook do provedor ou simulador).
export async function receberMensagem(entrada: MensagemRecebida) {
  if (entrada.idExterno && (await prisma.mensagem.findUnique({ where: { idExterno: entrada.idExterno } }))) {
    return null; // provedores reenviam o mesmo evento
  }
  const conversa = await conversaDoTelefone(entrada.telefone, entrada.nomeExibicao);
  if (!(await atendimentoAberto(conversa.id))) {
    await abrirAtendimentoDeEntrada(conversa);
  }
  const mensagem = await registrarMensagem({
    conversaId: conversa.id,
    autor: "CLIENTE",
    texto: entrada.texto,
    status: "RECEBIDA",
    idExterno: entrada.idExterno ?? null,
  });
  if (conversa.modo === "AGENTE") {
    acionarAgente(conversa.id).catch((error) => console.error("[agente]", error));
  }
  return mensagem;
}

export async function atualizarStatusMensagem(idExterno: string, status: StatusMensagem, erro?: string) {
  const mensagem = await prisma.mensagem.findUnique({ where: { idExterno } });
  if (!mensagem) {
    return;
  }
  await prisma.mensagem.update({ where: { id: mensagem.id }, data: { status, ...(erro ? { erro } : {}) } });
  emitirEvento({ tipo: "conversa", conversaId: mensagem.conversaId });
}

function simularConfirmacoes(idExterno: string) {
  setTimeout(() => atualizarStatusMensagem(idExterno, "ENTREGUE").catch(console.error), 1_500);
  setTimeout(() => atualizarStatusMensagem(idExterno, "LIDA").catch(console.error), 6_000);
}

interface MensagemSaida {
  conversaId: string;
  texto: string;
  autor: Extract<AutorMensagem, "ATENDENTE" | "AGENTE" | "AUTOMACAO">;
  usuarioId?: string | null;
  agenteId?: string | null;
  protocoloId?: string | null;
}

// Envia ao cliente pelo provedor. A mensagem é gravada antes do envio; se o
// provedor falhar, fica com status FALHA e o erro, sem lançar exceção.
export async function enviarMensagem(saida: MensagemSaida) {
  const conversa = await prisma.conversa.findUniqueOrThrow({ where: { id: saida.conversaId } });
  if (!conversa.telefone || conversa.canal !== CANAL_WHATSAPP) {
    throw new Error("Este atendimento não é uma conversa de WhatsApp do sistema");
  }
  const telefone = conversa.telefone;
  const mensagem = await registrarMensagem({ ...saida, status: "PENDENTE" });
  const provedor = provedorWhatsApp();

  let dados: Prisma.MensagemUpdateInput;
  try {
    const { idExterno } = await provedor.enviarTexto(telefone, saida.texto);
    dados = { status: "ENVIADA", idExterno };
    if (provedor.simulador && idExterno) {
      simularConfirmacoes(idExterno);
    }
  } catch (error) {
    dados = { status: "FALHA", erro: error instanceof Error ? error.message : String(error) };
  }
  const atualizada = await prisma.mensagem.update({ where: { id: mensagem.id }, data: dados });
  emitirEvento({ tipo: "conversa", conversaId: conversa.id });
  return atualizada;
}
