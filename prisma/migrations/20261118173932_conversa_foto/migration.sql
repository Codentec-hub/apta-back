-- AlterTable
ALTER TABLE "conversas" ADD COLUMN     "foto_buscada_em" TIMESTAMP(3),
ADD COLUMN     "foto_em" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "fotos_conversa" (
    "conversa_id" TEXT NOT NULL,
    "dados" BYTEA NOT NULL,
    "mime" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fotos_conversa_pkey" PRIMARY KEY ("conversa_id")
);

-- AddForeignKey
ALTER TABLE "fotos_conversa" ADD CONSTRAINT "fotos_conversa_conversa_id_fkey" FOREIGN KEY ("conversa_id") REFERENCES "conversas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
