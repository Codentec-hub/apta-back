-- CreateTable
CREATE TABLE "configuracao_sieg" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "client_id" TEXT,
    "secret_key" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "configuracao_sieg_pkey" PRIMARY KEY ("id")
);
