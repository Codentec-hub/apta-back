-- AlterTable
ALTER TABLE "usuarios" ADD COLUMN     "foto_em" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "fotos_usuario" (
    "usuario_id" TEXT NOT NULL,
    "dados" BYTEA NOT NULL,
    "mime" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fotos_usuario_pkey" PRIMARY KEY ("usuario_id")
);

-- AddForeignKey
ALTER TABLE "fotos_usuario" ADD CONSTRAINT "fotos_usuario_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
