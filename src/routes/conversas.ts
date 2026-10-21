// Caixa de entrada do WhatsApp (Fase 3.5): conversas, chat, triagem,
// transferência entre setores/atendentes e troca Humano ↔ Agente Apta.
import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prisma } from "../prisma.js";
import { motorAgenteConfigurado, acionarAgente } from "../atendimento/agente.js";
import {
  CANAL_WHATSAPP,
  atendimentoAberto,
  conversaDoTelefone,
  enviarMensagem,
  receberMensagem,
  registrarNotaInterna,
  registrarSistema,
} from "../atendimento/conversas.js";
import { dadosFinalizar, dadosIniciar, responsavelSugerido, TransicaoInvalida } from "../atendimento/sessao.js";
import { emitirEvento } from "../eventos.js";
import { provedorWhatsApp } from "../whatsapp/provedor.js";
import { chaveTelefone, telefoneValido } from "../whatsapp/telefone.js";

export const conversasRouter = Router();

conversasRouter.use(autenticar);

const JANELA_24H_MS = 24 * 60 * 60 * 1000;
const LIMITE_FINALIZADAS = 100;
const LIMITE_MENSAGENS = 300;

const conversaInclude = {
  cliente: { select: { id: true, razaoSocial: true, nomeFantasia: true, apelido: true, codigo: true, cnpj: true } },
  contato: { select: { id: true, nome: true, cargo: true } },
  agente: { select: { id: true, nome: true } },
  atendimentos: {
    orderBy: { abertoEm: "desc" },
    take: 1,
    include: {
      setor: { select: { id: true, nome: true } },
      responsavel: { select: { id: true, nome: true } },
      motivoCategoria: { select: { id: true, nome: true } },
    },
  },
} as const;

type Aba = "triagem" | "aguardando" | "em_atendimento" | "agente" | "finalizadas";
const ABAS: Aba[] = ["triagem", "aguardando", "em_atendimento", "agente", "finalizadas"];

function abaDa(conversa: { modo: string; atendimentos: { status: string }[] }): Aba {
  const atual = conversa.atendimentos[0];
  if (!atual || atual.status === "FINALIZADO") return "finalizadas";
  if (conversa.modo === "AGENTE") return "agente";
  if (atual.status === "TRIAGEM") return "triagem";
  if (atual.status === "AGUARDANDO") return "aguardando";
  return "em_atendimento";
}

function semAcento(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Serializa a conversa com o atendimento mais recente "achatado".
function formatar<T extends { atendimentos: unknown[] }>(conversa: T) {
  const { atendimentos, ...resto } = conversa;
  return { ...resto, atendimento: atendimentos[0] ?? null };
}

function responderTransicao(res: Response, error: unknown): boolean {
  if (error instanceof TransicaoInvalida) {
    res.status(409).json({ erro: error.message });
    return true;
  }
  return false;
}

async function nomeDoUsuario(req: Request): Promise<string> {
  const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario!.usuarioId }, select: { nome: true } });
  return usuario?.nome ?? "Atendente";
}

conversasRouter.get("/conversas", asyncHandler(async (req, res) => {
  const aba = ABAS.includes(req.query.aba as Aba) ? (req.query.aba as Aba) : "aguardando";
  const setorId = typeof req.query.setorId === "string" && req.query.setorId ? req.query.setorId : null;
  const minhas = req.query.minhas === "1";
  const busca = typeof req.query.busca === "string" ? semAcento(req.query.busca.trim()) : "";

  const todas = await prisma.conversa.findMany({
    orderBy: [{ ultimaMensagemEm: { sort: "desc", nulls: "last" } }],
    include: conversaInclude,
  });

  const filtradas = todas.filter((c) => {
    const atual = c.atendimentos[0];
    if (setorId && atual?.setorId !== setorId) return false;
    if (minhas && atual?.responsavelId !== req.usuario!.usuarioId) return false;
    return true;
  });

  const contagem = Object.fromEntries(ABAS.map((a) => [a, 0])) as Record<Aba, number>;
  for (const c of filtradas) contagem[abaDa(c)] += 1;

  const chaveBusca = busca ? chaveTelefone(busca) : null;
  let lista = filtradas.filter((c) => abaDa(c) === aba);
  if (busca) {
    lista = lista.filter((c) => {
      const textos = [
        c.cliente?.razaoSocial, c.cliente?.nomeFantasia, c.cliente?.apelido, c.contato?.nome, c.nomeExibicao,
        c.cliente ? String(c.cliente.codigo) : null,
      ];
      return (
        textos.some((t) => t && semAcento(t).includes(busca)) ||
        (c.telefone !== null && c.telefone.includes(busca.replace(/\D/g, "") || "—")) ||
        (chaveBusca !== null && c.telefone !== null && chaveTelefone(c.telefone) === chaveBusca)
      );
    });
  }
  if (aba === "finalizadas") lista = lista.slice(0, LIMITE_FINALIZADAS);

  res.json({ conversas: lista.map(formatar), contagem });
}));

