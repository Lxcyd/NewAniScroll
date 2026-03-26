-- CreateTable
CREATE TABLE "RemovedMedia" (
    "id" TEXT NOT NULL,
    "aniId" TEXT,
    "additions" TEXT[],

    CONSTRAINT "RemovedMedia_pkey" PRIMARY KEY ("id")
);
