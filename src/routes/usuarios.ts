import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar, esquecerUsuario } from "../middleware/autenticar.js";
import { somenteAdmin } from "../middleware/perfil.js";
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

const adminsAtivos = () => prisma.usuario.count({ where: { perfil: "ADMIN", ativo: true } });

usuariosRouter.get("/usuarios", asyncHandler(async (_req, res) => {
  const usuarios = await prisma.usuario.findMany({
    orderBy: { nome: "asc" },
    select: usuarioSelect,
  });
  res.json(usuarios);
}));

const criarUsuarioSchema = z.object({
  nome: z.string().min(1),
  email: z.string().trim().toLowerCase().email(),
  senha: z.string().min(8, "A senha precisa ter pelo menos 8 caracteres"),
  perfil: z.enum(["ADMIN", "GESTOR", "OPERACIONAL"]).optional(),
  setorId: z.string().uuid().optional().nullable(),
});

usuariosRouter.post("/usuarios", somenteAdmin, asyncHandler(async (req, res) => {
  const parsed = criarUsuarioSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.issues[0]?.message ?? "Dados inválidos" });
    return;
  }

  const { nome, email, senha, perfil, setorId } = parsed.data;

  const jaExiste = await prisma.usuario.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
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
  senha: z.string().min(8, "A senha precisa ter pelo menos 8 caracteres").optional(),
});

usuariosRouter.put("/usuarios/:id", somenteAdmin, asyncHandler(async (req, res) => {
  const parsed = atualizarUsuarioSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.issues[0]?.message ?? "Dados inválidos" });
    return;
  }

  const usuarioExistente = await prisma.usuario.findUnique({ where: { id: req.params.id } });
  if (!usuarioExistente) {
    res.status(404).json({ erro: "Usuário não encontrado" });
    return;
  }

  const { senha, ...resto } = parsed.data;

  // Proteções: ninguém tira o próprio acesso de admin, e sempre sobra um admin ativo.
  const proprio = req.params.id === req.usuario!.usuarioId;
  if (proprio && (resto.ativo === false || (resto.perfil && resto.perfil !== usuarioExistente.perfil))) {
    res.status(400).json({ erro: "Você não pode desativar nem mudar o perfil do seu próprio usuário." });
    return;
  }
  const deixaDeSerAdmin =
    usuarioExistente.perfil === "ADMIN" && usuarioExistente.ativo && (resto.ativo === false || (resto.perfil && resto.perfil !== "ADMIN"));
  if (deixaDeSerAdmin && (await adminsAtivos()) <= 1) {
    res.status(400).json({ erro: "Este é o único administrador ativo. Cadastre outro administrador antes." });
    return;
  }

  const usuario = await prisma.usuario.update({
    where: { id: req.params.id },
    data: {
      ...resto,
      ...(senha ? { senhaHash: await bcrypt.hash(senha, 10) } : {}),
    },
    select: usuarioSelect,
  });
  esquecerUsuario(usuario.id);

  res.json(usuario);
}));

usuariosRouter.delete("/usuarios/:id", somenteAdmin, asyncHandler(async (req, res) => {
  const usuarioExistente = await prisma.usuario.findUnique({ where: { id: req.params.id } });
  if (!usuarioExistente) {
    res.status(404).json({ erro: "Usuário não encontrado" });
    return;
  }

  if (req.params.id === req.usuario!.usuarioId) {
    res.status(400).json({ erro: "Você não pode desativar o seu próprio usuário." });
    return;
  }
  if (usuarioExistente.perfil === "ADMIN" && usuarioExistente.ativo && (await adminsAtivos()) <= 1) {
    res.status(400).json({ erro: "Este é o único administrador ativo. Cadastre outro administrador antes." });
    return;
  }

  await prisma.usuario.update({
    where: { id: req.params.id },
    data: { ativo: false },
  });
  esquecerUsuario(req.params.id);
  res.status(204).send();
}));
