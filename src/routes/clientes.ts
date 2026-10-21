import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { recalcularFuturas } from "../obrigacoes/gerar-entregas.js";
import { prisma } from "../prisma.js";
import { redistribuirPendentes } from "../obrigacoes/responsaveis.js";
import { aoInativarCliente, aoReativarCliente, aplicarRegimePorNome } from "../obrigacoes/alocacao.js";

export const clientesRouter = Router();

clientesRouter.use(autenticar);

// Desvincula as conversas do Atendimento de um cliente/contato inativado:
// o telefone em si continua existindo na conversa (é o histórico real de
// quem conversou), mas nome e vínculo de cadastro somem, em vez de seguir
// mostrando um cadastro que já foi corrigido/removido.
async function desvincularConversas(where: { clienteId?: string; contatoId?: string }): Promise<void> {
  await prisma.conversa.updateMany({ where, data: { clienteId: null, contatoId: null } });
}

const clienteInclude = {
  responsaveis: {
    include: { setor: true, usuario: { select: { id: true, nome: true, email: true, perfil: true, ativo: true, setorId: true } } },
  },
  contatos: {
    where: { ativo: true },
    orderBy: { nome: "asc" },
    include: { setores: { select: { id: true, nome: true } } },
  },
} as const;

// Campos do cadastro da empresa no Acessórias além do básico.
const camposEmpresa = {
  apelido: z.string().trim().optional().nullable(),
  cidade: z.string().trim().optional().nullable(),
  uf: z
    .string()
    .trim()
    .length(2)
    .transform((v) => v.toUpperCase())
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  grupoEmpresas: z.string().trim().optional().nullable(),
  honorario: z.coerce.number().min(0).optional().nullable(),
  dataAbertura: z.coerce.date().optional().nullable(),
  situacaoCadastral: z.string().trim().optional().nullable(),
  cnaePrincipal: z.string().trim().optional().nullable(),
  cnaeDescricao: z.string().trim().optional().nullable(),
  cnaesSecundarios: z
    .array(z.object({ codigo: z.string(), descricao: z.string() }))
    .optional()
    .nullable(),
  atividades: z.array(z.enum(["servicos", "comercio", "industria"])).optional(),
  inscricaoEstadual: z.string().trim().optional().nullable(),
  inscricaoMunicipal: z.string().trim().optional().nullable(),
  notasEmitidas: z.array(z.enum(["nfse", "nfe", "nfce", "cte"])).optional(),
  cep: z.string().trim().optional().nullable(),
  endereco: z.string().trim().optional().nullable(),
};

clientesRouter.get("/clientes", asyncHandler(async (_req, res) => {
  const clientes = await prisma.cliente.findMany({
    orderBy: { razaoSocial: "asc" },
    include: clienteInclude,
  });
  res.json(clientes);
}));

clientesRouter.get("/clientes/:id", asyncHandler(async (req, res) => {
  const cliente = await prisma.cliente.findUnique({
    where: { id: req.params.id },
    include: clienteInclude,
  });

  if (!cliente) {
    res.status(404).json({ erro: "Cliente não encontrado" });
    return;
  }

  res.json(cliente);
}));

// CNPJ/CPF/CAEPF guardado só com dígitos (a tela formata); assim o mesmo
// documento digitado com ou sem máscara não vira dois clientes.
const documentoSchema = z
  .string()
  .transform((v) => v.replace(/\D/g, ""))
  .refine((v) => v.length === 11 || v.length === 14, "Documento deve ter 11 (CPF) ou 14 dígitos (CNPJ/CAEPF)");

const criarClienteSchema = z.object({
  // Sócios vindos da consulta do CNPJ, cadastrados como contatos.
  socios: z
    .array(z.object({ nome: z.string().trim().min(1), cargo: z.string().trim().optional().nullable(), responsavelLegal: z.boolean().optional() }))
    .optional(),
  razaoSocial: z.string().min(1),
  nomeFantasia: z.string().optional().nullable(),
  cnpj: documentoSchema,
  regimeTributario: z.string().optional().nullable(),
  ...camposEmpresa,
});

