import { PrismaClient } from "@prisma/client";
import { comAuditoria } from "./auditoria/registrar.js";

/** Cliente sem auditoria: usado pela própria auditoria e onde não se quer trilha. */
export const prismaBase = new PrismaClient();

/** Cliente do sistema: cada criar/alterar/excluir feito por um usuário logado vai para a auditoria. */
export const prisma = comAuditoria(prismaBase);
