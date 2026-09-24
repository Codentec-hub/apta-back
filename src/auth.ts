import jwt from "jsonwebtoken";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET não definido no ambiente");
}

const JWT_SECRET: string = process.env.JWT_SECRET;

export type TokenPayload = {
  usuarioId: string;
  perfil: string;
};

export function assinarToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "8h" });
}

export function verificarToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}