conversasRouter.get("/conversas/:id", asyncHandler(async (req, res) => {
  const conversa = await prisma.conversa.findUnique({ where: { id: req.params.id }, include: conversaInclude });
  if (!conversa) {
    res.status(404).json({ erro: "Conversa não encontrada" });
    return;
  }
  const mensagens = await prisma.mensagem.findMany({
    where: { conversaId: conversa.id },
    orderBy: { createdAt: "desc" },
    take: LIMITE_MENSAGENS,
    include: { usuario: { select: { id: true, nome: true } }, agente: { select: { id: true, nome: true } } },
  });
  if (conversa.naoLidas > 0) {
    await prisma.conversa.update({ where: { id: conversa.id }, data: { naoLidas: 0 } });
    emitirEvento({ tipo: "conversa", conversaId: conversa.id });
  }
  const totalAtendimentos = await prisma.atendimento.count({ where: { conversaId: conversa.id } });
  res.json({ ...formatar({ ...conversa, naoLidas: 0 }), mensagens: mensagens.reverse(), totalAtendimentos });
}));

const novaConversaSchema = z
  .object({
    contatoId: z.string().uuid().optional(),
    telefone: z.string().refine(telefoneValido, "Telefone inválido (informe com DDD)").optional(),
    clienteId: z.string().uuid().optional().nullable(),
    setorId: z.string().uuid(),
  })
  .refine((d) => d.contatoId || d.telefone, { message: "Informe o contato ou o telefone" });

// Iniciar uma conversa pelo escritório (ex.: cobrar um documento). Se já há
// atendimento aberto, só devolve a conversa.
conversasRouter.post("/conversas", asyncHandler(async (req, res) => {
  const parsed = novaConversaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  let telefone = parsed.data.telefone ?? null;
  let clienteId = parsed.data.clienteId ?? null;
  let contatoId: string | null = null;
  if (parsed.data.contatoId) {
    const contato = await prisma.contatoCliente.findUnique({ where: { id: parsed.data.contatoId } });
    if (!contato?.celular || !telefoneValido(contato.celular)) {
      res.status(400).json({ erro: "Este contato não tem um celular válido cadastrado" });
      return;
    }
    telefone = contato.celular;
    clienteId = contato.clienteId;
    contatoId = contato.id;
  }

  let conversa = await conversaDoTelefone(telefone!);
  if (!conversa.clienteId && clienteId) {
    conversa = await prisma.conversa.update({
      where: { id: conversa.id },
      data: { clienteId, contatoId: contatoId ?? conversa.contatoId },
    });
  }
  if (!(await atendimentoAberto(conversa.id))) {
    await prisma.atendimento.create({
      data: {
        conversaId: conversa.id,
        clienteId: conversa.clienteId,
        setorId: parsed.data.setorId,
        status: "EM_ATENDIMENTO",
        iniciadoEm: new Date(),
        responsavelId: req.usuario!.usuarioId,
      },
    });
    emitirEvento({ tipo: "conversa", conversaId: conversa.id });
  }
  res.status(201).json({ id: conversa.id });
}));

const CANAIS_MANUAIS = {
  telefone: "Telefone",
  presencial: "Presencial",
  email: "E-mail",
  whatsapp_externo: "WhatsApp (fora do sistema)",
  outro: "Outro",
} as const;

