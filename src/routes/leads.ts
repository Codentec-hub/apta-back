// Leads comerciais: cadastro (à mão ou colando a mensagem do anúncio), fila
// do assistente, encerramento e reabertura.
import type { Prisma, StatusLead } from "@prisma/client";
import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { somenteGestao } from "../middleware/perfil.js";
import { prisma } from "../prisma.js";
import { emitirEvento } from "../eventos.js";
import { registrarSistema } from "../atendimento/conversas.js";
import { CAMPOS_PERFIL, interpretarMensagemLead, perfilCompleto, perfilDe } from "../leads/campos.js";
import { agenteDosLeads, configLeads } from "../leads/config.js";
import { situacaoDaFila } from "../leads/disparo.js";
import { cnpjDoTexto, cnpjValido, verificarDuplicidade, type AvisoDuplicidade } from "../leads/duplicidade.js";
import { ENCERRADOS, RegraLead, STATUS_ROTULO, devolverAoAssistente, encerrarLead, enfileirar, tirarDaFila } from "../leads/leads.js";
import { chaveTelefone, normalizarTelefone, telefoneValido } from "../whatsapp/telefone.js";

export const leadsRouter = Router();
leadsRouter.use("/leads", autenticar);

const STATUS = Object.keys(STATUS_ROTULO) as StatusLead[];

const leadInclude = {
  cadastradoPor: { select: { id: true, nome: true } },
  conversa: { select: { id: true, modo: true, ultimaMensagemEm: true, ultimaMensagemTexto: true, naoLidas: true } },
  agendamentos: {
    where: { status: { in: ["PRE_RESERVADO", "CONFIRMADO"] } },
    orderBy: { inicio: "asc" },
    take: 1,
    select: { id: true, inicio: true, fim: true, status: true, expiraEm: true },
  },
} satisfies Prisma.LeadInclude;

function responderRegra(res: Response, error: unknown): boolean {
  if (error instanceof RegraLead) {
    res.status(409).json({ erro: error.message });
    return true;
  }
  return false;
}

const quem = async (req: Request) =>
  (await prisma.usuario.findUnique({ where: { id: req.usuario!.usuarioId }, select: { nome: true } }))?.nome ?? "Equipe";

const semAcento = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Responde 409 quando há duplicidade: telefone de outro lead sempre bloqueia;
 * os demais avisos (cliente da casa, CNPJ em outro lead, conversa em
 * andamento, e-mail) só passam com confirmarAvisos.
 */
function barrarDuplicidade(res: Response, avisos: AvisoDuplicidade[], confirmado: boolean): boolean {
  const bloqueio = avisos.find((a) => a.bloqueia);
  if (bloqueio) {
    res.status(409).json({ erro: bloqueio.mensagem, avisos, leadId: bloqueio.leadId });
    return true;
  }
  if (avisos.length && !confirmado) {
    res.status(409).json({ erro: "Confira os avisos antes de salvar", avisos, precisaConfirmar: true });
    return true;
  }
  return false;
}

/** CNPJ informado no campo ou, se vazio, encontrado nas respostas do formulário. */
function cnpjDoLead(cnpj: string | null | undefined, perfil: Record<string, string> | null | undefined): string | null {
  const direto = cnpj?.replace(/\D/g, "");
  if (direto) return direto;
  return cnpjDoTexto(Object.values(perfil ?? {}).join(" "));
}

leadsRouter.get(
  "/leads",
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status.split(",").filter((s): s is StatusLead => STATUS.includes(s as StatusLead)) : [];
    const busca = typeof req.query.busca === "string" ? semAcento(req.query.busca.trim()) : "";
    const pagina = Math.max(0, Number(req.query.pagina) || 0);
    const porPagina = Math.min(100, Math.max(5, Number(req.query.porPagina) || 25));

    const todos = await prisma.lead.findMany({ orderBy: { createdAt: "desc" }, include: leadInclude });
    const digitos = busca.replace(/\D/g, "");
    const buscados = busca
      ? todos.filter(
          (l) =>
            semAcento(l.nome).includes(busca) ||
            (l.origem && semAcento(l.origem).includes(busca)) ||
            (digitos.length >= 4 && (l.telefone.includes(digitos) || Boolean(l.cnpj?.includes(digitos))))
        )
      : todos;
    const contagem = Object.fromEntries(STATUS.map((s) => [s, 0])) as Record<StatusLead, number>;
    for (const l of buscados) contagem[l.status] += 1;
    const filtrados = status.length ? buscados.filter((l) => status.includes(l.status)) : buscados;
    res.json({
      leads: filtrados.slice(pagina * porPagina, (pagina + 1) * porPagina),
      total: filtrados.length,
      contagem,
    });
  })
);

