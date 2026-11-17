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

// Limite de tentativas: 5 erros em 15 min por e-mail (ou 20 por IP) bloqueiam
// por 15 min. Em memória: basta para um escritório com um servidor só.
const JANELA_MS = 15 * 60_000;
const falhas = new Map<string, number[]>();
const recentes = (chave: string) => (falhas.get(chave) ?? []).filter((t) => Date.now() - t < JANELA_MS);
function bloqueado(email: string, ip: string): boolean {
  return recentes(`e:${email}`).length >= 5 || recentes(`i:${ip}`).length >= 20;
}
function registrarFalha(email: string, ip: string): void {
  for (const chave of [`e:${email}`, `i:${ip}`]) falhas.set(chave, [...recentes(chave), Date.now()]);
}

authRouter.post("/auth/login", asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "E-mail e senha são obrigatórios" });
    return;
  }

  const email = parsed.data.email.trim().toLowerCase();
  const { senha } = parsed.data;
  const ip = req.ip ?? "?";
  if (bloqueado(email, ip)) {
    res.status(429).json({ erro: "Muitas tentativas erradas. Aguarde 15 minutos e tente de novo." });
    return;
  }

  const usuario = await prisma.usuario.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
  const senhaConfere = usuario ? await bcrypt.compare(senha, usuario.senhaHash) : false;
  if (!usuario || !senhaConfere) {
    registrarFalha(email, ip);
    res.status(401).json({ erro: "E-mail ou senha incorretos" });
    return;
  }
  if (!usuario.ativo) {
    res.status(401).json({ erro: "Usuário desativado. Fale com o administrador." });
    return;
  }
  falhas.delete(`e:${email}`);

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

// ------------------------------------------------------------- minha conta

const minhaContaSchema = z.object({ nome: z.string().trim().min(1) });

authRouter.put("/auth/me", autenticar, asyncHandler(async (req, res) => {
  const parsed = minhaContaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "Informe o nome" });
    return;
  }
  const usuario = await prisma.usuario.update({
    where: { id: req.usuario!.usuarioId },
    data: { nome: parsed.data.nome },
    select: { id: true, nome: true, email: true, perfil: true, setor: true },
  });
  res.json(usuario);
}));

const trocarSenhaSchema = z.object({
  senhaAtual: z.string().min(1),
  novaSenha: z.string().min(8, "A nova senha precisa ter pelo menos 8 caracteres"),
});

authRouter.post("/auth/senha", autenticar, asyncHandler(async (req, res) => {
  const parsed = trocarSenhaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: parsed.error.issues[0]?.message ?? "Dados inválidos" });
    return;
  }
  const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario!.usuarioId } });
  if (!usuario || !(await bcrypt.compare(parsed.data.senhaAtual, usuario.senhaHash))) {
    res.status(400).json({ erro: "A senha atual está incorreta" });
    return;
  }
  await prisma.usuario.update({
    where: { id: usuario.id },
    data: { senhaHash: await bcrypt.hash(parsed.data.novaSenha, 10) },
  });
  res.status(204).send();
}));
