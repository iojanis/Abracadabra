# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Core Development Tasks
- `deno task dev` - Start development server with hot reload
- `deno task start` - Start production server
- `deno task build` - Compile to executable in dist/
- `deno task check` - Type check the codebase
- `deno task lint` - Lint source code
- `deno task fmt` - Format source code
- `deno task test` - Run tests

### Testing
- Tests are located in `tests/` directory
- Run individual test files with: `deno test --allow-all --unstable-kv tests/specific-test.ts`
- **Integration Tests**:
  - `tests/integration-simple.ts` - Core functionality validation (auth, documents, WebSocket)
  - `tests/integration-test.ts` - Comprehensive system test (full server-client validation)
- Unit tests: `password.test.ts`, `kv-factory.test.ts`
- Run integration tests: `deno test --allow-all --unstable-kv --no-check tests/integration-simple.ts`
- Note: Use `--no-check` flag for tests due to current TypeScript configuration issues

## Architecture Overview

### Core Application Structure
This is a **Deno-based collaborative document server** built with:
- **Framework**: Hono for HTTP routing and middleware
- **Real-time**: Hocuspocus (Yjs) for collaborative document editing
- **Storage**: Deno KV or PostgreSQL as KV backend
- **Auth**: Lucia auth with session management
- **Permissions**: CASL-based hierarchical permissions
- **APIs**: OpenAPI/Swagger documentation

### Key Services Architecture
The application follows a service-oriented architecture with these core services:

1. **ConfigService** (`src/services/config.ts`) - Environment and runtime configuration
2. **DocumentService** (`src/services/documents.ts`) - Hierarchical document management
3. **PermissionService** (`src/services/permissions.ts`) - CASL-based authorization with inheritance
4. **AuthService** (`src/auth.ts`) - User authentication and session management
5. **UploadsService** (`src/services/uploads.ts`) - File upload handling (local/S3)
6. **ScriptsService** (`src/services/scripts.ts`) - Server-side JavaScript execution

### Storage Layer
- **KV Factory** (`src/utils/kv-factory.ts`) - Abstracts Deno KV vs PostgreSQL storage
- **Provider Selection**: Set via `KV_PROVIDER` environment variable ("deno" or "postgres")
- **Deno KV Extension** (`src/extensions/deno-kv.ts`) - Custom Hocuspocus persistence

### Document Hierarchy & Permissions
- Documents use **path-based hierarchy** (e.g., `/team/project/doc`)
- **Permission inheritance**: Child documents inherit permissions from parents
- **Five permission levels**: NONE, VIEWER, COMMENTER, EDITOR, ADMIN, OWNER
- **Permission resolution**: Explicit permissions override inherited ones

### Real-time Collaboration
- **WebSocket endpoints**: `/collaborate`, `/collaborate/:documentId`, `/ws` (test)
- **Hocuspocus integration**: Handles Yjs document synchronization
- **Rate limiting**: Per-IP and per-document connection limits with circuit breaker
- **Custom extension**: DenoKvExtension for document state persistence

## Configuration

### Environment Setup
1. Copy `.env.example` to `.env`
2. **Required for development**: Set `KV_PROVIDER=deno` (default)
3. **For PostgreSQL**: Set `KV_PROVIDER=postgres` and `DATABASE_URL`
4. **JWT Secret**: Change `JWT_SECRET` for production

### Key Environment Variables
- `ABRACADABRA_PORT` - Server port (default: 8787)
- `KV_PROVIDER` - Storage backend ("deno" or "postgres")
- `DENO_KV_PATH` - Path for Deno KV database file
- `DATABASE_URL` - PostgreSQL connection string (if using postgres provider)
- `JWT_SECRET` - Secret for session tokens
- `MAX_FILE_SIZE` - Upload limit in bytes
- `LOG_LEVEL` - Logging verbosity (DEBUG, INFO, WARN, ERROR)

## Code Organization

### Route Structure
- `src/routes/auth.ts` - Authentication endpoints
- `src/routes/documents.ts` - Document CRUD operations
- `src/routes/uploads.ts` - File upload handling
- `src/routes/admin.ts` - Administrative functions
- `src/routes/docs.ts` - API documentation

### Middleware
- `src/middleware/session.ts` - Session management
- `src/middleware/auth.ts` - Authentication and authorization helpers

### Extensions & Utilities
- `src/extensions/websocket-polyfill.ts` - NodeJS WebSocket compatibility for Hocuspocus
- `src/utils/password.ts` - Pure JS password hashing (PBKDF2, Web Crypto API)
- `src/utils/environment.ts` - Environment detection and helpers

## Important Implementation Details

### Password Hashing
- Uses **pure JavaScript PBKDF2** implementation (no native dependencies)
- **Deno Deploy compatible** - no FFI or WASM required
- Migrates from argon2 on user login if legacy hashes detected

### WebSocket Collaboration
- **Rate limiting**: Strict limits to prevent abuse (3 connections per 30s per document)
- **Circuit breaker**: Disables WebSocket after excessive rate limit hits
- **Polyfill required**: Hocuspocus needs NodeJS-style WebSocket methods

### KV Storage Abstraction
- **Dual backend support**: Seamlessly switch between Deno KV and PostgreSQL
- **Factory pattern**: `createKvFromEnv()` returns appropriate implementation
- **Environment-based**: Configuration via `KV_PROVIDER` environment variable

## Testing & Quality

### Code Style
- **Deno fmt**: 2-space indentation, line width 100, double quotes
- **Strict TypeScript**: All type checking options enabled
- **ESLint equivalent**: Uses Deno's built-in linter

### Database Testing
- Use `docker-compose.test.yml` for test PostgreSQL database
- Test files include utilities for KV backend testing

## Deployment

### Docker
- `docker-compose up -d` for development
- `docker-compose --profile production up -d` for production with proxy
- See `docs/DEPLOYMENT.md` for comprehensive deployment guide

### Deno Deploy
- Configured for **Deno Deploy** compatibility
- Uses timeout protection for service initialization
- Environment-specific permission handling