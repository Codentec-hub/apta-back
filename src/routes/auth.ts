import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { assinarToken } from "../auth.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { registrarAuditoria } from "../auditoria/registrar.js";
import { prisma, prismaBase } from "../prisma.js";

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
    void registrarAuditoria(prismaBase, {
      acao: "login_falhou",
      modulo: "acesso",
      descricao: `Tentativa de login com senha errada (${email})`,
      usuarioId: usuario?.id ?? null,
      usuarioNome: usuario?.nome ?? null,
      ip,
    });
    res.status(401).json({ erro: "E-mail ou senha incorretos" });
    return;
  }
  if (!usuario.ativo) {
    res.status(401).json({ erro: "Usuário desativado. Fale com o administrador." });
    return;
  }
  falhas.delete(`e:${email}`);
  void registrarAuditoria(prismaBase, {
    acao: "login",
    modulo: "acesso",
    descricao: `${usuario.nome} entrou no sistema`,
    usuarioId: usuario.id,
    usuarioNome: usuario.nome,
    ip,
  });

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
    select: { id: true, nome: true, email: true, perfil: true, setor: true, fotoEm: true },
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
    select: { id: true, nome: true, email: true, perfil: true, setor: true, fotoEm: true },
  });
  res.json(usuario);
}));

// ------------------------------------------------------------- foto de perfil

// O navegador já reduz a imagem (256px); aqui só confere tipo e tamanho.
const FOTO_MAX = 300 * 1024;
const fotoSchema = z.object({ imagem: z.string().regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/) });

function tipoReal(b: Buffer): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

authRouter.put("/auth/me/foto", autenticar, asyncHandler(async (req, res) => {
  const parsed = fotoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: "Envie uma imagem JPG, PNG ou WebP" });
    return;
  }
  const dados = Buffer.from(parsed.data.imagem.split(",")[1] ?? "", "base64");
  const mime = tipoReal(dados);
  if (!mime) {
    res.status(400).json({ erro: "O arquivo não é uma imagem válida" });
    return;
  }
  if (dados.length > FOTO_MAX) {
    res.status(400).json({ erro: "Imagem grande demais" });
    return;
  }
  const usuarioId = req.usuario!.usuarioId;
  await prismaBase.fotoUsuario.upsert({
    where: { usuarioId },
    create: { usuarioId, dados, mime },
    update: { dados, mime },
  });
  const usuario = await prisma.usuario.update({
    where: { id: usuarioId },
    data: { fotoEm: new Date() },
    select: { id: true, nome: true, email: true, perfil: true, setor: true, fotoEm: true },
  });
  res.json(usuario);
}));

authRouter.delete("/auth/me/foto", autenticar, asyncHandler(async (req, res) => {
  const usuarioId = req.usuario!.usuarioId;
  await prismaBase.fotoUsuario.deleteMany({ where: { usuarioId } });
  await prisma.usuario.update({ where: { id: usuarioId }, data: { fotoEm: null } });
  res.status(204).send();
}));

// Sem login: <img> não manda o token. O id é um UUID e a URL leva a versão
// (?v=), então pode ficar em cache para sempre.
authRouter.get("/usuarios/:id/foto", asyncHandler(async (req, res) => {
  const foto = await prismaBase.fotoUsuario.findUnique({ where: { usuarioId: req.params.id } });
  if (!foto) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", foto.mime);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(Buffer.from(foto.dados));
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
