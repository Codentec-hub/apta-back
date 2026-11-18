-- CreateEnum
CREATE TYPE "TipoTokenAcesso" AS ENUM ('CONVITE', 'REDEFINICAO');

-- AlterTable
ALTER TABLE "usuarios" ADD COLUMN     "convite_pendente" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "troca_obrigatoria" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "tokens_acesso" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "tipo" "TipoTokenAcesso" NOT NULL,
    "expira_em" TIMESTAMP(3) NOT NULL,
    "usado_em" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usuario_id" TEXT NOT NULL,

    CONSTRAINT "tokens_acesso_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tokens_acesso_token_hash_key" ON "tokens_acesso"("token_hash");

-- CreateIndex
CREATE INDEX "tokens_acesso_usuario_id_idx" ON "tokens_acesso"("usuario_id");

-- AddForeignKey
ALTER TABLE "tokens_acesso" ADD CONSTRAINT "tokens_acesso_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
