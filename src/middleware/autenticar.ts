import type { NextFunction, Request, Response } from "express";
import { verificarToken, type TokenPayload } from "../auth.js";
import { contextoAuditoria } from "../auditoria/contexto.js";
import { prismaBase as prisma } from "../prisma.js";

declare global {
  namespace Express {
    interface Request {
      usuario?: TokenPayload;
    }
  }
}

// O token vale 8h, mas perfil e "ativo" são relidos do banco (com cache curto):
// quem é desativado ou muda de perfil perde o acesso antigo em até 30 s.
const CACHE_MS = 30_000;
const cache = new Map<string, { perfil: string; ativo: boolean; nome: string | null; em: number }>();

export function esquecerUsuario(usuarioId: string): void {
  cache.delete(usuarioId);
}

async function situacaoAtual(usuarioId: string) {
  const guardado = cache.get(usuarioId);
  if (guardado && Date.now() - guardado.em < CACHE_MS) return guardado;
  const u = await prisma.usuario.findUnique({ where: { id: usuarioId }, select: { perfil: true, ativo: true, nome: true } });
  const situacao = { perfil: u?.perfil ?? "", ativo: Boolean(u?.ativo), nome: u?.nome ?? null, em: Date.now() };
  cache.set(usuarioId, situacao);
  return situacao;
}

export function autenticar(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    res.status(401).json({ erro: "Token não informado" });
    return;
  }

  let payload: TokenPayload;
  try {
    payload = verificarToken(token);
  } catch {
    res.status(401).json({ erro: "Token inválido ou expirado" });
    return;
  }

  situacaoAtual(payload.usuarioId)
    .then((s) => {
      if (!s.ativo) {
        res.status(401).json({ erro: "Usuário desativado. Fale com o administrador." });
        return;
      }
      req.usuario = { ...payload, perfil: s.perfil };
      // Tudo o que esta requisição gravar no banco sai na auditoria em nome dela.
      contextoAuditoria.run({ usuarioId: payload.usuarioId, usuarioNome: s.nome, ip: req.ip ?? null }, next);
    })
    .catch(next);
}
