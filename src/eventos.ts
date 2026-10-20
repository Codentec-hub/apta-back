// Eventos em tempo real para as telas abertas (Server-Sent Events). Hoje só
// a caixa de entrada do atendimento usa: qualquer mudança numa conversa
// avisa todo mundo, e a tela busca de novo o que precisa.
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { Router } from "express";
import { verificarToken } from "./auth.js";

export type Evento = { tipo: "conversa"; conversaId: string };

const barramento = new EventEmitter();
barramento.setMaxListeners(0);

export function emitirEvento(evento: Evento): void {
  barramento.emit("evento", evento);
}

export const eventosRouter = Router();

// EventSource não manda cabeçalho Authorization, então o token vem na URL.
eventosRouter.get("/eventos", (req: Request, res: Response) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  try {
    verificarToken(token);
  } catch {
    res.status(401).json({ erro: "Token inválido ou expirado" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");

  const enviar = (evento: Evento) => res.write(`data: ${JSON.stringify(evento)}\n\n`);
  // Comentário periódico para proxies não derrubarem a conexão ociosa.
  const pulso = setInterval(() => res.write(": ping\n\n"), 25_000);
  barramento.on("evento", enviar);

  req.on("close", () => {
    clearInterval(pulso);
    barramento.off("evento", enviar);
  });
});
