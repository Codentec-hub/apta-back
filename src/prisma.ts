import { PrismaClient } from "@prisma/client";
import { comAuditoria } from "./auditoria/registrar.js";
import { comGatilhos } from "./notificacoes/gatilhos.js";

/** Cliente sem auditoria nem gatilhos: usado por eles mesmos e onde não se quer trilha. */
export const prismaBase = new PrismaClient();

/**
 * Cliente do sistema: cada criar/alterar/excluir feito por um usuário logado
 * vai para a auditoria, e as mudanças que interessam a alguém viram notificação.
 */
export const prisma = comGatilhos(comAuditoria(prismaBase), prismaBase);
