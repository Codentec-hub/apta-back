import type { NextFunction, Request, Response } from "express";
import { verificarToken, type TokenPayload } from "../auth.js";

declare global {
  namespace Express {
    interface Request {
      usuario?: TokenPayload;
    }
  }
}

export function autenticar(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    res.status(401).json({ erro: "Token não informado" });
    return;
  }

  try {
    req.usuario = verificarToken(token);
    next();
  } catch {
    res.status(401).json({ erro: "Token inválido ou expirado" });
  }
}
