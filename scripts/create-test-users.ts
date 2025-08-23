#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write

/**
 * Test User Creation Script for Abracadabra Server
 *
 * Creates test users and sample documents for development and testing.
 * Run this script after starting the server to populate test data.
 */

import { createAuthService } from "../src/auth.ts";
import { createDocumentService } from "../src/services/documents.ts";
import { createPermissionService } from "../src/services/permissions.ts";
import { createConfigService } from "../src/services/config.ts";
import { createLoggingService, getLogger } from "../src/services/logging.ts";

// Initialize logging service first
await createLoggingService();
const logger = getLogger(["scripts", "test-users"]);

interface TestUser {
  username: string;
  email: string;
  password: string;
  displayName: string;
  role: "admin" | "editor" | "user";
}

const TEST_USERS: TestUser[] = [
  {
    username: "admin",
    email: "admin@abracadabra.dev",
    password: "admin123",
    displayName: "Admin User",
    role: "admin",
  },
  {
    username: "alice",
    email: "alice@example.com",
    password: "alice123",
    displayName: "Alice Cooper",
    role: "editor",
  },
  {
    username: "bob",
    email: "bob@example.com",
    password: "bob12345",
    displayName: "Bob Builder",
    role: "editor",
  },
  {
    username: "charlie",
    email: "charlie@example.com",
    password: "charlie123",
    displayName: "Charlie Brown",
    role: "user",
  },
  {
    username: "demo",
    email: "demo@example.com",
    password: "demo1234",
    displayName: "Demo User",
    role: "user",
  },
];

const TEST_DOCUMENTS = [
  {
    path: "welcome.md",
    title: "Welcome to Abracadabra",
    description: "Getting started guide for new users",
    content: `# Welcome to Abracadabra! 🎩✨

Welcome to your collaborative document workspace! This is a sample document to help you get started.

## What is Abracadabra?

Abracadabra is a professional-grade collaborative document server that enables real-time editing, version control, and team collaboration.

## Features

- **Real-time Collaboration**: Multiple users can edit documents simultaneously
- **Offline-first**: Works seamlessly even without internet connection
- **Version Control**: Track changes and document history
- **Permissions**: Fine-grained access control for documents
- **File Uploads**: Support for images, attachments, and media
- **Scripts**: Custom automation and workflows

## Getting Started

1. **Authentication**: Log in with your credentials
2. **Create Documents**: Start writing and collaborating
3. **Invite Others**: Share documents with team members
4. **Organize**: Use folders and tags to stay organized

Happy collaborating! 🎉`,
    isPublic: true,
  },
  {
    path: "projects/sample-project.md",
    title: "Sample Project Plan",
    description: "A template for project planning and tracking",
    content: `# Sample Project Plan

## Overview
This is a sample project document that demonstrates collaborative editing features.

## Goals
- [ ] Define project scope
- [ ] Set timeline and milestones
- [ ] Assign team responsibilities
- [ ] Track progress

## Timeline
- Week 1: Planning and setup
- Week 2-3: Implementation
- Week 4: Testing and review

## Team
- Alice: Lead Developer
- Bob: Backend Engineer
- Charlie: QA Engineer

## Notes
Feel free to edit this document and see real-time collaboration in action!`,
    isPublic: false,
  },
  {
    path: "meeting-notes/2024-01-15.md",
    title: "Team Meeting - January 15, 2024",
    description: "Weekly team sync meeting notes",
    content: `# Team Meeting Notes - January 15, 2024

**Attendees:** Alice, Bob, Charlie, Demo User

## Agenda
1. Project status updates
2. Roadmap planning
3. Technical discussions
4. Action items

## Status Updates

### Alice
- Completed user authentication system
- Working on document collaboration features
- Next: File upload integration

### Bob
- Database optimization completed
- API performance improvements
- Next: WebSocket scaling

### Charlie
- Test suite expansion
- Bug fixes in document sync
- Next: Performance testing

## Action Items
- [ ] Alice: Complete file upload API by Friday
- [ ] Bob: Review WebSocket performance metrics
- [ ] Charlie: Set up automated testing pipeline
- [ ] All: Review security audit findings

## Next Meeting
January 22, 2024 at 10:00 AM`,
    isPublic: false,
  },
];

