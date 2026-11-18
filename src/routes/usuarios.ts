import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar, esquecerUsuario } from "../middleware/autenticar.js";
import { somenteAdmin } from "../middleware/perfil.js";
import { prisma } from "../prisma.js";
import { enviarLinkAcesso, gerarTokenAcesso } from "../acesso/tokens.js";

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
  fotoEm: true,
  convitePendente: true,
  trocaObrigatoria: true,
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
  // Convite: a pessoa cria a própria senha pelo link. Sem convite, a senha é
  // definida aqui e (por padrão) tem que ser trocada no primeiro acesso.
  convite: z.boolean().optional(),
  senha: z.string().min(8, "A senha precisa ter pelo menos 8 caracteres").optional(),
  trocaObrigatoria: z.boolean().optional(),
  perfil: z.enum(["ADMIN", "GESTOR", "OPERACIONAL"]).optional(),
  setorId: z.string().uuid().optional().nullable(),
});

usuariosRouter.post("/usuarios", somenteAdmin, asyncHandler(async (req, res) => {
  const parsed = criarUsuarioSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.issues[0]?.message ?? "Dados inválidos" });
    return;
  }

  const { nome, email, senha, perfil, setorId, convite, trocaObrigatoria } = parsed.data;
  if (!convite && !senha) {
    res.status(400).json({ erro: "Informe a senha ou envie um convite" });
    return;
  }

  const jaExiste = await prisma.usuario.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
  if (jaExiste) {
    res.status(409).json({ erro: "Já existe um usuário com este e-mail" });
    return;
  }

  // Convite: senha aleatória que ninguém conhece até a pessoa criar a dela.
  const senhaHash = await bcrypt.hash(convite ? randomBytes(32).toString("hex") : senha!, 10);

  const usuario = await prisma.usuario.create({
    data: {
      nome,
      email,
      senhaHash,
      perfil,
      setorId,
      convitePendente: Boolean(convite),
      trocaObrigatoria: !convite && trocaObrigatoria !== false,
    },
    select: usuarioSelect,
  });

  if (!convite) {
    res.status(201).json(usuario);
    return;
  }
  const { link, expiraEm } = await gerarTokenAcesso(usuario.id, "CONVITE");
  const emailEnviado = await enviarLinkAcesso(usuario, "CONVITE", link);
  res.status(201).json({ ...usuario, acesso: { tipo: "CONVITE", link, expiraEm, emailEnviado } });
}));

const atualizarUsuarioSchema = z.object({
  nome: z.string().min(1).optional(),
  perfil: z.enum(["ADMIN", "GESTOR", "OPERACIONAL"]).optional(),
  setorId: z.string().uuid().optional().nullable(),
  ativo: z.boolean().optional(),
  senha: z.string().min(8, "A senha precisa ter pelo menos 8 caracteres").optional(),
  trocaObrigatoria: z.boolean().optional(),
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

  const { senha, trocaObrigatoria, ...resto } = parsed.data;

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
      // Senha nova dada pelo admin é provisória (salvo se ele desmarcar).
      ...(senha
        ? { senhaHash: await bcrypt.hash(senha, 10), trocaObrigatoria: trocaObrigatoria !== false, convitePendente: false }
        : {}),
    },
    select: usuarioSelect,
  });
  esquecerUsuario(usuario.id);

  res.json(usuario);
}));

// Link de acesso: convite (se a pessoa ainda não criou a senha) ou redefinição.
// Também manda por e-mail quando o envio está ligado; o link volta para o
// admin copiar e mandar por outro meio (WhatsApp).
usuariosRouter.post("/usuarios/:id/link-acesso", somenteAdmin, asyncHandler(async (req, res) => {
  const usuario = await prisma.usuario.findUnique({ where: { id: req.params.id }, select: usuarioSelect });
  if (!usuario) {
    res.status(404).json({ erro: "Usuário não encontrado" });
    return;
  }
  if (!usuario.ativo) {
    res.status(400).json({ erro: "Reative o usuário antes de gerar o link." });
    return;
  }
  const tipo = usuario.convitePendente ? "CONVITE" : "REDEFINICAO";
  const { link, expiraEm } = await gerarTokenAcesso(usuario.id, tipo);
  const emailEnviado = req.body?.enviarEmail === false ? false : await enviarLinkAcesso(usuario, tipo, link);
  res.json({ tipo, link, expiraEm, emailEnviado });
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