const registrarSchema = z.object({
  clienteId: z.string().uuid(),
  contatoId: z.string().uuid().optional().nullable(),
  canal: z.enum(Object.keys(CANAIS_MANUAIS) as [keyof typeof CANAIS_MANUAIS, ...(keyof typeof CANAIS_MANUAIS)[]]),
  setorId: z.string().uuid(),
  // Vazio = quem está registrando atende. Outra pessoa = vai para a fila dela.
  responsavelId: z.string().uuid().optional().nullable(),
  assunto: z.string().trim().min(1).max(200),
  descricao: z.string().trim().max(4000).optional().nullable(),
  // Já resolvido na hora (ex.: ligação rápida): finaliza com o motivo.
  motivoId: z.string().uuid().optional().nullable(),
});

// Atendimento que não veio pelo WhatsApp do sistema (ligação, balcão, e-mail,
// WhatsApp do Suri...): entra na mesma caixa de entrada, com o mesmo fluxo.
conversasRouter.post("/atendimentos/registrar", asyncHandler(async (req, res) => {
  const parsed = registrarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  const usuarioId = req.usuario!.usuarioId;
  const cliente = await prisma.cliente.findUnique({ where: { id: d.clienteId } });
  const setor = await prisma.setor.findUnique({ where: { id: d.setorId } });
  if (!cliente || !setor) {
    res.status(404).json({ erro: "Cliente ou setor não encontrado" });
    return;
  }
  const contato = d.contatoId ? await prisma.contatoCliente.findUnique({ where: { id: d.contatoId } }) : null;
  if (d.contatoId && contato?.clienteId !== cliente.id) {
    res.status(400).json({ erro: "O contato não pertence a esta empresa" });
    return;
  }
  const motivo = d.motivoId ? await prisma.motivoAtendimento.findUnique({ where: { id: d.motivoId } }) : null;
  if (d.motivoId && !motivo) {
    res.status(404).json({ erro: "Motivo não encontrado" });
    return;
  }

  const responsavelId = d.responsavelId ?? usuarioId;
  const paraOutro = responsavelId !== usuarioId;
  const agora = new Date();
  const conversa = await prisma.conversa.create({
    data: { canal: d.canal, clienteId: cliente.id, contatoId: contato?.id ?? null, nomeExibicao: contato?.nome ?? null },
  });
  await prisma.atendimento.create({
    data: {
      conversaId: conversa.id,
      clienteId: cliente.id,
      setorId: setor.id,
      responsavelId,
      motivo: d.assunto,
      ...(motivo
        ? // Resolvido na hora: conta no total e nos motivos, mas não nas médias
          // de espera/duração (não foram medidas).
          { status: "FINALIZADO" as const, finalizadoEm: agora, motivoId: motivo.id }
        : paraOutro
          ? { status: "AGUARDANDO" as const }
          : { status: "EM_ATENDIMENTO" as const, iniciadoEm: agora }),
    },
  });
  const quem = await nomeDoUsuario(req);
  await registrarSistema(conversa.id, `Atendimento registrado (${CANAIS_MANUAIS[d.canal]}) por ${quem}`);
  await registrarNotaInterna(conversa.id, d.descricao ? `${d.assunto}\n\n${d.descricao}` : d.assunto, usuarioId);
  if (paraOutro && !motivo) {
    const responsavel = await prisma.usuario.findUnique({ where: { id: responsavelId }, select: { nome: true } });
    await registrarSistema(conversa.id, `Encaminhado para ${setor.nome} · ${responsavel?.nome ?? "—"}`);
  }
  if (motivo) {
    await registrarSistema(conversa.id, `Atendimento finalizado por ${quem} · ${motivo.nome}`);
  }
  res.status(201).json({ id: conversa.id });
}));

async function buscarConversa(res: Response, id: string) {
  const conversa = await prisma.conversa.findUnique({ where: { id } });
  if (!conversa) {
    res.status(404).json({ erro: "Conversa não encontrada" });
  }
  return conversa;
}

const mensagemSchema = z.object({ texto: z.string().trim().min(1).max(4096), interna: z.boolean().optional() });

