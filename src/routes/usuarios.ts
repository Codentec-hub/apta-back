import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prisma } from "../prisma.js";

export const usuariosRouter = Router();

usuariosRouter.use(autenticar);

const usuarioSelect = {
  id: true,
  nome: true,
  email: true,
  perfil: true,
  ativo: true,
  setorId: true,
  setor: true,
  createdAt: true,
} as const;

usuariosRouter.get("/usuarios", asyncHandler(async (_req, res) => {
  const usuarios = await prisma.usuario.findMany({
    orderBy: { nome: "asc" },
    select: usuarioSelect,
  });
  res.json(usuarios);
}));

const criarUsuarioSchema = z.object({
  nome: z.string().min(1),
  email: z.string().email(),
  senha: z.string().min(6),
  perfil: z.enum(["ADMIN", "GESTOR", "OPERACIONAL"]).optional(),
  setorId: z.string().uuid().optional().nullable(),
});

usuariosRouter.post("/usuarios", asyncHandler(async (req, res) => {
  const parsed = criarUsuarioSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }

  const { nome, email, senha, perfil, setorId } = parsed.data;

  const jaExiste = await prisma.usuario.findUnique({ where: { email } });
  if (jaExiste) {
    res.status(409).json({ erro: "Já existe um usuário com este e-mail" });
    return;
  }

  const senhaHash = await bcrypt.hash(senha, 10);

  const usuario = await prisma.usuario.create({
    data: { nome, email, senhaHash, perfil, setorId },
    select: usuarioSelect,
  });

  res.status(201).json(usuario);
}));

const atualizarUsuarioSchema = z.object({
  nome: z.string().min(1).optional(),
  perfil: z.enum(["ADMIN", "GESTOR", "OPERACIONAL"]).optional(),
  setorId: z.string().uuid().optional().nullable(),
  ativo: z.boolean().optional(),
  senha: z.string().min(6).optional(),
});

usuariosRouter.put("/usuarios/:id", asyncHandler(async (req, res) => {
  const parsed = atualizarUsuarioSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.flatten() });
    return;
  }

  const usuarioExistente = await prisma.usuario.findUnique({ where: { id: req.params.id } });
  if (!usuarioExistente) {
    res.status(404).json({ erro: "Usuário não encontrado" });
    return;
  }

  const { senha, ...resto } = parsed.data;

  const usuario = await prisma.usuario.update({
    where: { id: req.params.id },
    data: {
      ...resto,
      ...(senha ? { senhaHash: await bcrypt.hash(senha, 10) } : {}),
    },
    select: usuarioSelect,
  });

  res.json(usuario);
}));

usuariosRouter.delete("/usuarios/:id", asyncHandler(async (req, res) => {
  const usuarioExistente = await prisma.usuario.findUnique({ where: { id: req.params.id } });
  if (!usuarioExistente) {
    res.status(404).json({ erro: "Usuário não encontrado" });
    return;
  }

  await prisma.usuario.update({
    where: { id: req.params.id },
    data: { ativo: false },
  });
  res.status(204).send();
}));