leadsRouter.get(
  "/leads/campos",
  asyncHandler(async (_req, res) => {
    res.json({ campos: CAMPOS_PERFIL.map(({ chave, rotulo, obrigatorio }) => ({ chave, rotulo, obrigatorio })), status: STATUS_ROTULO });
  })
);

leadsRouter.get(
  "/leads/fila",
  asyncHandler(async (_req, res) => {
    res.json(await situacaoDaFila());
  })
);

leadsRouter.post(
  "/leads/interpretar",
  asyncHandler(async (req, res) => {
    const texto = typeof req.body?.texto === "string" ? req.body.texto : "";
    if (!texto.trim()) {
      res.status(400).json({ erro: "Cole a mensagem do lead" });
      return;
    }
    const lido = interpretarMensagemLead(texto);
    const avisos = await verificarDuplicidade({ telefone: lido.telefone, cnpj: lido.cnpj, email: lido.email });
    const existente = avisos.find((a) => a.tipo === "lead_telefone");
    res.json({ ...lido, avisos, existente: existente ? { id: existente.leadId, nome: existente.mensagem } : null });
  })
);

// Checagem ao vivo do formulário (ao sair do campo telefone/CNPJ/e-mail).
leadsRouter.get(
  "/leads/verificar",
  asyncHandler(async (req, res) => {
    const q = (k: string) => (typeof req.query[k] === "string" && req.query[k] ? String(req.query[k]) : null);
    const telefone = q("telefone");
    const cnpj = q("cnpj")?.replace(/\D/g, "") || null;
    res.json({
      avisos: await verificarDuplicidade({
        telefone: telefone && telefoneValido(telefone) ? telefone : null,
        cnpj: cnpj && cnpjValido(cnpj) ? cnpj : null,
        email: q("email"),
        excetoId: q("excetoId"),
      }),
    });
  })
);

const perfilSchema = z.record(z.string(), z.string().max(1000));

const leadSchema = z.object({
  nome: z.string().trim().min(2, "Informe o nome").max(200),
  telefone: z.string().refine(telefoneValido, "Telefone inválido (informe com DDD)"),
  email: z.string().trim().email("E-mail inválido").optional().nullable().or(z.literal("")),
  cnpj: z
    .string()
    .trim()
    .optional()
    .nullable()
    .refine((v) => !v || cnpjValido(v), "CNPJ inválido (confira os números)"),
  origem: z.string().trim().max(100).optional().nullable(),
  observacoes: z.string().trim().max(4000).optional().nullable(),
  qualificacao: z.string().trim().max(1000).optional().nullable(),
  perfil: perfilSchema.optional().nullable(),
});

const primeiroErro = (e: z.ZodError) => e.issues[0]?.message ?? "Dados inválidos";

leadsRouter.post(
  "/leads",
  asyncHandler(async (req, res) => {
    const parsed = leadSchema.extend({ enviar: z.boolean().optional(), confirmarAvisos: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ erro: primeiroErro(parsed.error) });
      return;
    }
    const { enviar, confirmarAvisos, ...dados } = parsed.data;
    const telefone = normalizarTelefone(dados.telefone);
    const perfil = perfilDe(dados.perfil);
    const cnpj = cnpjDoLead(dados.cnpj, perfil);
    const email = dados.email ? dados.email.toLowerCase() : null;
    const avisos = await verificarDuplicidade({ telefone, cnpj, email });
    if (barrarDuplicidade(res, avisos, confirmarAvisos === true)) return;

    // Duas pessoas cadastrando o mesmo número ao mesmo tempo (um com o 9 e
    // outro sem): a trava por número deixa só a primeira passar.
    const chave = chaveTelefone(telefone)!;
    const lead = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lead:${chave}`}))`;
      const mesmos = await tx.lead.findMany({ where: { telefone: { endsWith: chave.slice(-8) } }, select: { telefone: true } });
      if (mesmos.some((l) => chaveTelefone(l.telefone) === chave)) return null;
      return tx.lead.create({
        data: { ...dados, email, cnpj, telefone, perfil, cadastradoPorId: req.usuario!.usuarioId },
      });
    });
    if (!lead) {
      res.status(409).json({ erro: "Esse telefone acabou de ser cadastrado por outra pessoa" });
      return;
    }
    if (avisos.length) {
      const nota = `Cadastrado com avisos confirmados: ${avisos.map((a) => a.mensagem).join(" ")}`;
      await prisma.lead.update({
        where: { id: lead.id },
        data: { observacoes: [lead.observacoes, nota].filter(Boolean).join("\n\n").slice(0, 4000) },
      });
    }
    const config = await configLeads();
    await agenteDosLeads(); // garante o agente para a primeira conversa
    if (enviar || config.disparoAutomatico) await enfileirar(lead.id);
    emitirEvento({ tipo: "leads" });
    res.status(201).json(await prisma.lead.findUnique({ where: { id: lead.id }, include: leadInclude }));
  })
);

