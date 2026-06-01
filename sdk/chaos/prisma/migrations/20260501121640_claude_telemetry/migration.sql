-- CreateTable
CREATE TABLE "ClaudeSession" (
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
    "errorCount" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "ClaudeEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tool" TEXT,
    "durationMs" INTEGER,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClaudeEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ClaudeSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ClaudeSession_sessionUuid_key" ON "ClaudeSession"("sessionUuid");

-- CreateIndex
CREATE INDEX "ClaudeSession_user_lastEventAt_idx" ON "ClaudeSession"("user", "lastEventAt");

-- CreateIndex
CREATE INDEX "ClaudeSession_lastEventAt_idx" ON "ClaudeSession"("lastEventAt");

-- CreateIndex
CREATE INDEX "ClaudeEvent_sessionId_ts_idx" ON "ClaudeEvent"("sessionId", "ts");
