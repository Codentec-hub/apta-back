import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prisma } from "../prisma.js";

export const clientesRouter = Router();

clientesRouter.use(autenticar);

const clienteInclude = {
  responsaveis: {
    include: { setor: true, usuario: true },
  },
} as const;

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

const criarClienteSchema = z.object({
  razaoSocial: z.string().min(1),
  nomeFantasia: z.string().optional().nullable(),
  cnpj: z.string().min(1),
  regimeTributario: z.string().optional().nullable(),
});

clientesRouter.post("/clientes", asyncHandler(async (req, res) => {
  const parsed = criarClienteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "razaoSocial e cnpj são obrigatórios" });
    return;
  }

  const jaExiste = await prisma.cliente.findUnique({ where: { cnpj: parsed.data.cnpj } });
  if (jaExiste) {
    res.status(409).json({ erro: "Já existe um cliente com este CNPJ" });
    return;
  }

  const cliente = await prisma.cliente.create({
    data: parsed.data,
    include: clienteInclude,
  });
  res.status(201).json(cliente);
}));

const atualizarClienteSchema = z.object({
  razaoSocial: z.string().min(1).optional(),
  nomeFantasia: z.string().optional().nullable(),
  cnpj: z.string().min(1).optional(),
  regimeTributario: z.string().optional().nullable(),
  ativo: z.boolean().optional(),
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

  const cliente = await prisma.cliente.update({
    where: { id: req.params.id },
    data: parsed.data,
    include: clienteInclude,
  });
  res.json(cliente);
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
  res.status(204).send();
}));

const responsavelSchema = z.object({
  usuarioId: z.string().uuid(),
});

clientesRouter.put("/clientes/:id/responsaveis/:setorId", asyncHandler(async (req, res) => {
  const parsed = responsavelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "usuarioId é obrigatório" });
    return;
  }

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
    include: { setor: true, usuario: true },
  });

  res.json(responsavel);
}));

clientesRouter.delete("/clientes/:id/responsaveis/:setorId", asyncHandler(async (req, res) => {
  await prisma.clienteResponsavel
    .delete({
      where: {
        clienteId_setorId: { clienteId: req.params.id, setorId: req.params.setorId },
      },
    })
    .catch(() => null);

  res.status(204).send();
}));