leadsRouter.get(
  "/leads/:id",
  asyncHandler(async (req, res) => {
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      include: {
        ...leadInclude,
        agendamentos: { orderBy: { inicio: "desc" }, include: { confirmadoPor: { select: { id: true, nome: true } } } },
      },
    });
    if (!lead) {
      res.status(404).json({ erro: "Lead não encontrado" });
      return;
    }
    res.json({ ...lead, perfilCompleto: perfilCompleto(perfilDe(lead.perfil)) });
  })
);

leadsRouter.put(
  "/leads/:id",
  asyncHandler(async (req, res) => {
    const parsed = leadSchema.partial().extend({ confirmarAvisos: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ erro: primeiroErro(parsed.error) });
      return;
    }
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) {
      res.status(404).json({ erro: "Lead não encontrado" });
      return;
    }
    const { telefone, perfil, email, cnpj, confirmarAvisos, ...resto } = parsed.data;
    const data: Prisma.LeadUpdateInput = { ...resto };
    if (email !== undefined) data.email = email ? email.toLowerCase() : null;
    if (perfil !== undefined) data.perfil = perfilDe(perfil);
    if (cnpj !== undefined) data.cnpj = cnpj ? cnpj.replace(/\D/g, "") : null;
    else if (perfil !== undefined && !lead.cnpj) data.cnpj = cnpjDoLead(null, perfilDe(perfil));
    const trocouTelefone = telefone !== undefined && normalizarTelefone(telefone) !== lead.telefone;
    if (trocouTelefone) {
      if (lead.conversaId) {
        res.status(409).json({ erro: "O assistente já falou com este número; não dá para trocar o telefone" });
        return;
      }
      data.telefone = normalizarTelefone(telefone);
    }
    // Só confere o que mudou (o lead não é duplicado de si mesmo).
    const novoCnpj = typeof data.cnpj === "string" && data.cnpj !== lead.cnpj ? data.cnpj : null;
    const novoEmail = typeof data.email === "string" && data.email !== lead.email?.toLowerCase() ? data.email : null;
    const avisos = await verificarDuplicidade({
      telefone: trocouTelefone ? (data.telefone as string) : null,
      cnpj: novoCnpj,
      email: novoEmail,
      excetoId: lead.id,
    });
    if (barrarDuplicidade(res, avisos, confirmarAvisos === true)) return;
    await prisma.lead.update({ where: { id: lead.id }, data });
    emitirEvento({ tipo: "leads" });
    res.json(await prisma.lead.findUnique({ where: { id: lead.id }, include: leadInclude }));
  })
);

leadsRouter.post(
  "/leads/:id/enviar",
  asyncHandler(async (req, res) => {
    try {
      res.json(await enfileirar(req.params.id));
    } catch (error) {
      if (!responderRegra(res, error)) throw error;
    }
  })
);

leadsRouter.post(
  "/leads/:id/tirar-da-fila",
  asyncHandler(async (req, res) => {
    try {
      res.json(await tirarDaFila(req.params.id));
    } catch (error) {
      if (!responderRegra(res, error)) throw error;
    }
  })
);

leadsRouter.post(
  "/leads/:id/descartar",
  asyncHandler(async (req, res) => {
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) {
      res.status(404).json({ erro: "Lead não encontrado" });
      return;
    }
    if (ENCERRADOS.includes(lead.status)) {
      res.status(409).json({ erro: "Este lead já está encerrado" });
      return;
    }
    const motivo = typeof req.body?.motivo === "string" && req.body.motivo.trim() ? req.body.motivo.trim().slice(0, 500) : "Descartado pela equipe";
    const status = req.body?.foraDoPerfil === true ? "FORA_DO_PERFIL" : "DESCARTADO";
    await encerrarLead(lead, status, motivo, await quem(req));
    res.status(204).send();
  })
);

// Reabre um lead encerrado ou devolve a conversa ao assistente (depois que a
// equipe resolveu a dúvida que ele não sabia responder).
leadsRouter.post(
  "/leads/:id/reabrir",
  asyncHandler(async (req, res) => {
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) {
      res.status(404).json({ erro: "Lead não encontrado" });
      return;
    }
    try {
      await devolverAoAssistente(lead, await quem(req));
    } catch (error) {
      if (!responderRegra(res, error)) throw error;
      return;
    }
    res.status(204).send();
  })
);

leadsRouter.delete(
  "/leads/:id",
  somenteGestao,
  asyncHandler(async (req, res) => {
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) {
      res.status(404).json({ erro: "Lead não encontrado" });
      return;
    }
    if (lead.conversaId) {
      await prisma.conversa.update({ where: { id: lead.conversaId }, data: { modo: "HUMANO" } });
    }
    await prisma.lead.delete({ where: { id: lead.id } });
    emitirEvento({ tipo: "leads" });
    res.status(204).send();
  })
);
