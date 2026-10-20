-- CreateTable
CREATE TABLE "configuracao_gemini" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "api_key" TEXT,
    "modelo" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "configuracao_gemini_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "configuracao_evolution" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "url" TEXT,
    "api_key" TEXT,
    "instancia" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "configuracao_evolution_pkey" PRIMARY KEY ("id")
);