clientesRouter.post("/clientes", asyncHandler(async (req, res) => {
  const parsed = criarClienteSchema.safeParse(req.body);
  if (!parsed.success) {
    const doc = parsed.error.flatten().fieldErrors.cnpj?.[0];
    res.status(400).json({ erro: doc ?? "Razão social e CNPJ são obrigatórios" });
    return;
  }

  const jaExiste = await prisma.cliente.findUnique({ where: { cnpj: parsed.data.cnpj } });
  if (jaExiste) {
    res.status(409).json({ erro: "Já existe um cliente com este CNPJ" });
    return;
  }

  const { socios, cnaesSecundarios, ...dados } = parsed.data;
  const criado = await prisma.cliente.create({
    data: {
      ...dados,
      ...(cnaesSecundarios ? { cnaesSecundarios } : {}),
      contatos: socios?.length
        ? { create: socios.map((s) => ({ nome: s.nome, cargo: s.cargo ?? null, responsavelLegal: Boolean(s.responsavelLegal) })) }
        : undefined,
    },
  });
  // O regime escolhido já traz as obrigações dele (como "Aplicar regime").
  const obrigacoesAplicadas = await aplicarRegimePorNome(criado.id, parsed.data.regimeTributario);
  const cliente = await prisma.cliente.findUniqueOrThrow({ where: { id: criado.id }, include: clienteInclude });
  res.status(201).json({ ...cliente, obrigacoesAplicadas });
}));

const atualizarClienteSchema = z.object({
  razaoSocial: z.string().min(1).optional(),
  nomeFantasia: z.string().optional().nullable(),
  cnpj: documentoSchema.optional(),
  regimeTributario: z.string().optional().nullable(),
  ativo: z.boolean().optional(),
  ...camposEmpresa,
});

clientesRouter.put("/clientes/:id", asyncHandler(async (req, res) => {
  const parsed = atualizarClienteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }

  const clienteExistente = await prisma.cliente.findUnique({ where: { id: req.params.id } });
  if (!clienteExistente) {
    res.status(404).json({ erro: "Cliente não encontrado" });
    return;
  }

  if (parsed.data.cnpj) {
    const jaExiste = await prisma.cliente.findFirst({
      where: { cnpj: parsed.data.cnpj, id: { not: req.params.id } },
    });
    if (jaExiste) {
      res.status(409).json({ erro: "Já existe um cliente com este CNPJ" });
      return;
    }
  }

  const { cnaesSecundarios, ...dadosAtualizar } = parsed.data;
  const cliente = await prisma.cliente.update({
    where: { id: req.params.id },
    data: {
      ...dadosAtualizar,
      ...(cnaesSecundarios !== undefined ? { cnaesSecundarios: cnaesSecundarios ?? Prisma.DbNull } : {}),
    },
    include: clienteInclude,
  });

  // Mudou a localidade → os feriados estaduais/municipais que valem mudam,
  // e com eles os dias úteis das pendências futuras.
  if (
    (parsed.data.uf !== undefined && parsed.data.uf !== clienteExistente.uf) ||
    (parsed.data.cidade !== undefined && parsed.data.cidade !== clienteExistente.cidade)
  ) {
    await recalcularFuturas({ clienteId: cliente.id });
  }
  if (parsed.data.ativo === false && clienteExistente.ativo) {
    await aoInativarCliente(cliente.id);
    await desvincularConversas({ clienteId: cliente.id });
  }
  if (parsed.data.ativo === true && !clienteExistente.ativo) await aoReativarCliente(cliente.id);

  // Trocou de regime → as obrigações passam a ser as do novo regime.
  let obrigacoesAplicadas: number | null = null;
  if (parsed.data.regimeTributario && parsed.data.regimeTributario !== clienteExistente.regimeTributario) {
    obrigacoesAplicadas = await aplicarRegimePorNome(cliente.id, parsed.data.regimeTributario);
  }
  res.json({ ...cliente, obrigacoesAplicadas });
}));

clientesRouter.delete("/clientes/:id", asyncHandler(async (req, res) => {
  const clienteExistente = await prisma.cliente.findUnique({ where: { id: req.params.id } });
  if (!clienteExistente) {
    res.status(404).json({ erro: "Cliente não encontrado" });
    return;
  }

  await prisma.cliente.update({
    where: { id: req.params.id },
    data: { ativo: false },
  });
  if (clienteExistente.ativo) {
    await aoInativarCliente(clienteExistente.id);
    await desvincularConversas({ clienteId: clienteExistente.id });
  }
  res.status(204).send();
}));

// Quem as entregas pendentes do setor podiam ter antes da troca.
async function anterioresDoSetor(clienteId: string, setorId: string): Promise<(string | null)[]> {
  const [vinculo, setor] = await Promise.all([
    prisma.clienteResponsavel.findUnique({ where: { clienteId_setorId: { clienteId, setorId } } }),
    prisma.setor.findUnique({ where: { id: setorId }, select: { responsavelId: true } }),
  ]);
  return [vinculo?.usuarioId ?? null, setor?.responsavelId ?? null];
}