conversasRouter.post("/conversas/:id/mensagens", asyncHandler(async (req, res) => {
  const parsed = mensagemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const conversa = await buscarConversa(res, req.params.id);
  if (!conversa) return;
  const usuarioId = req.usuario!.usuarioId;

  // Atendimento registrado à mão: não há para onde enviar; tudo é registro
  // da equipe (e conta como andamento do atendimento).
  if (conversa.canal !== CANAL_WHATSAPP) {
    const atual = await atendimentoAberto(conversa.id);
    if (atual && atual.status !== "EM_ATENDIMENTO") {
      await prisma.atendimento.update({ where: { id: atual.id }, data: dadosIniciar(atual, usuarioId) });
    }
    res.status(201).json(await registrarNotaInterna(conversa.id, parsed.data.texto, usuarioId));
    return;
  }

  if (parsed.data.interna) {
    res.status(201).json(await registrarNotaInterna(conversa.id, parsed.data.texto, usuarioId));
    return;
  }

  const provedor = provedorWhatsApp();
  if (
    provedor.exigeJanela24h &&
    (!conversa.ultimaEntradaEm || Date.now() - conversa.ultimaEntradaEm.getTime() > JANELA_24H_MS)
  ) {
    res.status(409).json({ erro: "Passaram 24h desde a última mensagem do cliente: só é possível enviar um modelo aprovado" });
    return;
  }

  // Humano respondeu: o agente sai de cena e o atendimento passa a ser dele.
  if (conversa.modo === "AGENTE") {
    await prisma.conversa.update({ where: { id: conversa.id }, data: { modo: "HUMANO" } });
    await registrarSistema(conversa.id, `${await nomeDoUsuario(req)} assumiu a conversa (agente pausado)`);
  }
  const atual = await atendimentoAberto(conversa.id);
  if (!atual) {
    const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId }, select: { setorId: true } });
    await prisma.atendimento.create({
      data: {
        conversaId: conversa.id,
        clienteId: conversa.clienteId,
        setorId: usuario?.setorId ?? null,
        status: "EM_ATENDIMENTO",
        iniciadoEm: new Date(),
        responsavelId: usuarioId,
      },
    });
  } else if (atual.status !== "EM_ATENDIMENTO") {
    await prisma.atendimento.update({ where: { id: atual.id }, data: dadosIniciar(atual, usuarioId) });
  }

  const mensagem = await enviarMensagem({ conversaId: conversa.id, texto: parsed.data.texto, autor: "ATENDENTE", usuarioId });
  res.status(201).json(mensagem);
}));

const vincularSchema = z.object({
  clienteId: z.string().uuid(),
  contatoId: z.string().uuid().optional().nullable(),
  // Cadastra o número como novo contato da empresa.
  novoContatoNome: z.string().trim().min(1).optional().nullable(),
});

conversasRouter.put("/conversas/:id/vincular", asyncHandler(async (req, res) => {
  const parsed = vincularSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const conversa = await buscarConversa(res, req.params.id);
  if (!conversa) return;
  const cliente = await prisma.cliente.findUnique({ where: { id: parsed.data.clienteId } });
  if (!cliente) {
    res.status(404).json({ erro: "Cliente não encontrado" });
    return;
  }

  let contatoId = parsed.data.contatoId ?? null;
  let nomeContato: string | null = null;
  if (contatoId) {
    const contato = await prisma.contatoCliente.findUnique({ where: { id: contatoId } });
    if (contato?.clienteId !== cliente.id) {
      res.status(400).json({ erro: "O contato não pertence a esta empresa" });
      return;
    }
    nomeContato = contato.nome;
  } else if (parsed.data.novoContatoNome) {
    const contato = await prisma.contatoCliente.create({
      data: { clienteId: cliente.id, nome: parsed.data.novoContatoNome, celular: conversa.telefone, recebeTodos: true },
    });
    contatoId = contato.id;
    nomeContato = contato.nome;
  }

  await prisma.conversa.update({ where: { id: conversa.id }, data: { clienteId: cliente.id, contatoId } });
  const atual = await atendimentoAberto(conversa.id);
  if (atual) {
    await prisma.atendimento.update({
      where: { id: atual.id },
      data: {
        clienteId: cliente.id,
        ...(atual.setorId && !atual.responsavelId
          ? { responsavelId: await responsavelSugerido(cliente.id, atual.setorId) }
          : {}),
      },
    });
  }
  await registrarSistema(
    conversa.id,
    `Número vinculado a ${cliente.razaoSocial}${nomeContato ? ` · ${nomeContato}` : ""} por ${await nomeDoUsuario(req)}`
  );
  res.status(204).send();
}));

