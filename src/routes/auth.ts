import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { assinarToken } from "../auth.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prisma } from "../prisma.js";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(1),
});

authRouter.post("/auth/login", asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "E-mail e senha são obrigatórios" });
    return;
  }

  const { email, senha } = parsed.data;

  const usuario = await prisma.usuario.findUnique({ where: { email } });
  if (!usuario || !usuario.ativo) {
    res.status(401).json({ erro: "Credenciais inválidas" });
    return;
  }

  const senhaConfere = await bcrypt.compare(senha, usuario.senhaHash);
  if (!senhaConfere) {
    res.status(401).json({ erro: "Credenciais inválidas" });
    return;
  }

  const token = assinarToken({ usuarioId: usuario.id, perfil: usuario.perfil });

  res.json({
    token,
    usuario: {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      perfil: usuario.perfil,
      setorId: usuario.setorId,
    },
  });
}));

authRouter.get("/auth/me", autenticar, asyncHandler(async (req, res) => {
  const usuario = await prisma.usuario.findUnique({
    where: { id: req.usuario!.usuarioId },
    select: { id: true, nome: true, email: true, perfil: true, setor: true },
  });

  if (!usuario) {
    res.status(404).json({ erro: "Usuário não encontrado" });
    return;
  }

  res.json(usuario);
}));
