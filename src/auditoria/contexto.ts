// Quem está fazendo a requisição atual, para a auditoria. Preenchido pelo
// middleware `autenticar`; rotinas agendadas rodam sem contexto (e não são
// auditadas, para não encher a trilha com o que o sistema faz sozinho).
import { AsyncLocalStorage } from "node:async_hooks";

export interface ContextoAuditoria {
  usuarioId: string;
  usuarioNome: string | null;
  ip: string | null;
}

export const contextoAuditoria = new AsyncLocalStorage<ContextoAuditoria>();
export const contextoAtual = () => contextoAuditoria.getStore();
