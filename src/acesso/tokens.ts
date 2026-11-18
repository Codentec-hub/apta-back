// Links de uso único para criar a senha (convite) ou redefini-la. O token só
// existe no link: no banco fica o hash SHA-256.
import { createHash, randomBytes } from "node:crypto";
import type { TipoTokenAcesso } from "@prisma/client";
import { assinatura, escritorio } from "../escritorio.js";
import { emailConfigurado, enviarEmail } from "../envio/email.js";
import { prismaBase as prisma } from "../prisma.js";

const VALIDADE_MS: Record<TipoTokenAcesso, number> = {
  CONVITE: 7 * 24 * 60 * 60_000,
  REDEFINICAO: 2 * 60 * 60_000,
};

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export function linkDeAcesso(token: string): string {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/definir-senha?token=${token}`;
}

/** Gera um link novo e invalida os anteriores ainda não usados do usuário. */
export async function gerarTokenAcesso(usuarioId: string, tipo: TipoTokenAcesso) {
  const token = randomBytes(32).toString("base64url");
  const expiraEm = new Date(Date.now() + VALIDADE_MS[tipo]);
  await prisma.$transaction([
    prisma.tokenAcesso.updateMany({ where: { usuarioId, usadoEm: null }, data: { usadoEm: new Date() } }),
    prisma.tokenAcesso.create({ data: { tokenHash: hash(token), tipo, expiraEm, usuarioId } }),
  ]);
  return { token, link: linkDeAcesso(token), expiraEm };
}

/** Token válido (não usado, não vencido, usuário ativo) ou null. */
export async function tokenValido(token: string) {
  if (!token || token.length > 100) return null;
  const t = await prisma.tokenAcesso.findUnique({
    where: { tokenHash: hash(token) },
    include: { usuario: { select: { id: true, nome: true, email: true, perfil: true, ativo: true } } },
  });
  if (!t || t.usadoEm || t.expiraEm < new Date() || !t.usuario.ativo) return null;
  return t;
}

const escapar = (t: string) =>
  t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Manda o link por e-mail. Devolve se foi enviado (false = e-mail não ligado ou falhou). */
export async function enviarLinkAcesso(
  usuario: { nome: string; email: string },
  tipo: TipoTokenAcesso,
  link: string,
): Promise<boolean> {
  if (!emailConfigurado()) return false;
  const nome = escritorio().nome;
  const primeiro = usuario.nome.split(" ")[0] ?? "";
  const convite = tipo === "CONVITE";
  const assunto = convite ? `Seu acesso ao sistema · ${nome}` : `Redefinir sua senha · ${nome}`;
  const frase = convite
    ? `Você foi convidado(a) para o sistema da ${nome}. Clique no botão para criar sua senha. O link vale por 7 dias.`
    : "Recebemos um pedido para redefinir sua senha. Clique no botão para criar uma nova. O link vale por 2 horas. Se não foi você, ignore este e-mail.";
  const botao = convite ? "Criar minha senha" : "Redefinir senha";
  try {
    await enviarEmail({
      para: usuario.email,
      assunto,
      texto: `Olá, ${primeiro}!\n\n${frase}\n\n${link}\n\n${assinatura()}`,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1f2937;line-height:1.5"><p>Olá, ${escapar(primeiro)}!</p><p>${escapar(frase)}</p><p><a href="${escapar(link)}" style="display:inline-block;background:#1e3a5f;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${botao}</a></p><p style="color:#6b7280;font-size:12px">Se o botão não abrir, copie este endereço no navegador:<br>${escapar(link)}</p><p style="color:#6b7280;font-size:12px;margin-top:24px">${escapar(assinatura())}</p></div>`,
    });
    return true;
  } catch (error) {
    console.error("[acesso] e-mail não enviado", error);
    return false;
  }
}