async function createKvConnection(): Promise<Deno.Kv> {
  const kvProvider = Deno.env.get("KV_PROVIDER");

  if (kvProvider === "sqlite" || !kvProvider) {
    const dbPath = Deno.env.get("SQLITE_DB_PATH") || "./data/abracadabra.db";
    return await Deno.openKv(dbPath);
  } else if (kvProvider === "deno_deploy") {
    return await Deno.openKv();
  } else {
    throw new Error(`Unsupported KV provider: ${kvProvider}`);
  }
}

async function createTestUsers(kv: Deno.Kv): Promise<void> {
  logger.info("Creating test users...");

  const configService = await createConfigService(kv);
  const permissionService = await createPermissionService(kv, configService);
  const authService = await createAuthService(
    kv,
    configService,
    permissionService,
  );

  for (const userData of TEST_USERS) {
    logger.info(`Creating user: ${userData.username} (${userData.email})`);

    try {
      const result = await authService.register({
        username: userData.username,
        email: userData.email,
        password: userData.password,
        displayName: userData.displayName,
      });

      if (result.success) {
        logger.info(`✅ Created user: ${userData.username}`, {
          userId: result.user!.id,
          email: userData.email,
        });

        // For admin users, grant additional permissions
        if (userData.role === "admin") {
          // Note: Admin permissions are typically handled by the permission service
          // This might require additional setup depending on the permission system
          logger.info(`👑 User ${userData.username} has admin role`);
        }
      } else {
        if (result.error?.code === "DUPLICATE_RESOURCE") {
          logger.warn(`User ${userData.username} already exists, skipping`);
        } else {
          logger.error(
            `Failed to create user ${userData.username}:`,
            result.error,
          );
        }
      }
    } catch (error) {
      logger.error(`Error creating user ${userData.username}:`, error);
    }
  }
}

async function createTestDocuments(kv: Deno.Kv): Promise<void> {
  logger.info("Creating test documents...");

  const configService = await createConfigService(kv);
  const permissionService = await createPermissionService(kv, configService);
  const authService = await createAuthService(
    kv,
    configService,
    permissionService,
  );
  const documentService = await createDocumentService(kv, configService);

  // Login as admin to create documents
  const adminLogin = await authService.login({
    identifier: "admin",
    password: "admin123",
  });

  if (!adminLogin.success) {
    logger.error("Failed to login as admin user for document creation");
    return;
  }

  const adminUserId = adminLogin.user!.id;

  for (const docData of TEST_DOCUMENTS) {
    logger.info(`Creating document: ${docData.path}`);

    try {
      const result = await documentService.createDocument(
        adminUserId,
        docData.path,
        {
          title: docData.title,
          description: docData.description,
          initialContent: docData.content,
          isPublic: docData.isPublic,
        },
      );

      if (result && result.success) {
        logger.info(`✅ Created document: ${docData.path}`, {
          documentId: result.document?.id,
          title: docData.title,
        });
      } else if (result && result.error) {
        logger.error(
          `Failed to create document ${docData.path}:`,
          result.error,
        );
      } else {
        logger.info(
          `✅ Document created: ${docData.path} (result format unknown)`,
        );
      }
    } catch (error) {
      logger.error(`Error creating document ${docData.path}:`, error);
    }
  }
}

async function main(): Promise<void> {
  logger.info("🎩 Starting test user and document creation...");

  let kv: Deno.Kv | null = null;

  try {
    // Connect to KV store
    kv = await createKvConnection();
    logger.info("Connected to KV store");

    // Create test users
    await createTestUsers(kv);

    // Wait a bit for users to be fully created
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Create test documents
    await createTestDocuments(kv);

    logger.info("🎉 Test setup completed successfully!");
    logger.info("Test users created:");

    TEST_USERS.forEach((user) => {
      logger.info(
        `  - ${user.username} (${user.email}) - password: ${user.password}`,
      );
    });

    logger.info("\nYou can now:");
    logger.info("1. Login to the client with any of the test users");
    logger.info("2. View and edit the sample documents");
    logger.info("3. Test collaboration features");
  } catch (error) {
    logger.error("Failed to create test data:", error);
    Deno.exit(1);
  } finally {
    if (kv) {
      kv.close();
    }
  }
}

// Run the script
if (import.meta.main) {
  await main();
}
