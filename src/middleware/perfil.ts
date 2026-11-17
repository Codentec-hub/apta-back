import type { NextFunction, Request, Response } from "express";

export type Perfil = "ADMIN" | "GESTOR" | "OPERACIONAL";

/**
 * Libera a rota só para os perfis informados. Use depois de `autenticar`.
 *   ADMIN: tudo (usuários, integrações, configurações).
 *   GESTOR: o dia a dia do escritório, cadastros-base e financeiro.
 *   OPERACIONAL: trabalha nas obrigações, clientes e atendimentos; não exclui
 *   cadastros nem mexe em configurações.
 */
export function exigirPerfil(...perfis: Perfil[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.usuario && perfis.includes(req.usuario.perfil as Perfil)) {
      next();
      return;
    }
    res.status(403).json({ erro: "Seu perfil não tem permissão para esta ação. Fale com o administrador." });
  };
}

export const somenteAdmin = exigirPerfil("ADMIN");
export const somenteGestao = exigirPerfil("ADMIN", "GESTOR");