// Desfaz o vínculo com cliente/contato (ex.: vínculo de teste, ou cadastro
// que mudou e a conversa não deve mais apontar pro antigo). O telefone em si
// nunca muda — é a identidade real do canal.
conversasRouter.put("/conversas/:id/desvincular", asyncHandler(async (req, res) => {
  const conversa = await buscarConversa(res, req.params.id);
  if (!conversa) return;
  if (!conversa.clienteId && !conversa.contatoId) {
    res.status(204).send();
    return;
  }
  const nomeAnterior = conversa.clienteId
    ? (await prisma.cliente.findUnique({ where: { id: conversa.clienteId }, select: { razaoSocial: true } }))?.razaoSocial
    : null;
  await prisma.conversa.update({ where: { id: conversa.id }, data: { clienteId: null, contatoId: null } });
  await registrarSistema(
    conversa.id,
    `Número desvinculado${nomeAnterior ? ` de ${nomeAnterior}` : ""} por ${await nomeDoUsuario(req)}`
  );
  res.status(204).send();
}));

const encaminharSchema = z.object({
  setorId: z.string().uuid(),
  responsavelId: z.string().uuid().optional().nullable(),
});

// Triagem e transferência: define setor (e responsável — o sugerido, se não
// vier um). Mudou de responsável, volta para a fila dele.
conversasRouter.post("/conversas/:id/encaminhar", asyncHandler(async (req, res) => {
  const parsed = encaminharSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const conversa = await buscarConversa(res, req.params.id);
  if (!conversa) return;
  const atual = await atendimentoAberto(conversa.id);
  if (!atual) {
    res.status(409).json({ erro: "Não há atendimento aberto nesta conversa" });
    return;
  }
  const setor = await prisma.setor.findUnique({ where: { id: parsed.data.setorId } });
  if (!setor) {
    res.status(404).json({ erro: "Setor não encontrado" });
    return;
  }
  const responsavelId =
    parsed.data.responsavelId ?? (await responsavelSugerido(atual.clienteId ?? conversa.clienteId, setor.id));
  const trocouResponsavel = responsavelId !== atual.responsavelId;
  await prisma.atendimento.update({
    where: { id: atual.id },
    data: {
      setorId: setor.id,
      responsavelId,
      ...(atual.status === "TRIAGEM" || trocouResponsavel ? { status: "AGUARDANDO" } : {}),
    },
  });
  const responsavel = responsavelId
    ? await prisma.usuario.findUnique({ where: { id: responsavelId }, select: { nome: true } })
    : null;
  await registrarSistema(
    conversa.id,
    `Encaminhado para ${setor.nome}${responsavel ? ` · ${responsavel.nome}` : " (sem responsável)"} por ${await nomeDoUsuario(req)}`
  );
  res.status(204).send();
}));

conversasRouter.post("/conversas/:id/assumir", asyncHandler(async (req, res) => {
  const conversa = await buscarConversa(res, req.params.id);
  if (!conversa) return;
  const usuarioId = req.usuario!.usuarioId;
  const atual = await atendimentoAberto(conversa.id);
  if (!atual) {
    res.status(409).json({ erro: "Não há atendimento aberto nesta conversa" });
    return;
  }
  await prisma.atendimento.update({
    where: { id: atual.id },
    data: {
      responsavelId: usuarioId,
      status: "EM_ATENDIMENTO",
      iniciadoEm: atual.iniciadoEm ?? new Date(),
    },
  });
  if (conversa.modo === "AGENTE") {
    await prisma.conversa.update({ where: { id: conversa.id }, data: { modo: "HUMANO" } });
  }
  await registrarSistema(conversa.id, `${await nomeDoUsuario(req)} assumiu o atendimento`);
  res.status(204).send();
}));

const modoSchema = z.discriminatedUnion("modo", [
  z.object({ modo: z.literal("HUMANO") }),
  z.object({ modo: z.literal("AGENTE"), agenteId: z.string().uuid() }),
]);

