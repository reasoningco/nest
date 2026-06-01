-- CreateTable
CREATE TABLE "CodexSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionUuid" TEXT NOT NULL,
    "user" TEXT NOT NULL,
    "host" TEXT,
    "cwd" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastEventAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "toolUseCount" INTEGER NOT NULL DEFAULT 0,
    "promptCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "firstPrompt" TEXT
);

-- CreateTable
CREATE TABLE "CodexEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tool" TEXT,
    "durationMs" INTEGER,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CodexEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CodexSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CodexSession_sessionUuid_key" ON "CodexSession"("sessionUuid");

-- CreateIndex
CREATE INDEX "CodexSession_user_lastEventAt_idx" ON "CodexSession"("user", "lastEventAt");

-- CreateIndex
CREATE INDEX "CodexSession_lastEventAt_idx" ON "CodexSession"("lastEventAt");

-- CreateIndex
CREATE INDEX "CodexEvent_sessionId_ts_idx" ON "CodexEvent"("sessionId", "ts");
