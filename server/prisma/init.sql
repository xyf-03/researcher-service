-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "maxContainers" INTEGER NOT NULL DEFAULT 3,
    "oidcSubject" TEXT,
    "oidcIssuer" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "replacedByTokenId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "text_trace_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "traceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "containerName" TEXT,
    "sessionKey" TEXT,
    "runId" TEXT,
    "inputText" TEXT NOT NULL DEFAULT '',
    "outputText" TEXT NOT NULL DEFAULT '',
    "outputHash" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'success',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "text_trace_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "containers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "ownerId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tokenEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "homeDir" TEXT NOT NULL,
    "containerId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'creating',
    "image" TEXT NOT NULL,
    "leaseExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "containers_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "pairings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "containerId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL DEFAULT '',
    "publicKeyPem" TEXT NOT NULL DEFAULT '',
    "privateKeyPem" TEXT NOT NULL DEFAULT '',
    "privateKeyPemEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "deviceToken" TEXT NOT NULL DEFAULT '',
    "deviceTokenEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "scopesJson" TEXT NOT NULL DEFAULT '[]',
    "pairingRequestId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'unpaired',
    "attemptVersion" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "pairings_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "containers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "model_providers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "containerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "api" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKeyEnvId" TEXT NOT NULL,
    "authHeader" BOOLEAN NOT NULL DEFAULT true,
    "modelsJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "model_providers_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "containers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "figures" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "xml" TEXT,
    "png" BLOB,
    "evaluation" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "figures_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "generation_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "figureId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "generation_jobs_figureId_fkey" FOREIGN KEY ("figureId") REFERENCES "figures" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_oidcIssuer_oidcSubject_key" ON "users"("oidcIssuer", "oidcSubject");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "text_trace_logs_traceId_key" ON "text_trace_logs"("traceId");

-- CreateIndex
CREATE INDEX "text_trace_logs_userId_idx" ON "text_trace_logs"("userId");

-- CreateIndex
CREATE INDEX "text_trace_logs_ipAddress_idx" ON "text_trace_logs"("ipAddress");

-- CreateIndex
CREATE INDEX "text_trace_logs_createdAt_idx" ON "text_trace_logs"("createdAt");

-- CreateIndex
CREATE INDEX "text_trace_logs_status_idx" ON "text_trace_logs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "containers_name_key" ON "containers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "containers_port_key" ON "containers"("port");

-- CreateIndex
CREATE INDEX "containers_ownerId_idx" ON "containers"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "pairings_containerId_key" ON "pairings"("containerId");

-- CreateIndex
CREATE UNIQUE INDEX "model_providers_containerId_providerId_key" ON "model_providers"("containerId", "providerId");

-- CreateIndex
CREATE UNIQUE INDEX "figures_ownerId_idempotencyKey_key" ON "figures"("ownerId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "figures_ownerId_idx" ON "figures"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "generation_jobs_figureId_key" ON "generation_jobs"("figureId");