conversasRouter.put("/conversas/:id/modo", asyncHandler(async (req, res) => {
  const parsed = modoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const conversa = await buscarConversa(res, req.params.id);
  if (!conversa) return;
  const quem = await nomeDoUsuario(req);

  if (parsed.data.modo === "HUMANO") {
    await prisma.conversa.update({ where: { id: conversa.id }, data: { modo: "HUMANO" } });
    await registrarSistema(conversa.id, `Conversa voltou para atendimento humano (${quem})`);
    res.status(204).send();
    return;
  }

  if (conversa.canal !== CANAL_WHATSAPP) {
    res.status(400).json({ erro: "O agente só atende conversas de WhatsApp do sistema" });
    return;
  }
  const agente = await prisma.agenteIA.findUnique({ where: { id: parsed.data.agenteId } });
  if (!agente?.ativo) {
    res.status(400).json({ erro: "Agente não encontrado ou inativo" });
    return;
  }
  await prisma.conversa.update({ where: { id: conversa.id }, data: { modo: "AGENTE", agenteId: agente.id } });
  await registrarSistema(conversa.id, `Conversa passada para o agente ${agente.nome} (${quem})`);
  // Última mensagem é do cliente: o agente já pode responder.
  const ultima = await prisma.mensagem.findFirst({
    where: { conversaId: conversa.id, interna: false, autor: { not: "SISTEMA" } },
    orderBy: { createdAt: "desc" },
  });
  if (ultima?.autor === "CLIENTE") {
    acionarAgente(conversa.id).catch((error) => console.error("[agente]", error));
  }
  res.status(204).send();
}));

const finalizarSchema = z.object({
  motivoId: z.string().uuid(),
  observacoes: z.string().trim().optional().nullable(),
});

conversasRouter.post("/conversas/:id/finalizar", asyncHandler(async (req, res) => {
  const parsed = finalizarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "Escolha o motivo do atendimento" });
    return;
  }
  const conversa = await buscarConversa(res, req.params.id);
  if (!conversa) return;
  const atual = await atendimentoAberto(conversa.id);
  if (!atual) {
    res.status(409).json({ erro: "Não há atendimento aberto nesta conversa" });
    return;
  }
  const motivo = await prisma.motivoAtendimento.findUnique({ where: { id: parsed.data.motivoId } });
  if (!motivo) {
    res.status(404).json({ erro: "Motivo não encontrado" });
    return;
  }
  try {
    await prisma.atendimento.update({
      where: { id: atual.id },
      data: { ...dadosFinalizar(atual, motivo.id), observacoes: parsed.data.observacoes ?? atual.observacoes },
    });
  } catch (error) {
    if (responderTransicao(res, error)) return;
    throw error;
  }
  await prisma.conversa.update({ where: { id: conversa.id }, data: { naoLidas: 0 } });
  await registrarSistema(conversa.id, `Atendimento finalizado por ${await nomeDoUsuario(req)} · ${motivo.nome}`);
  res.status(204).send();
}));

conversasRouter.get("/whatsapp/status", asyncHandler(async (_req, res) => {
  const provedor = provedorWhatsApp();
  res.json({
    provedor: provedor.nome,
    simulador: provedor.simulador,
    exigeJanela24h: provedor.exigeJanela24h,
    agenteConfigurado: await motorAgenteConfigurado(),
  });
}));

const simularSchema = z.object({
  telefone: z.string().refine(telefoneValido, "Telefone inválido (informe com DDD)"),
  nome: z.string().trim().optional().nullable(),
  texto: z.string().trim().min(1),
});

// Simula a chegada de uma mensagem de cliente (só com o provedor simulador).
conversasRouter.post("/whatsapp/simulador/receber", asyncHandler(async (req, res) => {
  if (!provedorWhatsApp().simulador) {
    res.status(404).json({ erro: "Simulador desligado" });
    return;
  }
  const parsed = simularSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }
  const mensagem = await receberMensagem({
    telefone: parsed.data.telefone,
    nomeExibicao: parsed.data.nome,
    texto: parsed.data.texto,
    idExterno: `sim-in-${crypto.randomUUID()}`,
  });
  res.status(201).json({ conversaId: mensagem?.conversaId ?? null });
}));