const responsavelSchema = z.object({
  usuarioId: z.string().uuid(),
});

clientesRouter.put("/clientes/:id/responsaveis/:setorId", asyncHandler(async (req, res) => {
  const parsed = responsavelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "usuarioId é obrigatório" });
    return;
  }

  const anterior = await anterioresDoSetor(req.params.id, req.params.setorId);
  const responsavel = await prisma.clienteResponsavel.upsert({
    where: {
      clienteId_setorId: { clienteId: req.params.id, setorId: req.params.setorId },
    },
    update: { usuarioId: parsed.data.usuarioId },
    create: {
      clienteId: req.params.id,
      setorId: req.params.setorId,
      usuarioId: parsed.data.usuarioId,
    },
    include: { setor: true, usuario: { select: { id: true, nome: true, email: true, perfil: true, ativo: true, setorId: true } } },
  });
  await redistribuirPendentes({ clienteId: req.params.id, setorId: req.params.setorId }, anterior);

  res.json(responsavel);
}));

clientesRouter.delete("/clientes/:id/responsaveis/:setorId", asyncHandler(async (req, res) => {
  const anterior = await anterioresDoSetor(req.params.id, req.params.setorId);
  await prisma.clienteResponsavel
    .delete({
      where: {
        clienteId_setorId: { clienteId: req.params.id, setorId: req.params.setorId },
      },
    })
    .catch(() => null);
  await redistribuirPendentes({ clienteId: req.params.id, setorId: req.params.setorId }, anterior);

  res.status(204).send();
}));

// "Contatos na empresa" — quem recebe os documentos de cada departamento.
const contatoSchema = z.object({
  nome: z.string().trim().min(1),
  cargo: z.string().trim().optional().nullable(),
  celular: z.string().trim().optional().nullable(),
  email: z.string().trim().email().optional().nullable().or(z.literal("").transform(() => null)),
  recebeTodos: z.boolean().default(true),
  responsavelLegal: z.boolean().default(false),
  setorIds: z.array(z.string().uuid()).default([]),
});

const contatoInclude = { setores: { select: { id: true, nome: true } } } as const;

clientesRouter.get("/clientes/:id/contatos", asyncHandler(async (req, res) => {
  const contatos = await prisma.contatoCliente.findMany({
    where: { clienteId: req.params.id, ativo: true },
    orderBy: { nome: "asc" },
    include: contatoInclude,
  });
  res.json(contatos);
}));

clientesRouter.post("/clientes/:id/contatos", asyncHandler(async (req, res) => {
  const parsed = contatoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "Informe ao menos o nome (e-mail, se houver, precisa ser válido)" });
    return;
  }
  const cliente = await prisma.cliente.findUnique({ where: { id: req.params.id } });
  if (!cliente) {
    res.status(404).json({ erro: "Cliente não encontrado" });
    return;
  }
  const { setorIds, ...dados } = parsed.data;
  const contato = await prisma.contatoCliente.create({
    data: {
      ...dados,
      clienteId: cliente.id,
      setores: { connect: dados.recebeTodos ? [] : setorIds.map((id) => ({ id })) },
    },
    include: contatoInclude,
  });
  res.status(201).json(contato);
}));

clientesRouter.put("/contatos/:id", asyncHandler(async (req, res) => {
  const parsed = contatoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "Informe ao menos o nome (e-mail, se houver, precisa ser válido)" });
    return;
  }
  const existente = await prisma.contatoCliente.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Contato não encontrado" });
    return;
  }
  const { setorIds, ...dados } = parsed.data;
  const contato = await prisma.contatoCliente.update({
    where: { id: req.params.id },
    data: {
      ...dados,
      setores: { set: dados.recebeTodos ? [] : setorIds.map((id) => ({ id })) },
    },
    include: contatoInclude,
  });
  res.json(contato);
}));

// Inativa em vez de apagar: protocolos antigos continuam apontando para ele.
clientesRouter.delete("/contatos/:id", asyncHandler(async (req, res) => {
  const existente = await prisma.contatoCliente.findUnique({ where: { id: req.params.id } });
  if (!existente) {
    res.status(404).json({ erro: "Contato não encontrado" });
    return;
  }
  await prisma.contatoCliente.update({ where: { id: req.params.id }, data: { ativo: false } });
  await desvincularConversas({ contatoId: req.params.id });
  res.status(204).send();
}));
